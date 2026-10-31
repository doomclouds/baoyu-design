import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createDesignServer } from './register.mjs';

// stdout is exclusively MCP JSON-RPC. Diagnostics belong on stderr.
serveStdio(() => createDesignServer());
