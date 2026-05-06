/**
 * 3dstreet-mcp relay.
 *
 * Speaks MCP (line-delimited JSON-RPC 2.0) over a transport — stdio in
 * production, a fake transport in tests — and bridges it to a 3DStreet
 * browser tab over a localhost WebSocket. The browser side dispatches
 * `tools/list` and `tools/call` against its own command registry; this
 * relay is a transparent forwarder that adds:
 *
 *   - protocol housekeeping the peer doesn't need to repeat
 *     (`initialize`, `ping`, notifications)
 *   - a tool-list cache so `tools/list` works during the brief window
 *     between Claude initializing and the user opening the tab
 *   - a single-peer policy with origin allowlist so the only browser tab
 *     that can drive the session is the user's own.
 *
 * No editor state or auth tokens cross this process. The relay is a
 * dumb pipe.
 */

import { WebSocketServer } from 'ws';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: '3dstreet-mcp', version: '0.1.0' };

const DEFAULT_ALLOWED_ORIGINS = [
  'https://3dstreet.app',
  'https://dev-3dstreet.web.app',
  'http://localhost:3333',
  'http://127.0.0.1:3333'
];

const DEFAULT_PORT = 51735;
const DEFAULT_PAIR_ORIGIN = 'https://3dstreet.app';

const PAIRED_ELSEWHERE_CODE = 4001;
// Grace period for tools/call frames that arrive before the browser tab
// pairs. Long enough for the user to read Claude's "open the tab" message
// and click Reconnect; short enough that a forgotten request times out.
const PEER_WAIT_MS = 30_000;

/**
 * Build the auto-pair URL. The 3DStreet app reads `#mcp` from the URL
 * fragment to open the AI Assistant pane and pair with the relay
 * automatically — equivalent to typing `/mcp` in the console. A custom
 * port is encoded as `#mcp=PORT`.
 */
export function buildPairUrl(port = DEFAULT_PORT, origin = DEFAULT_PAIR_ORIGIN) {
  const fragment = port === DEFAULT_PORT ? 'mcp' : `mcp=${port}`;
  return `${origin}/#${fragment}`;
}

/**
 * Build the MCP `instructions` string returned on `initialize`. Clients
 * may fold this into the LLM's system prompt — the goal is for the model
 * to proactively tell the user how to pair when no tab is connected,
 * rather than discovering it after a 30-second queue timeout.
 */
export function buildInstructions(pairUrl) {
  return [
    '3DStreet MCP relay. All scene tools are forwarded to a paired 3DStreet browser tab — without one, `tools/list` returns empty and any `tools/call` will fail with "No 3DStreet tab is paired" or "Timed out waiting for the 3DStreet tab".',
    '',
    'When that happens, instruct the user to open this URL in their browser to auto-pair the tab with this relay:',
    '',
    `    ${pairUrl}`,
    '',
    'Once the user confirms the tab paired (the AI Assistant pane in 3DStreet shows "MCP relay paired"), retry the tool call. The relay caches tool definitions across brief reconnects, so a once-paired user does not need re-instructing on transient drops.'
  ].join('\n');
}

/**
 * @typedef {object} Transport
 * @property {(frame: object) => void} writeFrame  Write a JSON-RPC frame outbound.
 * @property {(handler: (frame: object) => void | Promise<void>) => void} onFrame
 *   Register a handler invoked once per inbound frame (already JSON-parsed).
 * @property {(handler: () => void) => void} onClose
 * @property {() => void} close
 */

/**
 * Start the relay.
 *
 * @param {object} opts
 * @param {number} [opts.port=51735]            WebSocket port (127.0.0.1 only).
 * @param {string[]} [opts.allowedOrigins]      Override the WS Origin allowlist.
 * @param {(msg: string, ...args: unknown[]) => void} [opts.log]
 *   Logger; defaults to stderr so it never collides with stdout JSON-RPC.
 * @returns {{ attach: (t: Transport) => void, close: () => Promise<void>, port: number }}
 */
export function createRelay({
  port = DEFAULT_PORT,
  allowedOrigins = DEFAULT_ALLOWED_ORIGINS,
  pairOrigin = DEFAULT_PAIR_ORIGIN,
  log = (...args) => console.error('[3dstreet-mcp]', ...args)
} = {}) {
  const allowed = new Set(allowedOrigins);
  const pairUrl = buildPairUrl(port, pairOrigin);
  const instructions = buildInstructions(pairUrl);

  /** @type {import('ws').WebSocket | null} */
  let peer = null;
  let nextPeerFrameId = 1;
  /** @type {Map<number, (frame: object) => void>} pending WS calls awaiting reply */
  const peerPending = new Map();
  /** @type {object[]} MCP tools/call frames queued while no peer is connected */
  const callQueue = [];
  /** @type {object[]} cached tools list from peer; survives peer disconnects */
  let cachedTools = [];
  // Distinguishes "user never opened a tab" from "tab was paired, briefly
  // disconnected." The first case fast-fails tools/call so the user gets
  // an immediate URL-bearing error; the second keeps the 30s queue so a
  // reconnecting peer drains pending calls instead of erroring them out.
  let hasEverConnectedPeer = false;
  /** @type {Transport | null} */
  let transport = null;
  let closing = false;

  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port,
    verifyClient: (info, done) => {
      const origin = info.origin || info.req.headers.origin;
      // No origin header (e.g. node test client) is allowed for local use.
      if (!origin || allowed.has(origin)) {
        done(true);
        return;
      }
      log(`rejecting WebSocket origin: ${origin}`);
      done(false, 403, 'origin not allowed');
    }
  });

  wss.on('listening', () => {
    log(`listening on ws://127.0.0.1:${port}`);
    log(`open this URL to pair a 3DStreet tab: ${pairUrl}`);
  });

  wss.on('error', (err) => {
    log('WebSocket server error:', err.message);
  });

  wss.on('connection', (ws, req) => {
    if (peer) {
      log('rejecting second peer (paired-elsewhere)');
      ws.close(PAIRED_ELSEWHERE_CODE, 'paired-elsewhere');
      return;
    }
    peer = ws;
    hasEverConnectedPeer = true;
    log(`paired with ${req.headers.origin || 'unknown origin'}`);

    refreshToolsFromPeer().then(() => {
      // Tell the MCP client the tool list is ready to be re-fetched.
      transport?.writeFrame({
        jsonrpc: '2.0',
        method: 'notifications/tools/list_changed'
      });
    });

    // Drain any tools/call frames that arrived before the tab paired.
    while (callQueue.length) {
      const queued = callQueue.shift();
      forwardCall(queued);
    }

    ws.on('message', (data) => {
      let frame;
      try {
        frame = JSON.parse(data.toString());
      } catch (err) {
        log('dropping unparseable WS frame:', err.message);
        return;
      }
      handlePeerFrame(frame);
    });

    ws.on('close', (code, reason) => {
      if (peer === ws) peer = null;
      log(
        `peer closed (code=${code}${reason?.length ? ` reason=${reason.toString()}` : ''})`
      );
      // Fail any pending WS calls so the LLM gets an error instead of hanging.
      for (const [, cb] of peerPending) {
        cb({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32000, message: 'peer disconnected' }
        });
      }
      peerPending.clear();
    });
  });

  function handlePeerFrame(frame) {
    // A reply to a frame we forwarded: resolve the pending callback.
    if (frame.id != null && peerPending.has(frame.id)) {
      const cb = peerPending.get(frame.id);
      peerPending.delete(frame.id);
      cb(frame);
      return;
    }
    // Anything else (notifications, unsolicited replies): drop. The browser
    // side never originates calls today.
  }

  /**
   * Forward an MCP frame to the WS peer.
   *
   * @param {object} frame  JSON-RPC 2.0 frame; the relay rewrites the id so
   *   browser ids stay independent of MCP-client ids.
   * @param {(reply: object) => void} [callback]  Invoked with the peer reply,
   *   or a synthetic error if the peer is disconnected.
   */
  function forwardToPeer(frame, callback) {
    if (!peer || peer.readyState !== peer.OPEN) {
      callback?.({
        jsonrpc: '2.0',
        id: frame.id ?? null,
        error: { code: -32000, message: 'no browser peer connected' }
      });
      return;
    }
    const wsId = nextPeerFrameId++;
    const wsFrame = { ...frame, id: wsId };
    if (callback) peerPending.set(wsId, callback);
    peer.send(JSON.stringify(wsFrame));
  }

  function refreshToolsFromPeer() {
    return new Promise((resolve) => {
      forwardToPeer(
        { jsonrpc: '2.0', method: 'tools/list' },
        (reply) => {
          if (reply?.result?.tools) {
            cachedTools = reply.result.tools;
            log(`cached ${cachedTools.length} tools from peer`);
          }
          resolve();
        }
      );
    });
  }

  /**
   * Forward a deferred tools/call (queued while waiting for the peer).
   * Same shape as a fresh call but with the id we promised to the MCP client.
   */
  function forwardCall(frame) {
    forwardToPeer(
      {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: frame.params
      },
      (peerReply) => {
        const reply = peerReply.error
          ? {
              jsonrpc: '2.0',
              id: frame.id,
              error: peerReply.error
            }
          : { jsonrpc: '2.0', id: frame.id, result: peerReply.result };
        transport?.writeFrame(reply);
      }
    );
  }

  /**
   * Handle one inbound MCP frame.
   *
   * Returns a reply frame to send back, or `null` for notifications and
   * deferred handling (deferred frames write their own reply when the peer
   * answers).
   */
  async function handleMCPFrame(frame) {
    const { id, method, params } = frame;
    const isNotification = id === undefined || id === null;
    const reply = (result) => ({ jsonrpc: '2.0', id, result });
    const fail = (code, message) => ({
      jsonrpc: '2.0',
      id,
      error: { code, message }
    });

    switch (method) {
      case 'initialize':
        if (isNotification) return null;
        return reply({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: true } },
          serverInfo: SERVER_INFO,
          instructions
        });

      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;

      case 'ping':
        if (isNotification) return null;
        return reply({});

      case 'tools/list': {
        if (isNotification) return null;
        if (peer && peer.readyState === peer.OPEN) {
          await refreshToolsFromPeer();
        }
        return reply({ tools: cachedTools });
      }

      case 'tools/call': {
        if (isNotification) return null;
        if (!params || typeof params.name !== 'string') {
          return fail(-32602, 'tools/call requires params.name');
        }
        if (!peer || peer.readyState !== peer.OPEN) {
          if (!hasEverConnectedPeer) {
            // Fast-fail: no tab has ever paired this session — there's
            // no point queueing 30s, the user simply hasn't opened the
            // URL yet. Surface the auto-pair URL immediately so the LLM
            // can hand it to the user.
            return fail(
              -32000,
              `No 3DStreet tab is paired. Open ${pairUrl} to auto-pair, then try again.`
            );
          }
          // Tab was paired earlier and is presumably reconnecting. Defer
          // briefly so the queue drains when the peer reattaches.
          callQueue.push(frame);
          setTimeout(() => {
            const idx = callQueue.indexOf(frame);
            if (idx === -1) return;
            callQueue.splice(idx, 1);
            transport?.writeFrame({
              jsonrpc: '2.0',
              id: frame.id,
              error: {
                code: -32000,
                message: `Timed out waiting for the 3DStreet tab. Open ${pairUrl} to auto-pair, then try again.`
              }
            });
          }, PEER_WAIT_MS);
          return null;
        }
        return await new Promise((resolve) => {
          forwardToPeer(
            {
              jsonrpc: '2.0',
              method: 'tools/call',
              params: {
                name: params.name,
                arguments: params.arguments || {}
              }
            },
            (peerReply) => {
              if (peerReply.error) {
                resolve({
                  jsonrpc: '2.0',
                  id,
                  error: peerReply.error
                });
              } else {
                resolve(reply(peerReply.result));
              }
            }
          );
        });
      }

      default:
        if (isNotification) return null;
        return fail(-32601, `Method not found: ${method}`);
    }
  }

  function attach(t) {
    if (transport) throw new Error('transport already attached');
    transport = t;
    transport.onFrame(async (frame) => {
      const out = await handleMCPFrame(frame);
      if (out) transport.writeFrame(out);
    });
    transport.onClose(() => {
      if (!closing) close();
    });
  }

  async function close() {
    if (closing) return;
    closing = true;
    log('shutting down');
    if (peer) {
      try {
        peer.close(1000, 'relay-shutdown');
      } catch {
        // best-effort
      }
    }
    await new Promise((resolve) => wss.close(() => resolve()));
    transport?.close();
  }

  return { attach, close, port, pairUrl, instructions };
}

/**
 * Stdio transport for the MCP server. Reads line-delimited JSON-RPC frames
 * from stdin and writes them to stdout, one frame per line.
 */
export function createStdioTransport({ stdin = process.stdin, stdout = process.stdout } = {}) {
  const handlers = { frame: null, close: null };
  let buffer = '';
  stdin.setEncoding('utf8');
  stdin.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch (err) {
        // Print to stderr — stdout is reserved for JSON-RPC.
        console.error('[3dstreet-mcp] dropping unparseable stdin frame:', err.message);
        continue;
      }
      handlers.frame?.(frame);
    }
  });
  stdin.on('end', () => handlers.close?.());

  return {
    writeFrame(frame) {
      stdout.write(JSON.stringify(frame) + '\n');
    },
    onFrame(handler) {
      handlers.frame = handler;
    },
    onClose(handler) {
      handlers.close = handler;
    },
    close() {
      // stdin is owned by the parent; don't destroy it.
    }
  };
}
