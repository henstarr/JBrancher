import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPiRouter, formatPiResult } from '../src/pi.js';
import jbrancherPiExtension from '../extensions/jbrancher.js';

test('Pi router executes one deterministic match without frontier evaluation', async () => {
  let evaluated = false;
  const router = createPiRouter({
    routes: [{ id: 'status', match: ({ task }) => task === 'status', run: async () => 'clean' }],
    evaluate: async () => { evaluated = true; return { scores: [1] }; }
  });
  const result = await router.handle({ task: 'status', state: { cwd: '/repo' } });
  assert.equal(result.source, 'deterministic');
  assert.equal(result.routeId, 'status');
  assert.equal(result.result, 'clean');
  assert.equal(evaluated, false);
});

test('Pi router lets frontier handle unmatched or uncertain prompts', async () => {
  const routes = [
    { id: 'a', match: () => true, run: async () => 'a' },
    { id: 'b', match: () => true, run: async () => 'b' }
  ];
  const uncertain = createPiRouter({ routes, evaluate: async () => ({ scores: [0.82, 0.8] }) });
  const result = await uncertain.handle({ task: 'ambiguous' });
  assert.equal(result.source, 'frontier');
  assert.equal(result.routeId, null);

  const unmatched = createPiRouter({ routes: [{ id: 'a', match: () => false, run: async () => 'a' }] });
  assert.equal((await unmatched.decide({ task: 'other' })).source, 'frontier');
});

test('Pi router uses Jev only among matched routes and falls back on provider failure', async () => {
  const router = createPiRouter({
    routes: [
      { id: 'a', match: () => true, run: async () => 'a' },
      { id: 'b', match: () => true, run: async () => 'b' }
    ],
    evaluate: async ({ candidates }) => ({ scores: candidates.map(candidate => candidate.args.routeId === 'b' ? 0.95 : 0.2) })
  });
  const result = await router.handle({ task: 'choose' });
  assert.equal(result.source, 'jev');
  assert.equal(result.routeId, 'b');
  assert.equal(result.result, 'b');

  const failed = createPiRouter({
    routes: [{ id: 'a', match: () => true, run: async () => 'a' }, { id: 'b', match: () => true, run: async () => 'b' }],
    evaluate: async () => { throw new Error('provider down'); }
  });
  assert.equal((await failed.decide({ task: 'choose' })).source, 'frontier');
});

test('Pi route failures become a frontier fallback and results are printable', async () => {
  const router = createPiRouter({ routes: [{ id: 'broken', match: () => true, run: async () => { throw new Error('nope'); } }] });
  const result = await router.handle({ task: 'run' });
  assert.equal(result.source, 'frontier');
  assert.match(result.reason, /frontier fallback/);
  assert.equal(formatPiResult({ ok: true }), '{\n  "ok": true\n}');
});

test('Pi extension handles a built-in deterministic prompt and leaves other prompts alone', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jbrancher-pi-test-'));
  const handlers = new Map();
  const messages = [];
  const notifications = [];
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    registerCommand() {},
    sendMessage(message) { messages.push(message); },
    exec: async (program, args) => ({ code: 0, stdout: program === 'git' ? ' M README.md\n' : '', stderr: '', args }),
  };
  const ctx = {
    cwd: directory,
    mode: 'json',
    hasUI: true,
    ui: {
      notify(message) { notifications.push(message); },
      setStatus() {}
    }
  };
  try {
    await jbrancherPiExtension(pi);
    await handlers.get('session_start')({}, ctx);
    const handled = await handlers.get('input')({ text: 'git status', source: 'interactive' }, ctx);
    const fallback = await handlers.get('input')({ text: 'refactor the parser', source: 'interactive' }, ctx);
    assert.deepEqual(handled, { action: 'handled' });
    assert.equal(messages.length, 1);
    assert.match(messages[0].content, /git-status/);
    assert.deepEqual(fallback, { action: 'continue' });
    assert.ok(notifications.some(message => message.includes('deterministic route')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
