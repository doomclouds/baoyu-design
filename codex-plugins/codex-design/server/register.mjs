import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import { OpenAIExtensions } from '@openai/mcp-extensions/server';
import { z } from 'zod/v4';
import { createLibraryStore } from '../library/index.mjs';
import { getWorkerStatus } from '../scripts/worker-client.mjs';
import { createDesignService } from './service.mjs';
import { ACTIONS, READ_ACTIONS, LIBRARY_UI_URI, FILE_UI_URI, UI_MIME_TYPE, PLUGIN_UI_VERSION } from './contract.mjs';

const readonly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true };
const appOnly = uri => ({ ui: { resourceUri: uri, visibility: ['app'] } });
const briefError = error => ({ code: error.code || 'DESIGN_LIBRARY_ERROR', message: String(error.message || error).slice(0, 2_000) });

export async function nativeActivity(record) {
  try {
    const status = await getWorkerStatus(record.path);
    return status.counts.active > 0 ? { busy: true, reason: 'An unfinished native design job is recorded for this artwork. Its parent must coordinate ownership before changing library content.' } : false;
  } catch {
    return { busy: true, reason: 'The artwork task state cannot be verified. Inspect that state before changing library content.' };
  }
}

function resultFor(value, action) {
  const content = [];
  if (value?.resource) content.push(value.resource);
  const detail = value?.text !== undefined ? value.text : Array.isArray(value)
    ? JSON.stringify({ action, count: value.length, items: value.slice(0, 25).map(item => ({ id: item.id, title: item.title, kind: item.kind })) })
    : JSON.stringify({ action, status: value?.status ?? 'ok', id: value?.id ?? value?.artifactId, readOnly: value?.readOnly });
  content.unshift({ type: 'text', text: String(detail ?? 'Done.') });
  return { content, structuredContent: { result: value } };
}

export async function createDesignServer({ store = createLibraryStore({ isBusy: nativeActivity }), html, resourceDiagnostics = true,
  htmlPath = new URL('../ui/index.html', import.meta.url), icons, editorOpen, pluginRoot, version = PLUGIN_UI_VERSION } = {}) {
  if (html === undefined) html = await readFile(htmlPath, 'utf8');
  const htmlSHA256 = resourceDiagnostics ? createHash('sha256').update(html, 'utf8').digest('hex') : null;
  if (icons === undefined) {
    const icon = await readFile(new URL('../assets/icon.png', import.meta.url));
    icons = [{ src: `data:image/png;base64,${icon.toString('base64')}`, mimeType: 'image/png', sizes: ['512x512'] }];
  }
  const server = new McpServer({ name: 'codex-design', title: 'codex design', version, icons });
  const extensions = new OpenAIExtensions(server);
  const service = createDesignService({ store, pluginRoot, editorOpen });
  const uiResource = uri => ({ uri, mimeType: UI_MIME_TYPE, text: html,
    _meta: { 'codex-design/uiVersion': PLUGIN_UI_VERSION, ui: { csp: {
      connectDomains: ['blob:', 'data:', 'https://fonts.googleapis.com', 'https://fonts.gstatic.com'],
      resourceDomains: ['blob:', 'data:', 'https://fonts.googleapis.com', 'https://fonts.gstatic.com', 'https://cdn.oaistatic.com', 'https://cdn.openai.com'],
      frameDomains: ['blob:', 'data:'], baseUriDomains: ['https://codex-design.invalid'],
    } },
      'openai/ui': { preferredDisplayMode: 'fullscreen', availableDisplayModes: ['fullscreen'] } } });
  for (const [name, uri] of [['design-library-ui', LIBRARY_UI_URI], ['design-file-ui', FILE_UI_URI]]) {
    server.registerResource(name, uri, { mimeType: UI_MIME_TYPE }, async () => {
      if (resourceDiagnostics) process.stderr.write(`${JSON.stringify({ event: 'codex_design_ui_resource_read', serverName: 'codex-design',
        pluginVersion: version, uiVersion: PLUGIN_UI_VERSION, resourceURI: uri, htmlSHA256 })}\n`);
      return { contents: [uiResource(uri)] };
    });
  }
  server.registerTool('DesignLibrary', {
    title: 'codex design', description: 'Open the full Codex Design workspace from global navigation.',
    inputSchema: z.object({}), annotations: readonly, icons,
    _meta: { ...appOnly(LIBRARY_UI_URI), 'openai/ui': { entrypoints: [{ type: 'global' }] } },
  }, async () => ({ content: [], structuredContent: await service.initialState() }));

  server.registerTool('DesignFile', {
    title: 'Codex Design artwork', description: 'Open a .codexdesign artwork descriptor through the host file viewer.',
    inputSchema: z.object({ file: z.object({ name: z.string().min(1), resourceUri: z.string().min(1) }) }),
    annotations: readonly, icons,
    _meta: { ...appOnly(FILE_UI_URI), 'openai/ui': { entrypoints: [{ type: 'file', extensions: ['.codexdesign'] }] } },
  }, async ({ file }) => ({ content: [], structuredContent: { ...await service.initialState(), entrypoint: 'file', file } }));

  for (const [name, actions, annotations] of [
    ['design_read', READ_ACTIONS, readonly],
    ['design_action', ACTIONS, { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: false }],
  ]) {
    server.registerTool(name, {
      title: name === 'design_read' ? 'Read design library' : 'Manage design library',
      description: 'Operate on the local design library. Chat output is a concise result or resource reference; the full UI stays in the global workspace or file tab. Reference routes are read-only. Native edit-chat sending is not available through this tool.',
      inputSchema: z.object({ action: z.enum(actions), payload: z.record(z.string(), z.unknown()).default({}) }),
      annotations, _meta: { ui: { visibility: name === 'design_action' ? ['app'] : ['app', 'model'] } },
    }, async ({ action, payload }) => {
      try { return resultFor(await service.invoke(action, payload), action); }
      catch (error) { const detail = briefError(error); return { isError: true, content: [{ type: 'text', text: JSON.stringify(detail) }], structuredContent: { error: detail } }; }
    });
  }
  extensions.mentions.setHandler(({ query }) => service.mentions(query));
  server.registerResource('design-reference', new ResourceTemplate('codex-design://artifacts/{id}/reference', { list: undefined }), {
    title: 'Read-only design reference', mimeType: 'application/json', description: 'Metadata and content-resource links; edit the source in its artwork tab.',
  }, async (uri, { id }) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await service.reference(id)) }] }));
  server.registerResource('design-content', new ResourceTemplate('codex-design://artifacts/{id}/files/{file}', { list: undefined }), {
    title: 'Read-only artwork content', description: 'Only artwork and material files; comments, chats, task state and runtime controls are excluded.',
  }, async (uri, { id, file }) => {
    let relative;
    try { relative = decodeURIComponent(file); }
    catch { throw Object.assign(new Error('Invalid encoded artwork content path.'), { code: 'INVALID_PATH' }); }
    let content;
    try { content = await service.readReferenceFile(id, relative); }
    catch (error) { if (error.code !== 'BINARY_ENCODING_REQUIRED') throw error; content = await service.readReferenceFile(id, relative, 'base64'); }
    return { contents: [{ uri: uri.href, mimeType: content.contentType,
      _meta: { 'codex-design/contentRevision': content.revision },
      ...(content.text === undefined ? { blob: content.data } : { text: content.text }) }] };
  });
  return server;
}
