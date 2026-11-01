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

test('legacy main delivery: real editor hook targets the bound chat and refuses a silent chat switch', { timeout: 30_000 }, async () => {
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
    const first = await runWrapper('open-service', fixture.root, '--delivery', 'main', '--thread', threadId, '--codex-path', fake);
    opened = JSON.parse(first.stdout);
    const bindingPath = path.join(fixture.root, '.codex-design-bridge.json');
    const binding = JSON.parse(await readFile(bindingPath, 'utf8'));
    assert.equal(binding.threadId, threadId);
    assert.equal(binding.serverPid, opened.pid);
    const reused = JSON.parse((await runWrapper('open-service', fixture.root, '--delivery', 'main', '--thread', threadId, '--codex-path', fake)).stdout);
    assert.equal(reused.pid, opened.pid);
    assert.equal(reused.reused, true);
    await assert.rejects(runWrapper('open-service', fixture.root, '--delivery', 'main', '--thread', otherThread, '--codex-path', fake), (error) => {
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

test('legacy main delivery: an edited revision sent during slow delivery is queued after the first revision', { timeout: 30_000 }, async () => {
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
    const result = await execFileAsync(process.execPath, [wrapper, 'open-service', fixture.root, '--delivery', 'main', '--thread', threadId, '--codex-path', fake], {
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

// The test controller supplies distinct native identities to the actual CLI.
// This simulates platform lifecycle decisions, not platform-spawn verification.
async function boundNativeFixture() {
  const fixture = await createFixture('slides');
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
  catch (error) { await rm(fixture.root, { recursive: true, force: true }); throw error; }
  const headers = { 'Content-Type': 'application/json', Origin: new URL(opened.url).origin };
  return {
    ...fixture, opened, originThreadId, workerThreadId, parent, worker, calls,
    status: () => parent('worker-status', fixture.root),
    register: () => worker('worker-register', fixture.root, '--name', 'runtime-native-worker'),
    next: () => worker('worker-next', fixture.root, '--timeout', '0'),
    complete: (jobId, input) => execute(workerThreadId, ['worker-complete', fixture.root, jobId, '-'], input),
    comment: (text, send = true) => jsonRequest(new URL('__comments', opened.url), { method: 'POST', headers, body: JSON.stringify({ ...fixture.comment, text, send }) }),
    revise: (commentId, messageId, text) => jsonRequest(new URL('__comments/' + commentId + '/messages/' + messageId, opened.url), { method: 'PATCH', headers, body: JSON.stringify({ text, send: true }) }),
    close: async () => {
      try {
        await parent('stop', fixture.root);
        assert.deepEqual(await calls(), [], 'native delivery must never launch an external Codex process');
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
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
  }, 'the editor HTTP send did not persist its native job');
}

test('default native delivery: durable editor jobs are claimed serially by the registered child and replied to automatically', { timeout: 45_000 }, async () => {
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
    const firstJob = await pendingNativeJob(fixture, first.thread.id);
    const unclaimed = await fixture.status();
    assert.equal(unclaimed.counts.pending, 1);
    assert.equal(unclaimed.counts.active, 0);
    assert.equal(unclaimed.nativeThreadId, null, 'the editor must not spawn or register a child');
    assert.equal(unclaimed.needsResume, true);
    assert.deepEqual(await fixture.calls(), [], 'HTTP send persists work without launching a model or queue');

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

test('default native delivery: failed completions remain failed and receive an honest original-comment reply', { timeout: 35_000 }, async () => {
  const fixture = await boundNativeFixture();
  try {
    await fixture.register();
    const created = await fixture.comment('This controlled native edit intentionally fails.');
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

test('default native delivery: revision B supersedes the active revision A and receives the only reply', { timeout: 40_000 }, async () => {
  const fixture = await boundNativeFixture();
  try {
    await fixture.register();
    const firstText = 'Native revision A: use Draft A.';
    const secondText = 'Native revision B: use Final B.';
    const created = await fixture.comment(firstText);
    const firstJob = await pendingNativeJob(fixture, created.thread.id);
    const firstClaim = await fixture.next();
    assert.equal(firstClaim.job.id, firstJob.id);
    assert.ok(firstClaim.request.includes(firstText));
    await fixture.revise(created.thread.id, created.thread.messages[0].id, secondText);
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
