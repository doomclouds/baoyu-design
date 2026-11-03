import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createFixture } from './fixtures.mjs';
import { createLibraryStore } from '../source/library/index.mjs';
import { createDesignService } from '../source/server/service.mjs';
import { dispatchEditRequest } from '../source/scripts/edit-request-dispatch.mjs';

const execFileAsync = promisify(execFile);
const pluginRoot = path.resolve(process.env.CODEX_DESIGN_TEST_PLUGIN_ROOT || fileURLToPath(new URL('../codex-design/', import.meta.url)));
const cliPath = (fixture) => path.join(pluginRoot, 'skills', fixture.skill, 'scripts', 'artifact.mjs');

// This helper deliberately exercises the canonical data-server API. Public
// wrapper navigation and its explicit open-service route have separate tests.
async function runCli(fixture, ...args) {
  const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath(fixture), ...args], {
    timeout: 20_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
    env: { ...process.env, CODEX_THREAD_ID: '', CODEX_DESIGN_THREAD_ID: '' },
  });
  try { return JSON.parse(stdout); }
  catch { throw new Error(`Expected CLI JSON, got ${stdout.slice(0, 1000)}; stderr ${stderr.slice(0, 1000)}`); }
}

async function fetchWithin(url, options) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(8_000) });
}

async function jsonRequest(url, options) {
  const response = await fetchWithin(url, options);
  const body = await response.json();
  assert.ok(response.ok, `${response.status}: ${JSON.stringify(body)}`);
  return body;
}

test('built package contains five complete editors, the director and dataviz skills', async () => {
  await access(path.join(pluginRoot, 'plugin.json')).catch(() => {
    throw new Error('Build the Codex plugin first: node codex-plugins/build.mjs');
  });
  for (const name of ['codex-slides', 'codex-design', 'codex-design-system', 'codex-dashboard', 'codex-motion', 'codex-motion-director', 'codex-dataviz']) {
    await access(path.join(pluginRoot, 'skills', name, 'SKILL.md'));
    if (!['codex-dataviz', 'codex-motion-director'].includes(name)) {
      await access(path.join(pluginRoot, 'skills', name, 'scripts', 'codex-artifact.mjs'));
      await access(path.join(pluginRoot, 'skills', name, 'scripts', 'editor', 'index.html'));
    }
  }
});

for (const kind of ['slides', 'design', 'design-system', 'dashboard', 'motion']) {
  test(`${kind}: real check, editor save, annotation routes, comments and stop`, { timeout: 45_000 }, async () => {
    const fixture = await createFixture(kind);
    let opened;
    try {
      const report = await runCli(fixture, 'check', fixture.root);
      assert.equal(report.problems, 0, JSON.stringify(report));
      opened = await runCli(fixture, 'open', fixture.root);
      assert.equal(new URL(opened.url).hostname, '127.0.0.1');
      const editor = await fetchWithin(opened.url);
      assert.equal(editor.status, 200);
      const html = await editor.text();
      assert.match(html, /__codex\/annotations\.js/);
      const script = await fetchWithin(new URL('__codex/annotations.js', opened.url));
      assert.equal(script.status, 200);
      assert.match(await script.text(), /annotation/);
      const context = await jsonRequest(new URL('__codex/annotation-context', opened.url));
      assert.equal(context.title, fixture.title, 'context must name the real project');
      assert.equal(context.skill, fixture.skill);
      assert.equal(context.projectRoot, fixture.root);
      assert.equal(context.indexFile, fixture.indexFile);
      assert.ok(context.objects.some((object) => object.file === fixture.contentFile), 'context must identify an actual editable source file');
      const editorSession = await jsonRequest(new URL('__codex/editor-session', opened.url));
      assert.equal(editorSession.root, fixture.root);
      assert.equal(editorSession.kind, fixture.kind);
      assert.equal(editorSession.pid, opened.pid);
      if (!['dashboard', 'motion'].includes(kind)) {
        const ungranted = await fetchWithin(new URL('/__codex/annotation-context', opened.url));
        assert.equal(ungranted.status, 404, 'annotation context must retain the editor grant boundary');
      }

      const origin = new URL(opened.url).origin;
      const headers = { 'Content-Type': 'application/json', Origin: origin };
      const crossOrigin = await fetchWithin(new URL('__comments', opened.url), {
        method: 'POST', headers: { ...headers, Origin: 'https://unrelated.invalid' },
        body: JSON.stringify({ ...fixture.comment, text: 'Must not be saved.', send: false }),
      });
      assert.equal(crossOrigin.status, 403, 'editor write routes must reject a different origin');
      const before = await readFile(path.join(fixture.root, fixture.contentFile), 'utf8');
      if (['dashboard', 'motion'].includes(kind)) {
        const content = JSON.parse(before);
        content.text = kind === 'dashboard'
          ? content.text.replace('Monthly revenue</p>', 'Verified monthly revenue</p>')
          : content.text.replace('Codex Design verification', 'Codex Design verified');
        await jsonRequest(new URL('_api/write', opened.url), { method: 'POST', headers, body: JSON.stringify({ op: 'set', path: kind === 'dashboard' ? 'files/index.html' : 'modules/scene-intro.js', data: content }) });
        assert.equal(JSON.parse(await readFile(path.join(fixture.root, fixture.contentFile), 'utf8')).text, content.text);
      } else {
        const updated = before.replace('Codex Design verification', 'Codex Design verified');
        const listing = await jsonRequest(new URL('_files.json', opened.url));
        await jsonRequest(new URL('__deck/publish', opened.url), {
          method: 'POST', headers,
          body: JSON.stringify({ files: { [fixture.contentFile]: { base64: Buffer.from(updated).toString('base64'), contentType: kind === 'design-system' ? 'text/markdown' : 'text/html', ifMatch: listing.files[fixture.contentFile].sha256 } } }),
        });
        assert.equal(await readFile(path.join(fixture.root, fixture.contentFile), 'utf8'), updated);
      }

      const created = await jsonRequest(new URL('__comments', opened.url), {
        method: 'POST', headers, body: JSON.stringify({ ...fixture.comment, text: 'Please revise this test heading.', send: false }),
      });
      const commentId = created.thread.id;
      const listed = await runCli(fixture, 'comments', fixture.root);
      assert.equal(listed.threads.length, 1);
      assert.equal(listed.threads[0].id, commentId);
      assert.equal(listed.threads[0].messages[0].text, 'Please revise this test heading.');
      await runCli(fixture, 'comment-reply', fixture.root, commentId, 'The test heading is revised.');
      await runCli(fixture, 'comment-resolve', fixture.root, commentId);
      const all = await runCli(fixture, 'comments', fixture.root, '--all');
      assert.equal(all.threads[0].status, 'resolved');
      assert.equal(all.threads[0].messages.at(-1).from, 'agent');
      const stored = JSON.parse(await readFile(path.join(fixture.root, 'comments.json'), 'utf8'));
      assert.equal(stored.threads[0].status, 'resolved');
      assert.equal(stored.threads[0].messages.at(-1).author.kind, 'agent');
      const finalCheck = await runCli(fixture, 'check', fixture.root);
      assert.equal(finalCheck.problems, 0, JSON.stringify(finalCheck));
      await runCli(fixture, 'stop', fixture.root);
      try {
        const stopped = await fetchWithin(opened.url);
        assert.equal(stopped.status, 404, 'the shared Hub must no longer mount this artwork');
        await stopped.arrayBuffer();
      } catch (error) {
        if (error instanceof assert.AssertionError) throw error;
        assert.equal(error.cause?.code, 'ECONNREFUSED', 'a stopped final Hub refuses the connection');
      }
      opened = undefined;
    } finally {
      if (opened) await runCli(fixture, 'stop', fixture.root).catch(() => {});
      // Only the mkdtemp directory created by this test is removed.
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
}

test('codex-dataviz: real validator accepts the reference palette and rejects indistinguishable colors', async () => {
  const validator = path.join(pluginRoot, 'skills', 'codex-dataviz', 'scripts', 'validate_palette.js');
  const palette = '#2a78d6,#eb6834,#1baf7a,#eda100,#e87ba4,#008300,#6250d6,#e34948';
  const good = await execFileAsync(process.execPath, [validator, palette, '--mode', 'light'], { timeout: 10_000, windowsHide: true });
  assert.ok(good.stdout.length > 0);
  await assert.rejects(execFileAsync(process.execPath, [validator, '#777777,#777777', '--mode', 'light'], { timeout: 10_000, windowsHide: true }), (error) => {
    assert.equal(error.code, 1);
    assert.match(`${error.stdout}\n${error.stderr}`, /FAIL/);
    return true;
  });
});

function storedZipEntry(bytes, name) {
  for (let offset = 0; offset + 30 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50;) {
    const flags = bytes.readUInt16LE(offset + 6), method = bytes.readUInt16LE(offset + 8);
    const size = bytes.readUInt32LE(offset + 18), nameLength = bytes.readUInt16LE(offset + 26), extraLength = bytes.readUInt16LE(offset + 28);
    assert.equal(flags & 8, 0, 'The uncompressed test export has known entry sizes.');
    const filename = bytes.toString('utf8', offset + 30, offset + 30 + nameLength);
    const start = offset + 30 + nameLength + extraLength;
    if (filename === name) {
      assert.equal(method, 0, 'Read the actual stored XML without a separate ZIP dependency.');
      return bytes.toString('utf8', start, start + size);
    }
    offset = start + size;
  }
  assert.fail(`The actual PPTX did not contain ${name}.`);
}

test('upstream CJK revision: actual compiler and PPTX XML retain Latin typefaces and choose regional East Asian fallbacks', async () => {
  const { runtime } = createRequire(import.meta.url)(path.join(pluginRoot, 'skills/codex-slides/scripts/editor/node/compiler.cjs'));
  runtime.initializeHtmlCompiler();
  runtime.initializePptxExport();
  const cases = [
    { text: '中文标题', family: 'Arial', eastAsian: 'Microsoft YaHei' },
    { text: '日本語の見出し', family: 'Arial', eastAsian: 'Yu Gothic' },
    { text: '한국어 제목', family: 'Arial', eastAsian: 'Malgun Gothic' },
    { text: '繁體中文', family: 'Noto Sans TC', eastAsian: 'Microsoft JhengHei' },
    { text: 'Latin heading', family: 'Arial', eastAsian: null },
  ];
  const slides = cases.map(({ text, family }, index) => {
    const result = runtime.compileSlideHtml(`<section id="cjk-${index}" style="background:#ffffff;font-family:Arial,sans-serif;padding:80px"><p style="font-size:40px">${text}</p></section>`);
    assert.deepEqual(result.errors, []);
    const node = result.content.slides[`cjk-${index}`].frames[0].node.children[0];
    assert.equal(node.text, text);
    // Fixed measured bounds isolate the exported font choice from browser layout.
    return { bg: '#ffffff', leaves: [{ kind: 'text', text: node.text, role: node.role, ...node.style,
      fontFamily: { family, fallback: 'sans' },
      rect: { x: 80, y: 80, w: 800, h: 120 }, color: '#172033' }] };
  });
  const { pptx } = runtime.buildPptxPresentation({ title: 'CJK fallback regression', slides });
  const bytes = Buffer.from(await pptx.write({ outputType: 'nodebuffer', compression: false }));
  for (const [index, expected] of cases.entries()) {
    const xml = storedZipEntry(bytes, `ppt/slides/slide${index + 1}.xml`);
    assert.ok(xml.includes(expected.text));
    assert.ok(xml.includes(`<a:latin typeface="${expected.family}"`));
    if (expected.eastAsian) assert.ok(xml.includes(`<a:ea typeface="${expected.eastAsian}"`));
    else assert.ok(xml.includes(`<a:ea typeface="${expected.family}"`), 'Latin-only text retains the ordinary export font.');
  }
  const googleSlides = runtime.buildPptxPresentation({ title: 'Google Slides retains its font path', slides }, { forGoogleSlides: true });
  const googleBytes = Buffer.from(await googleSlides.pptx.write({ outputType: 'nodebuffer', compression: false }));
  const googleXml = storedZipEntry(googleBytes, 'ppt/slides/slide1.xml');
  assert.ok(googleXml.includes('<a:ea typeface="Arial"'));
  assert.doesNotMatch(googleXml, /Microsoft YaHei|Yu Gothic|Malgun Gothic/);
});

test('legacy hook delivery is rejected before starting a service or launching a Codex process', async () => {
  const fixture = await createFixture('slides');
  const wrapper = path.join(pluginRoot, 'skills', fixture.skill, 'scripts', 'codex-artifact.mjs');
  const threadId = '11111111-2222-4333-8444-555555555555';
  try {
    for (const [delivery, code] of [['main', 'LEGACY_DELIVERY_UNAVAILABLE'], ['unknown', 'INVALID_DELIVERY_MODE']]) {
      await assert.rejects(execFileAsync(process.execPath, [wrapper, 'open-service', fixture.root, '--delivery', delivery, '--thread', threadId], {
        env: { ...process.env, CODEX_THREAD_ID: '', CODEX_DESIGN_THREAD_ID: '' }, timeout: 10_000, windowsHide: true,
      }), error => {
        assert.equal(error.code, 2);
        assert.equal(JSON.parse(error.stderr).error, code);
        return true;
      });
    }
    await assert.rejects(access(path.join(fixture.root, '.artifact-server.json')), { code: 'ENOENT' });
    await assert.rejects(access(path.join(fixture.root, '.codex-design-bridge.json')), { code: 'ENOENT' });
    await assert.rejects(access(path.join(fixture.root, '.codex-design-worker-jobs.json')), { code: 'ENOENT' });
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

// The test controller supplies distinct native identities to the actual CLI.
// This simulates platform lifecycle decisions, not platform-spawn verification.
async function boundNativeFixture() {
  const source = await createFixture('slides');
  const store = createLibraryStore({ root: path.join(source.root, 'library') });
  const artwork = await store.importArtifact({ sourcePath: source.root });
  const fixture = { ...source, root: artwork.path };
  const wrapper = path.join(pluginRoot, 'skills', fixture.skill, 'scripts', 'codex-artifact.mjs');
  const trace = path.join(fixture.root, 'forbidden-codex-launches.jsonl');
  const fake = path.join(fixture.root, 'forbidden codex.mjs');
  const originThreadId = '11111111-2222-4333-8444-555555555555';
  const workerThreadId = '22222222-3333-4444-8555-666666666666';
  const env = { ...process.env, CODEX_DESIGN_THREAD_ID: '', FORBIDDEN_CODEX_TRACE: trace };
  await writeFile(fake, "import fs from 'node:fs'; fs.appendFileSync(process.env.FORBIDDEN_CODEX_TRACE, JSON.stringify({args:process.argv.slice(2)})+'\\n'); process.stderr.write('Native delivery must not launch Codex or queue the parent chat.'); process.exit(91);\n");
  const execute = async (threadId, args, input = '') => {
    const pending = execFileAsync(process.execPath, [wrapper, ...args], {
      env: { ...env, CODEX_THREAD_ID: threadId },
      timeout: 15_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
    });
    pending.child.stdin.on('error', () => {});
    pending.child.stdin.end(input);
    const result = await pending;
    return JSON.parse(result.stdout);
  };
  const parent = (...args) => execute(originThreadId, args);
  const worker = (...args) => execute(workerThreadId, args);
  const calls = async () => {
    try { return (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  let opened;
  try { opened = await parent('open-service', fixture.root, '--codex-path', fake); }
  catch (error) { await rm(source.root, { recursive: true, force: true }); throw error; }
  const service = createDesignService({ store, pluginRoot, editorOpen: async () => ({ ...opened, kind: 'slides' }) });
  const request = async (route, method, data) => {
    const response = await service.invoke('editor.request', { id: artwork.id, request: { path: route, method,
      headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(data)).toString('base64') } });
    const value = JSON.parse(Buffer.from(response.body, 'base64').toString('utf8'));
    assert.ok(response.status >= 200 && response.status < 300, JSON.stringify(value));
    return { ...value, ...(response.nativeDraft ? { nativeDraft: response.nativeDraft } : {}) };
  };
  return {
    ...fixture, opened, originThreadId, workerThreadId, parent, worker, calls,
    status: () => parent('worker-status', fixture.root),
    register: () => worker('worker-register', fixture.root, '--name', 'runtime-native-worker'),
    next: () => worker('worker-next', fixture.root, '--timeout', '0'),
    complete: (jobId, input) => execute(workerThreadId, ['worker-complete', fixture.root, jobId, '-'], input),
    comment: (text, send = true) => request('__comments', 'POST', { ...fixture.comment, text, send }),
    revise: (commentId, messageId, text) => request('__comments/' + commentId + '/messages/' + messageId, 'PATCH', { text, send: true }),
    acceptDraft: async draft => {
      assert.ok(draft?.requestId, 'A user-sent request must identify its immutable native draft.');
      await service.invoke('request.draftAdded', { requestId: draft.requestId });
      const result = await service.operateEditRequests('accept', [draft.requestId]);
      assert.equal(result.errors.length, 0);
      return dispatchEditRequest(path.join(pluginRoot, 'skills/codex-slides'), fixture.root, draft.requestId, {
        env: { ...env, CODEX_THREAD_ID: originThreadId }, store,
      });
    },
    close: async () => {
      try {
        await parent('stop', fixture.root);
        assert.deepEqual(await calls(), [], 'native delivery must never launch an external Codex process');
      } finally {
        await rm(source.root, { recursive: true, force: true });
      }
    },
  };
}

async function waitForWorker(predicate, message) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 35));
  }
  assert.fail(message);
}

async function pendingNativeJob(fixture, commentId) {
  return waitForWorker(async () => {
    const status = await fixture.status();
    return status.jobs.find((job) => job.commentId === commentId && job.status === 'pending');
  }, 'the accepted native draft did not persist its dispatched job');
}

test('accepted native drafts: durable jobs are claimed serially by the registered child and replied to automatically', { timeout: 45_000 }, async () => {
  const fixture = await boundNativeFixture();
  try {
    const initial = await fixture.status();
    assert.equal(initial.mode, 'native');
    assert.equal(initial.status, 'unregistered');
    assert.equal(initial.nativeThreadId, null);
    assert.equal(initial.jobs.length, 0);
    const binding = JSON.parse(await readFile(path.join(fixture.root, '.codex-design-bridge.json'), 'utf8'));
    assert.equal(binding.deliveryMode, 'native');
    await fixture.comment('Save this ordinary comment without sending it.', false);
    assert.equal((await fixture.status()).jobs.length, 0);
    assert.deepEqual(await fixture.calls(), []);

    const first = await fixture.comment('First native design request.');
    assert.equal((await fixture.status()).jobs.length, 0, 'Add to chat prepares a draft without queueing work.');
    await fixture.acceptDraft(first.nativeDraft);
    const firstJob = await pendingNativeJob(fixture, first.thread.id);
    const unclaimed = await fixture.status();
    assert.equal(unclaimed.counts.pending, 1);
    assert.equal(unclaimed.counts.active, 0);
    assert.equal(unclaimed.nativeThreadId, null, 'the editor must not spawn or register a child');
    assert.equal(unclaimed.needsResume, true);
    assert.deepEqual(await fixture.calls(), [], 'Explicit receipt and dispatch persist work without launching a model or queue command.');

    await assert.rejects(fixture.parent('worker-register', fixture.root), (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /PARENT_CANNOT_REGISTER/);
      return true;
    });
    const registered = await fixture.register();
    assert.equal(registered.registered, true);
    assert.equal(registered.reused, false);
    assert.equal(registered.nativeThreadId, fixture.workerThreadId);
    const reused = await fixture.register();
    assert.equal(reused.reused, true, 'the controller reuses the same native child');
    assert.equal(reused.nativeThreadId, fixture.workerThreadId);
    await assert.rejects(fixture.parent('worker-next', fixture.root, '--timeout', '0'), (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /WRONG_NATIVE_WORKER/);
      return true;
    });

    const claimed = await fixture.next();
    assert.equal(claimed.closed, false);
    assert.equal(claimed.job.id, firstJob.id);
    assert.equal(claimed.job.ownerThreadId, fixture.workerThreadId);
    assert.equal(claimed.job.status, 'active');
    assert.equal(claimed.resumed, false);
    assert.match(claimed.request, /Read the installed skill/);
    assert.ok(claimed.request.includes(JSON.stringify(path.join(fixture.skill, 'SKILL.md')).slice(1, -1)));
    assert.match(claimed.request, /Do not wait for your own worker-status active entry/);
    assert.equal(claimed.event.data.id, first.thread.id);

    const second = await fixture.comment('Second native design request.');
    await fixture.acceptDraft(second.nativeDraft);
    const secondJob = await pendingNativeJob(fixture, second.thread.id);
    const serial = await fixture.status();
    assert.equal(serial.counts.active, 1);
    assert.equal(serial.counts.pending, 1);
    const resumed = await fixture.next();
    assert.equal(resumed.job.id, firstJob.id, 'an unfinished job is resumed before any later job');
    assert.equal(resumed.resumed, true);
    const firstReply = 'The registered native worker processed request one.';
    assert.equal((await fixture.complete(firstJob.id, firstReply)).status, 'completed');
    const duplicate = await fixture.complete(firstJob.id, firstReply);
    assert.equal(duplicate.completed, true);
    assert.equal(duplicate.duplicate, true);

    const claimedSecond = await fixture.next();
    assert.equal(claimedSecond.job.id, secondJob.id);
    assert.equal(claimedSecond.job.ownerThreadId, fixture.workerThreadId);
    const secondReply = 'The same native worker processed request two.';
    assert.equal((await fixture.complete(secondJob.id, secondReply)).status, 'completed');
    const completed = await fixture.status();
    assert.equal(completed.counts.completed, 2);
    assert.equal(completed.counts.failed, 0);
    assert.equal(completed.counts.active, 0);
    assert.equal(completed.nativeThreadId, fixture.workerThreadId);
    const stored = JSON.parse(await readFile(path.join(fixture.root, 'comments.json'), 'utf8'));
    for (const [id, text] of [[first.thread.id, firstReply], [second.thread.id, secondReply]]) {
      const replies = stored.threads.find((entry) => entry.id === id).messages.filter((message) => message.author.kind === 'agent');
      assert.equal(replies.length, 1, 'completion automatically posts one reply to the original comment');
      assert.equal(replies[0].text, text);
    }

    const waiting = fixture.worker('worker-next', fixture.root, '--timeout', '2');
    await waitForWorker(async () => (await fixture.status()).listening, 'the native CLI never advertised its local long wait');
    const timedOut = await waiting;
    assert.deepEqual(timedOut, { closed: false, timedOut: true });
    assert.equal((await fixture.next()).timedOut, true, 'a timed-out child can keep listening');
    const paused = await fixture.parent('worker-stop', fixture.root);
    assert.equal(paused.paused, true);
    assert.equal(paused.interruptRequired, false);
    assert.equal((await fixture.next()).closed, true);
    assert.deepEqual(await fixture.calls(), []);
  } finally { await fixture.close(); }
});

test('accepted native drafts: failed completions remain failed and receive an honest original-comment reply', { timeout: 35_000 }, async () => {
  const fixture = await boundNativeFixture();
  try {
    await fixture.register();
    const created = await fixture.comment('This controlled native edit intentionally fails.');
    await fixture.acceptDraft(created.nativeDraft);
    const pending = await pendingNativeJob(fixture, created.thread.id);
    assert.equal((await fixture.next()).job.id, pending.id);
    const text = '未完成：intentional native edit failure; no changes were reported as complete.';
    let result;
    await assert.rejects(fixture.complete(pending.id, JSON.stringify({
      text, status: 'failed', error: { code: 'FAKE_EDIT_FAILED', message: 'intentional native edit failure' },
    })), (error) => {
      assert.equal(error.code, 1);
      result = JSON.parse(error.stdout);
      return true;
    });
    assert.equal(result.completed, false);
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'FAKE_EDIT_FAILED');
    const failed = await fixture.status();
    assert.equal(failed.counts.failed, 1);
    assert.equal(failed.counts.completed, 0);
    assert.match(failed.jobs[0].error.message, /intentional native edit failure/);
    assert.equal((await fixture.next()).timedOut, true);
    assert.equal((await fixture.status()).jobs[0].status, 'failed', 'an automatic failure reply must not heal a failed job into completed');
    const stored = JSON.parse(await readFile(path.join(fixture.root, 'comments.json'), 'utf8'));
    const thread = stored.threads.find((entry) => entry.id === created.thread.id);
    assert.equal(thread.status, 'open');
    assert.equal(thread.messages.at(-1).author.kind, 'agent');
    assert.equal(thread.messages.at(-1).text, text);
    assert.deepEqual(await fixture.calls(), []);
  } finally { await fixture.close(); }
});

test('accepted native drafts: revision B supersedes the active revision A and receives the only reply', { timeout: 40_000 }, async () => {
  const fixture = await boundNativeFixture();
  try {
    await fixture.register();
    const firstText = 'Native revision A: use Draft A.';
    const secondText = 'Native revision B: use Final B.';
    const created = await fixture.comment(firstText);
    await fixture.acceptDraft(created.nativeDraft);
    const firstJob = await pendingNativeJob(fixture, created.thread.id);
    const firstClaim = await fixture.next();
    assert.equal(firstClaim.job.id, firstJob.id);
    assert.ok(firstClaim.request.includes(firstText));
    const revised = await fixture.revise(created.thread.id, created.thread.messages[0].id, secondText);
    await fixture.acceptDraft(revised.nativeDraft);
    const secondJob = await pendingNativeJob(fixture, created.thread.id);
    assert.notEqual(secondJob.id, firstJob.id);
    const stale = await fixture.complete(firstJob.id, 'Stale reply for revision A must not be posted.');
    assert.equal(stale.completed, false);
    assert.equal(stale.status, 'superseded');
    const secondClaim = await fixture.next();
    assert.equal(secondClaim.job.id, secondJob.id);
    assert.ok(secondClaim.request.includes(secondText));
    assert.ok(!secondClaim.request.includes(firstText));
    const reply = 'The registered native worker completed revision B.';
    assert.equal((await fixture.complete(secondJob.id, reply)).status, 'completed');
    const finished = await fixture.status();
    assert.equal(finished.counts.superseded, 1);
    assert.equal(finished.counts.completed, 1);
    assert.equal(finished.counts.failed, 0);
    assert.equal(finished.nativeThreadId, fixture.workerThreadId);
    const stored = JSON.parse(await readFile(path.join(fixture.root, 'comments.json'), 'utf8'));
    const thread = stored.threads.find((entry) => entry.id === created.thread.id);
    const replies = thread.messages.filter((message) => message.author.kind === 'agent');
    assert.equal(thread.messages[0].text, secondText);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].text, reply);
    assert.deepEqual(await fixture.calls(), []);
  } finally { await fixture.close(); }
});
