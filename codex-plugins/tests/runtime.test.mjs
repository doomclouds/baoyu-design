import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createFixture } from './fixtures.mjs';

const execFileAsync = promisify(execFile);
const pluginRoot = path.resolve(process.env.CODEX_DESIGN_TEST_PLUGIN_ROOT || fileURLToPath(new URL('../codex-design/', import.meta.url)));
const cliPath = (fixture) => path.join(pluginRoot, 'skills', fixture.skill, 'scripts', 'artifact.mjs');

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

test('built package contains all five complete skills', async () => {
  await access(path.join(pluginRoot, 'plugin.json')).catch(() => {
    throw new Error('Build the Codex plugin first: node codex-plugins/build.mjs');
  });
  for (const name of ['codex-slides', 'codex-design', 'codex-design-system', 'codex-dashboard', 'codex-dataviz']) {
    await access(path.join(pluginRoot, 'skills', name, 'SKILL.md'));
    if (name !== 'codex-dataviz') {
      await access(path.join(pluginRoot, 'skills', name, 'scripts', 'codex-artifact.mjs'));
      await access(path.join(pluginRoot, 'skills', name, 'scripts', 'editor', 'index.html'));
    }
  }
});

for (const kind of ['slides', 'design', 'design-system', 'dashboard']) {
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
      if (kind !== 'dashboard') {
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
      if (kind === 'dashboard') {
        const content = JSON.parse(before);
        content.text = content.text.replace('Monthly revenue</p>', 'Verified monthly revenue</p>');
        await jsonRequest(new URL('_api/write', opened.url), { method: 'POST', headers, body: JSON.stringify({ op: 'set', path: 'files/index.html', data: content }) });
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
      await assert.rejects(fetchWithin(opened.url));
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

test('wrapper: real editor hook delivers to the bound chat and refuses a silent chat switch', { timeout: 30_000 }, async () => {
  const fixture = await createFixture('slides');
  const wrapper = path.join(pluginRoot, 'skills', fixture.skill, 'scripts', 'codex-artifact.mjs');
  const trace = path.join(fixture.root, 'fake-queue-trace.jsonl');
  const fake = path.join(fixture.root, 'fake codex.mjs');
  const threadId = '11111111-2222-4333-8444-555555555555';
  const otherThread = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const env = { ...process.env, CODEX_THREAD_ID: '', FAKE_TRACE: trace };
  const runWrapper = async (...args) => execFileAsync(process.execPath, [wrapper, ...args], {
    env, timeout: 12_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
  });
  await writeFile(fake, "import fs from 'node:fs'; fs.appendFileSync(process.env.FAKE_TRACE, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()})+'\\n');\n");
  let opened;
  try {
    const first = await runWrapper('open', fixture.root, '--thread', threadId, '--codex-path', fake);
    opened = JSON.parse(first.stdout);
    const bindingPath = path.join(fixture.root, '.codex-design-bridge.json');
    const binding = JSON.parse(await readFile(bindingPath, 'utf8'));
    assert.equal(binding.threadId, threadId);
    assert.equal(binding.serverPid, opened.pid);
    const reused = JSON.parse((await runWrapper('open', fixture.root, '--thread', threadId, '--codex-path', fake)).stdout);
    assert.equal(reused.pid, opened.pid);
    assert.equal(reused.reused, true);
    await assert.rejects(runWrapper('open', fixture.root, '--thread', otherThread, '--codex-path', fake), (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /EDITOR_ALREADY_BOUND/);
      return true;
    });
    assert.equal(JSON.parse(await readFile(bindingPath, 'utf8')).threadId, threadId);
    assert.equal(JSON.parse(await readFile(path.join(fixture.root, '.artifact-server.json'), 'utf8')).pid, opened.pid);

    const text = '把验证标题改成“年度报告” & keep $(literal) `code` %PATH%';
    const headers = { 'Content-Type': 'application/json', Origin: new URL(opened.url).origin };
    const created = await jsonRequest(new URL('__comments', opened.url), {
      method: 'POST', headers, body: JSON.stringify({ ...fixture.comment, text, send: true }),
    });
    const deadline = Date.now() + 8_000;
    let calls = [];
    let delivered;
    while (Date.now() < deadline) {
      try {
        calls = (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
        const stored = JSON.parse(await readFile(path.join(fixture.root, 'comments.json'), 'utf8'));
        delivered = stored.threads.find((entry) => entry.id === created.thread.id)?.agent;
        if (calls.length && delivered?.status === 'delivered') break;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(calls.length, 1, 'the actual editor hook must invoke the fake queue runner once');
    assert.equal(delivered?.status, 'delivered');
    assert.deepEqual(calls[0].args.slice(0, 3), ['queue', '--thread', threadId]);
    assert.equal(calls[0].cwd, fixture.root);
    const message = calls[0].args[calls[0].args.indexOf('--message') + 1];
    assert.ok(message.includes(JSON.stringify(text).slice(1, -1)), 'user text must remain literal across the Windows hook boundary');
    assert.ok(message.includes(created.thread.id));
    const receipt = JSON.parse(await readFile(path.join(fixture.root, '.codex-design-deliveries.json'), 'utf8'));
    assert.equal(Object.keys(receipt.delivered).length, 1);
    const resend = await fetchWithin(new URL(`__comments/${created.thread.id}/send`, opened.url), { method: 'POST', headers });
    assert.equal(resend.status, 409);
    assert.equal((await readFile(trace, 'utf8')).trim().split('\n').length, 1);
  } finally {
    if (opened) await runCli(fixture, 'stop', fixture.root).catch(() => {});
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('editor hook: an edited user revision sent during slow delivery is queued after the first revision', { timeout: 30_000 }, async () => {
  const fixture = await createFixture('slides');
  const wrapper = path.join(pluginRoot, 'skills', fixture.skill, 'scripts', 'codex-artifact.mjs');
  const trace = path.join(fixture.root, 'slow-queue-trace.jsonl');
  const fake = path.join(fixture.root, 'slow fake codex.mjs');
  const threadId = '11111111-2222-4333-8444-555555555555';
  const env = { ...process.env, CODEX_THREAD_ID: '', FAKE_TRACE: trace };
  await writeFile(fake, "import fs from 'node:fs'; fs.appendFileSync(process.env.FAKE_TRACE, JSON.stringify({args:process.argv.slice(2),at:Date.now()})+'\\n'); await new Promise(resolve=>setTimeout(resolve,350));\n");
  const readCalls = async () => {
    try { return (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  const waitUntil = async (predicate, message) => {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    assert.fail(message);
  };
  let opened;
  try {
    const result = await execFileAsync(process.execPath, [wrapper, 'open', fixture.root, '--thread', threadId, '--codex-path', fake], {
      env, timeout: 12_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
    });
    opened = JSON.parse(result.stdout);
    const headers = { 'Content-Type': 'application/json', Origin: new URL(opened.url).origin };
    const firstText = 'Revision A: change the heading to Draft A.';
    const secondText = 'Revision B: change the heading to Final B.';
    const created = await jsonRequest(new URL('__comments', opened.url), {
      method: 'POST', headers, body: JSON.stringify({ ...fixture.comment, text: firstText, send: true }),
    });
    await waitUntil(async () => (await readCalls()).length === 1, 'the first revision never reached the fake queue');
    const commentId = created.thread.id;
    const messageId = created.thread.messages[0].id;
    const revised = await jsonRequest(new URL(`__comments/${commentId}/messages/${messageId}`, opened.url), {
      method: 'PATCH', headers, body: JSON.stringify({ text: secondText, send: true }),
    });
    assert.equal(revised.thread.agent.status, 'pending');
    const secondSentAt = revised.thread.agent.sentAt;
    await waitUntil(async () => (await readCalls()).length === 2, 'the newer revision was swallowed by the first delivery acknowledgment');
    let stored;
    await waitUntil(async () => {
      stored = JSON.parse(await readFile(path.join(fixture.root, 'comments.json'), 'utf8'));
      return stored.threads[0].agent?.status === 'delivered';
    }, 'the newer revision was not marked delivered after its queue command completed');
    const calls = await readCalls();
    assert.equal(calls.length, 2);
    const messageOf = (call) => call.args[call.args.indexOf('--message') + 1];
    assert.ok(messageOf(calls[0]).includes(firstText));
    assert.ok(!messageOf(calls[0]).includes(secondText));
    assert.ok(messageOf(calls[1]).includes(secondText));
    assert.equal(stored.threads[0].messages[0].text, secondText);
    assert.equal(stored.threads[0].agent.sentAt, secondSentAt);
    assert.ok(Date.parse(stored.threads[0].agent.deliveredAt) >= Date.parse(secondSentAt));
    const receipts = JSON.parse(await readFile(path.join(fixture.root, '.codex-design-deliveries.json'), 'utf8'));
    assert.equal(Object.keys(receipts.delivered).length, 2);
  } finally {
    if (opened) await runCli(fixture, 'stop', fixture.root).catch(() => {});
    await rm(fixture.root, { recursive: true, force: true });
  }
});
