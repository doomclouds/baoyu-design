import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BINDING_FILE, BridgeError, readJson, deliverComment, samePath } from './bridge-core.mjs';

export async function sendComment({ argv = process.argv.slice(2), env = process.env, input = process.stdin, runner } = {}) {
  if (argv.length !== 2 || argv[0] !== '--binding-token' || !argv[1]) throw new BridgeError('INVALID_BINDING', 'Expected --binding-token <token>.');
  if (!env.ARTIFACT_ROOT || !path.isAbsolute(env.ARTIFACT_ROOT)) throw new BridgeError('INVALID_BINDING', 'ARTIFACT_ROOT must identify the editor root.');
  const binding = readJson(path.join(env.ARTIFACT_ROOT, BINDING_FILE));
  if (!binding || binding.version !== 1 || binding.token !== argv[1] || !samePath(binding.root, env.ARTIFACT_ROOT)) {
    throw new BridgeError('INVALID_BINDING', 'This editor is no longer bound to that Codex chat. Reopen it from the intended chat.');
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of input) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 256 * 1024) throw new BridgeError('COMMENT_TOO_LARGE', 'Comment payload exceeds 256 KiB.');
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  let payload;
  try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new BridgeError('INVALID_COMMENT', 'Expected JSON on stdin.'); }
  return await deliverComment(binding, payload, { runner, env });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  sendComment().then((result) => process.stdout.write(`${JSON.stringify(result)}\n`), (error) => {
    process.stderr.write(`${JSON.stringify({ error: error.code ?? 'COMMENT_BRIDGE_FAILED', message: error.message })}\n`);
    process.exitCode = 1;
  });
}
