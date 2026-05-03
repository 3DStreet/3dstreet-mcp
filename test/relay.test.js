/**
 * End-to-end smoke test for the relay.
 *
 * Spins up a real relay on an ephemeral port, attaches an in-memory
 * transport in place of stdio, and connects a real WebSocket client
 * playing the part of the 3DStreet browser tab. Verifies the wire
 * protocol matches what PR #1600's browser dispatcher expects.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createRelay } from '../src/relay.js';

function makeMemTransport() {
  const inbox = []; // frames written by the relay (replies + notifications)
  const waiters = []; // resolvers waiting for the next frame
  let frameHandler = null;
  let closeHandler = null;

  const transport = {
    writeFrame(frame) {
      if (waiters.length) {
        waiters.shift()(frame);
      } else {
        inbox.push(frame);
      }
    },
    onFrame(h) {
      frameHandler = h;
    },
    onClose(h) {
      closeHandler = h;
    },
    close() {
      // no-op
    }
  };

  // Test-side helpers
  function sendFrame(frame) {
    return frameHandler(frame);
  }
  function nextFrame() {
    if (inbox.length) return Promise.resolve(inbox.shift());
    return new Promise((resolve) => waiters.push(resolve));
  }
  function endStdin() {
    closeHandler?.();
  }

  return { transport, sendFrame, nextFrame, endStdin };
}

async function getPort() {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function silentLog() {
  // Swallow logs so test output stays readable.
}

test('initialize → protocolVersion + serverInfo', async () => {
  const port = await getPort();
  const relay = createRelay({ port, log: silentLog });
  const mcp = makeMemTransport();
  relay.attach(mcp.transport);

  await mcp.sendFrame({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  const reply = await mcp.nextFrame();
  assert.equal(reply.id, 1);
  assert.equal(reply.result.protocolVersion, '2024-11-05');
  assert.equal(reply.result.serverInfo.name, '3dstreet-mcp');
  assert.deepEqual(reply.result.capabilities, {
    tools: { listChanged: true }
  });

  await relay.close();
});

test('ping replies empty result', async () => {
  const port = await getPort();
  const relay = createRelay({ port, log: silentLog });
  const mcp = makeMemTransport();
  relay.attach(mcp.transport);

  await mcp.sendFrame({ jsonrpc: '2.0', id: 9, method: 'ping' });
  const reply = await mcp.nextFrame();
  assert.deepEqual(reply, { jsonrpc: '2.0', id: 9, result: {} });

  await relay.close();
});

test('tools/list returns empty before peer connects', async () => {
  const port = await getPort();
  const relay = createRelay({ port, log: silentLog });
  const mcp = makeMemTransport();
  relay.attach(mcp.transport);

  await mcp.sendFrame({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const reply = await mcp.nextFrame();
  assert.deepEqual(reply.result, { tools: [] });

  await relay.close();
});

test('peer connects → list_changed notification, then tools/list returns cached tools', async () => {
  const port = await getPort();
  const relay = createRelay({ port, log: silentLog });
  const mcp = makeMemTransport();
  relay.attach(mcp.transport);

  // Browser-side fake: respond to tools/list with a small toolset.
  const fakeTools = [
    {
      name: 'getScene',
      description: 'fake',
      inputSchema: { type: 'object' }
    }
  ];
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
    origin: 'http://localhost:3333'
  });
  // Register the handler before awaiting open, so we don't race the relay's
  // initial tools/list frame.
  ws.on('message', (data) => {
    const frame = JSON.parse(data.toString());
    if (frame.method === 'tools/list') {
      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: frame.id,
          result: { tools: fakeTools }
        })
      );
    }
  });
  await once(ws, 'open');

  // First frame after pairing should be the list_changed notification.
  const note = await mcp.nextFrame();
  assert.equal(note.method, 'notifications/tools/list_changed');

  // Now ask for tools — should reflect what the peer reported.
  await mcp.sendFrame({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  const listReply = await mcp.nextFrame();
  assert.deepEqual(listReply.result.tools, fakeTools);

  ws.close();
  await once(ws, 'close');
  await relay.close();
});

test('tools/call forwards to peer and returns its result', async () => {
  const port = await getPort();
  const relay = createRelay({ port, log: silentLog });
  const mcp = makeMemTransport();
  relay.attach(mcp.transport);

  const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
    origin: 'http://localhost:3333'
  });
  ws.on('message', (data) => {
    const frame = JSON.parse(data.toString());
    if (frame.method === 'tools/list') {
      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: frame.id,
          result: { tools: [] }
        })
      );
    } else if (frame.method === 'tools/call') {
      assert.equal(frame.params.name, 'getScene');
      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: frame.id,
          result: { content: [{ type: 'text', text: '{"hello":"world"}' }] }
        })
      );
    }
  });
  await once(ws, 'open');

  // Drain the list_changed notification.
  await mcp.nextFrame();

  await mcp.sendFrame({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'getScene', arguments: {} }
  });
  const reply = await mcp.nextFrame();
  assert.equal(reply.id, 4);
  assert.deepEqual(reply.result, {
    content: [{ type: 'text', text: '{"hello":"world"}' }]
  });

  ws.close();
  await once(ws, 'close');
  await relay.close();
});

test('peer error replies are forwarded as JSON-RPC errors', async () => {
  const port = await getPort();
  const relay = createRelay({ port, log: silentLog });
  const mcp = makeMemTransport();
  relay.attach(mcp.transport);

  const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
    origin: 'http://localhost:3333'
  });
  ws.on('message', (data) => {
    const frame = JSON.parse(data.toString());
    if (frame.method === 'tools/list') {
      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: frame.id,
          result: { tools: [] }
        })
      );
    } else if (frame.method === 'tools/call') {
      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: frame.id,
          error: { code: -32000, message: 'Entity not found' }
        })
      );
    }
  });
  await once(ws, 'open');

  await mcp.nextFrame(); // list_changed

  await mcp.sendFrame({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'getEntity', arguments: { entityId: 'nope' } }
  });
  const reply = await mcp.nextFrame();
  assert.equal(reply.id, 5);
  assert.equal(reply.error.message, 'Entity not found');

  ws.close();
  await once(ws, 'close');
  await relay.close();
});

test('second peer is rejected with paired-elsewhere', async () => {
  const port = await getPort();
  const relay = createRelay({ port, log: silentLog });
  const mcp = makeMemTransport();
  relay.attach(mcp.transport);

  const ws1 = new WebSocket(`ws://127.0.0.1:${port}`, {
    origin: 'http://localhost:3333'
  });
  ws1.on('message', (data) => {
    const frame = JSON.parse(data.toString());
    if (frame.method === 'tools/list') {
      ws1.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: frame.id,
          result: { tools: [] }
        })
      );
    }
  });
  await once(ws1, 'open');
  await mcp.nextFrame(); // list_changed

  const ws2 = new WebSocket(`ws://127.0.0.1:${port}`, {
    origin: 'http://localhost:3333'
  });
  const [code, reason] = await once(ws2, 'close');
  assert.equal(code, 4001);
  assert.equal(reason.toString(), 'paired-elsewhere');

  ws1.close();
  await once(ws1, 'close');
  await relay.close();
});

test('disallowed origin is rejected', async () => {
  const port = await getPort();
  const relay = createRelay({ port, log: silentLog });
  const mcp = makeMemTransport();
  relay.attach(mcp.transport);

  const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
    origin: 'https://evil.example'
  });
  // The server should respond with a 403 during the upgrade.
  const err = await new Promise((resolve) => {
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode));
    ws.on('error', () => resolve('error'));
  });
  assert.ok(err === 403 || err === 'error');

  await relay.close();
});

test('unknown method returns -32601', async () => {
  const port = await getPort();
  const relay = createRelay({ port, log: silentLog });
  const mcp = makeMemTransport();
  relay.attach(mcp.transport);

  await mcp.sendFrame({
    jsonrpc: '2.0',
    id: 99,
    method: 'this/method/is/not/real'
  });
  const reply = await mcp.nextFrame();
  assert.equal(reply.error.code, -32601);

  await relay.close();
});
