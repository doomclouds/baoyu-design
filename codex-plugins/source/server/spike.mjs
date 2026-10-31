// Discovery-only probe. No library writes, chat creation, model processes, or messages.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { OpenAIExtensions } from '@openai/mcp-extensions/server';
import { z } from 'zod/v4';

export const LIBRARY_UI_URI = 'ui://codex-design/library';
export const FILE_UI_URI = 'ui://codex-design/file';
export const UI_MIME_TYPE = 'text/html;profile=mcp-app';
const readonly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true };

export async function createSpikeServer() {
  const icon = await readFile(new URL('../assets/icon.png', import.meta.url));
  const icons = [{ src: `data:image/png;base64,${icon.toString('base64')}`, mimeType: 'image/png', sizes: ['512x512'] }];
  const server = new McpServer({ name: 'codex-design-library-probe', title: 'codex design', version: '0.3.0-spike', icons });
  new OpenAIExtensions(server);
  const html = await readFile(new URL('./spike.html', import.meta.url), 'utf8');
  for (const [name, uri] of [['library', LIBRARY_UI_URI], ['file', FILE_UI_URI]]) {
    server.registerResource(name, uri, { mimeType: UI_MIME_TYPE }, async () => ({ contents: [{
      uri, mimeType: UI_MIME_TYPE, text: html,
      _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } },
        'openai/ui': { preferredDisplayMode: 'fullscreen', availableDisplayModes: ['fullscreen'] } },
    }] }));
  }
  server.registerTool('DesignLibrary', {
    title: 'codex design', description: 'Open the global Codex Design library. Discovery probe only.',
    inputSchema: z.object({}), annotations: readonly, icons,
    _meta: { ui: { resourceUri: LIBRARY_UI_URI, visibility: ['app'] }, 'openai/ui': { entrypoints: [{ type: 'global' }] } },
  }, async () => ({ content: [], structuredContent: { surface: 'global', probe: true, nativeEditConversation: 'not-established' } }));
  server.registerTool('DesignFile', {
    title: 'Codex Design file', description: 'Inspect the native .codexdesign file-handler container without creating a chat.',
    inputSchema: z.object({ file: z.object({ name: z.string().min(1), resourceUri: z.string().min(1) }) }),
    annotations: readonly, icons,
    _meta: { ui: { resourceUri: FILE_UI_URI, visibility: ['app'] },
      'openai/ui': { entrypoints: [{ type: 'file', extensions: ['.codexdesign'] }] } },
  }, async ({ file }) => ({ content: [], structuredContent: { surface: 'file', probe: true, file, nativeEditConversation: 'not-established' } }));
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) serveStdio(createSpikeServer);
