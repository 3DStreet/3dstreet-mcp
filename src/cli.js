#!/usr/bin/env node
/**
 * 3dstreet-mcp CLI entry.
 *
 * Speaks MCP over stdio and bridges to a 3DStreet tab over a localhost
 * WebSocket. Configured in Claude Desktop / Claude Code as:
 *
 *   {
 *     "mcpServers": {
 *       "3dstreet": { "command": "npx", "args": ["-y", "3dstreet-mcp"] }
 *     }
 *   }
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRelay, createStdioTransport } from './relay.js';

const HELP = `3dstreet-mcp — Model Context Protocol server for 3DStreet

Usage: 3dstreet-mcp [options]

Options:
  -p, --port <number>    WebSocket port (default 51735)
  -o, --origin <url>     Origin used for the printed auto-pair URL and
                         the MCP \`instructions\` hint (default
                         https://3dstreet.app — set to
                         http://localhost:3333 when running 3DStreet
                         from a local dev server)
  -h, --help             Show this help
  -v, --version          Print version and exit

Configure in Claude Desktop / Claude Code as an MCP server, e.g.

  {
    "mcpServers": {
      "3dstreet": { "command": "npx", "args": ["-y", "3dstreet-mcp"] }
    }
  }

On startup the relay prints an auto-pair URL like
https://3dstreet.app/#mcp — open it in a signed-in browser to pair the
tab with the relay automatically. (Custom ports become #mcp=PORT.) The
same URL is included in the MCP \`instructions\` field so any client's
LLM can proactively guide the user when no tab is paired yet.

For full design notes see https://github.com/3DStreet/3dstreet/issues/1582.
`;

function parseArgs(argv) {
  const out = { port: 51735, origin: undefined, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      out.help = true;
    } else if (a === '-v' || a === '--version') {
      out.version = true;
    } else if (a === '-p' || a === '--port') {
      const next = argv[++i];
      const n = parseInt(next, 10);
      if (!Number.isFinite(n) || n <= 0 || n >= 65536) {
        console.error(`Invalid --port value: ${next}`);
        process.exit(2);
      }
      out.port = n;
    } else if (a === '-o' || a === '--origin') {
      const next = argv[++i];
      try {
        const u = new URL(next);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          throw new Error('protocol must be http or https');
        }
        // Use just origin (scheme + host + port) for the pair URL
        // builder, dropping any path / query / hash the user supplied.
        out.origin = u.origin;
      } catch (err) {
        console.error(`Invalid --origin value: ${next} (${err.message})`);
        process.exit(2);
      }
    } else {
      console.error(`Unknown argument: ${a}`);
      console.error(HELP);
      process.exit(2);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  if (args.version) {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
    process.stdout.write(pkg.version + '\n');
    return;
  }

  const relay = createRelay({
    port: args.port,
    ...(args.origin ? { pairOrigin: args.origin } : {})
  });
  relay.attach(createStdioTransport());

  const shutdown = async () => {
    await relay.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[3dstreet-mcp] fatal:', err);
  process.exit(1);
});
