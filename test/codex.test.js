import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexObserver, createEventDecoder, parseCodexArgs, wrapCodex } from '../src/codex.js';
import { createLocalLearningStore } from '../src/learning.js';

const event = (id = 'one', type = 'item.started') => ({ type, item: { id, type: 'command_execution', command: 'echo example' } });

test('Codex observer deduplicates lifecycle events and respects the cap', async () => {
  const rows = [], calls = [];
  const observer = createCodexObserver({ prompt: 'example task', maxEvaluations: 1,
    evaluate: async input => { calls.push(input); return { scores: [0.9] }; }, record: async row => rows.push(row) });
  observer.observe(null);
  observer.observe(event()); observer.observe(event('one', 'item.completed')); observer.observe(event('two'));
  await observer.close();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].candidates[0].args.command, 'echo example');
  assert.equal(observer.stats.observed, 2);
  assert.equal(observer.stats.skipped, 1);
  assert.equal(rows[0].score, 0.9);
  assert.equal(rows[0].actorCallsAvoided, 0);
  assert.ok(!JSON.stringify(rows).includes('example'));
});

test('Codex scores do not block ingestion; concurrency and failures are bounded', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const observer = createCodexObserver({ prompt: 'task', evaluate: async () => { await gate; throw new Error('secret'); },
    record: async () => { throw new Error('disk full'); } });
  observer.observe(event('1')); observer.observe(event('2')); observer.observe(event('3'));
  assert.equal(observer.stats.evaluated, 2);
  assert.equal(observer.stats.skipped, 1);
  release(); await observer.close();
  assert.equal(observer.stats.unavailable, 2);
  assert.equal(observer.stats.logErrors, 2);
});

test('Codex learning records started and completed commands as one local episode', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jbrancher-codex-learning-'));
  const store = createLocalLearningStore({ directory });
  const observer = createCodexObserver({ prompt: 'check git status', maxEvaluations: 0, learningStore: store });
  observer.observe({ type: 'item.started', item: { id: 'command-1', type: 'command_execution', command: 'git status' } });
  observer.observe({ type: 'item.completed', item: { id: 'command-1', type: 'command_execution', command: 'git status', status: 'completed' } });
  observer.observe({ type: 'item.completed', item: { id: 'command-1', type: 'command_execution', command: 'git status', status: 'completed' } });
  await observer.close();
  const traces = await store.readTraces();
  assert.equal(traces.length, 1);
  assert.equal(traces[0].outcome, 'success');
  assert.equal(traces[0].toolCalls.length, 1);
  assert.equal(traces[0].toolCalls[0].toolName, 'bash');
  await rm(directory, { recursive: true, force: true });
});

test('Codex rejects invalid scores and zero budget makes no requests', async () => {
  const rows = [];
  const observer = createCodexObserver({ prompt: 'task', evaluate: async () => ({ scores: [NaN] }), record: async row => rows.push(row) });
  observer.observe(event()); await observer.close();
  assert.equal(rows[0].status, 'unavailable');
  const zero = createCodexObserver({ prompt: 'task', maxEvaluations: 0, evaluate: () => assert.fail() });
  zero.observe(event()); await zero.close();
  assert.equal(zero.stats.skipped, 1);
});

test('event decoder handles split, malformed, and oversized JSONL', () => {
  const rows = [], decode = createEventDecoder(row => rows.push(row), 256);
  const line = JSON.stringify(event()) + '\n';
  decode(line.slice(0, 10)); decode(line.slice(10));
  decode('invalid\n'); decode('x'.repeat(300)); decode('\n' + line);
  assert.equal(rows.length, 2);
});

test('Codex CLI options require an explicit task and validate budget', () => {
  assert.deepEqual(parseCodexArgs(['codex', '--prompt', 'read README', '--max-evaluations', '1', '--', '--sandbox', 'read-only']),
    { prompt: 'read README', maxEvaluations: 1, args: ['--sandbox', 'read-only'], mode: 'shadow' });
  assert.equal(parseCodexArgs(['codex', '--prompt', 'read README', '--mode', 'adaptive']).mode, 'adaptive');
  for (const args of [[], ['--prompt', ''], ['--prompt', 'x', '--mode', 'guard'], ['--prompt', 'x', '--max-evaluations', '-1']]) {
    assert.throws(() => parseCodexArgs(['codex', ...args]));
  }
});

test('Codex missing executable fails cleanly and writes a zero summary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jbrancher-codex-test-'));
  try {
    await assert.rejects(wrapCodex({ prompt: 'test', maxEvaluations: 0, executable: join(directory, 'missing'), logDirectory: directory }), /Could not launch Codex/);
    const files = await readdir(directory);
    const row = JSON.parse(await readFile(join(directory, files[0]), 'utf8'));
    assert.equal(row.summary.observed, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Codex adaptive mode replays a promoted local read without launching Codex', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jbrancher-codex-replay-'));
  try {
    const store = createLocalLearningStore({ directory });
    await store.writeRoutes([{
      schemaVersion: 1,
      id: 'learned-read-readme',
      status: 'active',
      matcher: { type: 'normalized-exact', value: 'read readme.md' },
      action: { toolName: 'read', input: { path: 'README.md' } },
      safety: 'read-only',
      observations: 2
    }]);
    let stdout = '';
    const exitCode = await wrapCodex({
      prompt: 'read README.md',
      mode: 'adaptive',
      maxEvaluations: 0,
      learningDirectory: directory,
      executable: join(directory, 'must-not-launch'),
      output: { write(value) { stdout += value; return true; } },
      logDirectory: directory
    });
    assert.equal(exitCode, 0);
    assert.match(stdout, /agent_message/);
    assert.match(stdout, /README/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
