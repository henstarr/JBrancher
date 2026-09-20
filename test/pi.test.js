import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPiRouter, formatPiResult } from '../src/pi.js';
import { createLocalLearningStore } from '../src/learning.js';
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

test('Pi learning mode records fallback tool use and auto-promotes repeated safe reads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jbrancher-pi-learning-test-'));
  const handlers = new Map();
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    registerCommand() {},
    sendMessage() {},
    exec: async () => ({ code: 0, stdout: '', stderr: '' })
  };
  const ctx = {
    cwd: directory,
    mode: 'json',
    hasUI: false,
    ui: { notify() {}, setStatus() {} }
  };
  const previousMode = process.env.JBRANCHER_PI_MODE;
  process.env.JBRANCHER_PI_MODE = 'learning';
  try {
    await jbrancherPiExtension(pi);
    await handlers.get('session_start')({}, ctx);
    for (const id of ['one', 'two']) {
      await handlers.get('input')({ text: 'read the package', source: 'interactive' }, ctx);
      await handlers.get('tool_call')({ toolCallId: id, toolName: 'read', input: { path: 'package.json' } }, ctx);
      await handlers.get('tool_result')({ toolCallId: id, isError: false, content: [{ type: 'text', text: 'ok' }] }, ctx);
      await handlers.get('agent_end')({}, ctx);
    }
    const routes = JSON.parse(await readFile(join(directory, '.jbrancher', 'routes.json'), 'utf8'));
    assert.equal(routes.length, 1);
    assert.equal(routes[0].status, 'active');
    assert.equal(routes[0].safety, 'read-only');
  } finally {
    if (previousMode === undefined) delete process.env.JBRANCHER_PI_MODE;
    else process.env.JBRANCHER_PI_MODE = previousMode;
    await rm(directory, { recursive: true, force: true });
  }
});

test('Pi learning mode mines an unknown successful route immediately as a candidate', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jbrancher-pi-candidate-test-'));
  const handlers = new Map();
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    registerCommand() {},
    sendMessage() {},
    exec: async () => ({ code: 0, stdout: '', stderr: '' })
  };
  const ctx = {
    cwd: directory,
    mode: 'json',
    hasUI: false,
    ui: { notify() {}, setStatus() {} }
  };
  const previousMode = process.env.JBRANCHER_PI_MODE;
  process.env.JBRANCHER_PI_MODE = 'learning';
  try {
    await jbrancherPiExtension(pi);
    await handlers.get('session_start')({}, ctx);
    await handlers.get('input')({ text: 'read README.md', source: 'interactive' }, ctx);
    await handlers.get('tool_call')({ toolCallId: 'one', toolName: 'read', input: { path: 'README.md' } }, ctx);
    await handlers.get('tool_result')({ toolCallId: 'one', isError: false, content: [{ type: 'text', text: 'ok' }] }, ctx);
    await handlers.get('agent_end')({}, ctx);
    const routes = JSON.parse(await readFile(join(directory, '.jbrancher', 'routes.json'), 'utf8'));
    const dataset = await readFile(join(directory, '.jbrancher', 'dataset.jsonl'), 'utf8');
    assert.equal(routes.length, 1);
    assert.equal(routes[0].status, 'candidate');
    assert.equal(dataset.trim().split(/\r?\n/).length, 1);
  } finally {
    if (previousMode === undefined) delete process.env.JBRANCHER_PI_MODE;
    else process.env.JBRANCHER_PI_MODE = previousMode;
    await rm(directory, { recursive: true, force: true });
  }
});

test('Pi learning outcome validation can veto promotion after tool success', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jbrancher-pi-outcome-test-'));
  await writeFile(join(directory, 'jbrancher.config.js'), 'export default { learningOutcome: () => false };\n', 'utf8');
  const store = createLocalLearningStore({ directory: join(directory, '.jbrancher') });
  const handlers = new Map();
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    registerCommand() {},
    sendMessage() {},
    exec: async () => ({ code: 0, stdout: '', stderr: '' })
  };
  const ctx = {
    cwd: directory,
    mode: 'json',
    hasUI: false,
    ui: { notify() {}, setStatus() {} }
  };
  const previousMode = process.env.JBRANCHER_PI_MODE;
  process.env.JBRANCHER_PI_MODE = 'learning';
  try {
    await jbrancherPiExtension(pi);
    await handlers.get('session_start')({}, ctx);
    for (const id of ['one', 'two']) {
      await handlers.get('input')({ text: 'read package.json', source: 'interactive' }, ctx);
      await handlers.get('tool_call')({ toolCallId: id, toolName: 'read', input: { path: 'package.json' } }, ctx);
      await handlers.get('tool_result')({ toolCallId: id, isError: false, content: [{ type: 'text', text: 'ok' }] }, ctx);
      await handlers.get('agent_end')({}, ctx);
    }
    assert.equal((await store.readTraces()).every(trace => trace.outcome === 'unknown'), true);
    assert.equal((await store.readRoutes()).some(route => route.status === 'active'), false);
  } finally {
    if (previousMode === undefined) delete process.env.JBRANCHER_PI_MODE;
    else process.env.JBRANCHER_PI_MODE = previousMode;
    await rm(directory, { recursive: true, force: true });
  }
});

test('Pi learning mode promotes a path template and handles a new file request', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jbrancher-pi-path-learning-test-'));
  await writeFile(join(directory, 'src-index.js'), 'export default true;\n', 'utf8');
  const handlers = new Map();
  const messages = [];
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    registerCommand() {},
    sendMessage(message) { messages.push(message); },
    exec: async () => ({ code: 0, stdout: '', stderr: '' })
  };
  const ctx = {
    cwd: directory,
    mode: 'json',
    hasUI: false,
    ui: { notify() {}, setStatus() {} }
  };
  const previousMode = process.env.JBRANCHER_PI_MODE;
  process.env.JBRANCHER_PI_MODE = 'learning';
  try {
    await jbrancherPiExtension(pi);
    await handlers.get('session_start')({}, ctx);
    for (const [id, task, path] of [
      ['one', 'read package.json', 'package.json'],
      ['two', 'open README.md', 'README.md']
    ]) {
      await handlers.get('input')({ text: task, source: 'interactive' }, ctx);
      await handlers.get('tool_call')({ toolCallId: id, toolName: 'read', input: { path } }, ctx);
      await handlers.get('tool_result')({ toolCallId: id, isError: false, content: [{ type: 'text', text: 'ok' }] }, ctx);
      await handlers.get('agent_end')({}, ctx);
    }
    const handled = await handlers.get('input')({ text: 'inspect src-index.js', source: 'interactive' }, ctx);
    assert.deepEqual(handled, { action: 'handled' });
    assert.match(messages.at(-1).content, /export default true/);
  } finally {
    if (previousMode === undefined) delete process.env.JBRANCHER_PI_MODE;
    else process.env.JBRANCHER_PI_MODE = previousMode;
    await rm(directory, { recursive: true, force: true });
  }
});

test('Pi quarantines a learned route that fails and avoids an empty fallback trace', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jbrancher-pi-quarantine-test-'));
  const store = createLocalLearningStore({ directory: join(directory, '.jbrancher') });
  await store.writeRoutes([{
    schemaVersion: 1,
    id: 'learned-stale-read',
    status: 'active',
    matcher: { type: 'normalized-exact', value: 'read missing.txt' },
    action: { toolName: 'read', input: { path: 'missing.txt' } },
    safety: 'read-only',
    observations: 2
  }]);
  const handlers = new Map();
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    registerCommand() {},
    sendMessage() {},
    exec: async () => ({ code: 0, stdout: '', stderr: '' })
  };
  const ctx = {
    cwd: directory,
    mode: 'json',
    hasUI: false,
    ui: { notify() {}, setStatus() {} }
  };
  const previousMode = process.env.JBRANCHER_PI_MODE;
  process.env.JBRANCHER_PI_MODE = 'learning';
  try {
    await jbrancherPiExtension(pi);
    await handlers.get('session_start')({}, ctx);
    const result = await handlers.get('input')({ text: 'read missing.txt', source: 'interactive' }, ctx);
    assert.deepEqual(result, { action: 'continue' });
    assert.equal((await store.readRoutes())[0].status, 'quarantined');
  } finally {
    if (previousMode === undefined) delete process.env.JBRANCHER_PI_MODE;
    else process.env.JBRANCHER_PI_MODE = previousMode;
    await rm(directory, { recursive: true, force: true });
  }
});
