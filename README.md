# 3dstreet-mcp

A [Model Context Protocol][mcp] server that lets [Claude Desktop][cd] or
[Claude Code][cc] drive a [3DStreet][3ds] scene running in your browser.

Status: **alpha** — protocol may change. Tracks
[3DStreet#1582][issue] (design) and
[3DStreet#1600][pr] (browser side).

## How it works

```
Claude Desktop  ── stdio MCP ──▶  3dstreet-mcp  ── ws://127.0.0.1:51735 ──▶  3DStreet tab
or Claude Code                    (this package)                              (your browser)
```

The relay speaks MCP over stdio and bridges every `tools/list` and
`tools/call` to a 3DStreet tab over a localhost WebSocket. The tab does
the actual work — it's already signed in, has the catalog loaded, owns
the cloud-save flow. The relay is a dumb pipe.

No auth tokens cross the WebSocket. The relay's port binds to `127.0.0.1`
only and rejects WebSocket upgrades from origins outside the 3DStreet
allowlist (`https://3dstreet.app`, `https://dev-3dstreet.web.app`,
`http://localhost:3333`, `http://127.0.0.1:3333`).

## Setup

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) or `%APPDATA%/Claude/claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "3dstreet": {
      "command": "npx",
      "args": ["-y", "3dstreet-mcp"]
    }
  }
}
```

Restart Claude Desktop.

### Claude Code

```bash
claude mcp add 3dstreet -- npx -y 3dstreet-mcp
```

### Pair the browser tab

1. Open <https://3dstreet.app> and sign in.
2. Open the editor and click the **AI Assistant** tab in the right panel.
3. Type `/mcp` and hit enter — the status bar appears.
4. Click **Reconnect** if it's not already green.

You can now ask Claude things like:

- "What's in my current scene?"
- "Add a bike lane on the left side of the street."
- "Change the environment preset to night."

Toggle **Read-only** in the status bar to block scene mutations
(useful when you just want Claude to explain a scene).

## CLI

```
3dstreet-mcp [options]

Options:
  -p, --port <number>    WebSocket port (default 51735)
  -h, --help             Show this help
  -v, --version          Print version and exit
```

If you need a different port (e.g. running two Claude clients against
two different tabs), set `--port` and open the tab with
`https://3dstreet.app/?mcp=PORT`.

## Tools exposed

The tool list is fetched from the connected browser tab on pair, so it
always matches whatever the editor's command registry exposes. As of
[#1600][pr] that includes:

- **Reads:** `getScene`, `getEntity`, `getSelectedEntity`,
  `getManagedStreet`, `listMixins`, `getSessionInfo`
- **Selection / camera:** `selectEntity`, `focusCamera`
- **Mutations:** `entityCreate`, `entityUpdate`, `entityRemove`,
  `entityClone`, `entityReparent`, `componentAdd`, `componentRemove`,
  `segmentAdd`, `segmentUpdate`, `segmentRemove`, `replaceManagedStreet`,
  …and the rest of the registry
- **History:** `undo`, `redo`

Run `tools/list` from your MCP client to see the current set.

## Wire protocol (for contributors)

Stdio side: line-delimited JSON-RPC 2.0, MCP `2024-11-05`.

WebSocket side: same JSON-RPC envelope, with the relay handling
`initialize` / `ping` / notifications locally and forwarding only
`tools/list` and `tools/call` to the peer. The peer assigns its own ids
on incoming frames; replies match by id.

The single-peer policy: first browser tab to connect holds the slot.
Second connection gets WebSocket close code `4001` with reason
`paired-elsewhere`.

## Development

```bash
git clone https://github.com/3DStreet/3dstreet-mcp.git
cd 3dstreet-mcp
npm install
npm test
```

Smoke-test against a real 3DStreet build:

```bash
# Terminal 1 — the relay, REPL-free, just stdio
node src/cli.js

# Terminal 2 — exercise it with the MCP inspector
npx @modelcontextprotocol/inspector node src/cli.js
```

## License

AGPL-3.0-or-later, matching 3DStreet itself.

[mcp]: https://modelcontextprotocol.io
[cd]: https://claude.ai/download
[cc]: https://docs.claude.com/en/docs/claude-code
[3ds]: https://3dstreet.app
[issue]: https://github.com/3DStreet/3dstreet/issues/1582
[pr]: https://github.com/3DStreet/3dstreet/pull/1600
