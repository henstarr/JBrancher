import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startClaudeShadow, parseClaudeArgs, wrapClaude } from '../src/claude.js';
import { createLocalLearningStore } from '../src/learning.js';

async function post(service, input, authorized = true) {
  const hook = service.settings.hooks.PreToolUse[0].hooks[0];
  return fetch(hook.url, { method: 'POST', headers: {
    'Content-Type': 'application/json', ...(authorized ? hook.headers : {})
  }, body: JSON.stringify(input) });
}
async function postEvent(service, event, authorized = true) {
  const hook = service.settings.hooks[event.hook_event_name][0].hooks[0];
  return fetch(hook.url, { method: 'POST', headers: {
    'Content-Type': 'application/json', ...(authorized ? hook.headers : {})
  }, body: JSON.stringify(event) });
}
const prompt = { session_id: 's', prompt_id: 'p', hook_event_name: 'UserPromptSubmit', prompt: 'Read the README' };
const tool = { session_id: 's', prompt_id: 'p', hook_event_name: 'PreToolUse',
  tool_name: 'Read', tool_input: { file_path: 'private-path' } };

test('shadow returns before inference, never returns permissions, enforces budget, and minimizes logs', async () => {
  let finish;
  let state;
  const rows = [];
  const service = await startClaudeShadow({ maxEvaluations: 1,
    evaluate: input => { state = input; return new Promise(resolve => { finish = resolve; }); },
    record: async row => rows.push(row) });
  try {
    assert.equal((await post(service, prompt, false)).status, 403);
    await post(service, prompt);
    assert.deepEqual(await (await post(service, tool)).json(), {});
    assert.equal(service.stats.evaluated, 1);
    assert.equal(rows.length, 0);
    await post(service, tool);
    assert.equal(service.stats.skipped, 1);
    assert.equal(state.task, prompt.prompt);
    assert.deepEqual(state.candidates, [{ tool: 'Read', args: tool.tool_input }]);
  } finally {
    finish?.({ scores: [0.94] });
    await service.close();
  }
  assert.equal(rows[0].score, 0.94);
  assert.equal(rows[0].actorCallsAvoided, 0);
  assert.ok(!JSON.stringify(rows).includes('private-path'));
  assert.ok(!JSON.stringify(rows).includes(prompt.prompt));
});

test('missing context, malformed input and evaluator failure leave Claude decisions untouched', async () => {
  const rows = [];
  const service = await startClaudeShadow({ evaluate: async () => { throw new Error('secret-provider-error'); },
    record: async row => rows.push(row) });
  try {
    assert.equal((await post(service, null)).status, 400);
    assert.deepEqual(await (await post(service, tool)).json(), {});
    assert.equal(service.stats.skipped, 1);
    await post(service, prompt);
    assert.deepEqual(await (await post(service, tool)).json(), {});
  } finally { await service.close(); }
  assert.equal(rows[0].status, 'unavailable');
  assert.ok(!JSON.stringify(rows).includes('secret-provider-error'));
});

test('Claude learning hooks record a canonical local episode without changing hook replies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jbrancher-claude-learning-'));
  const store = createLocalLearningStore({ directory });
  const service = await startClaudeShadow({ maxEvaluations: 0, learningStore: store });
  try {
    await postEvent(service, { session_id: 'learn-session', prompt_id: 'learn-prompt', cwd: directory,
      hook_event_name: 'UserPromptSubmit', prompt: 'read README.md' });
    await postEvent(service, { session_id: 'learn-session', prompt_id: 'learn-prompt', cwd: directory,
      hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'read-1', tool_input: { file_path: join(directory, 'README.md') } });
    const result = await postEvent(service, { session_id: 'learn-session', prompt_id: 'learn-prompt', cwd: directory,
      hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'read-1', tool_input: { file_path: join(directory, 'README.md') },
      tool_response: 'README contents' });
    assert.equal(result.status, 200);
    await postEvent(service, { session_id: 'learn-session', cwd: directory, hook_event_name: 'Stop' });
  } finally {
    await service.close();
  }
  const traces = await store.readTraces();
  assert.equal(traces.length, 1);
  assert.equal(traces[0].outcome, 'success');
  assert.equal(traces[0].toolCalls[0].toolName, 'read');
  assert.equal(traces[0].toolCalls[0].input.path.toLowerCase(), 'readme.md');
  await rm(directory, { recursive: true, force: true });
});

test('wrapper separates Claude arguments and rejects unsupported modes and conflicting settings', () => {
  assert.deepEqual(parseClaudeArgs(['claude', '--mode', 'shadow', '--max-evaluations', '0', '--', '-p', 'hello']),
    { args: ['-p', 'hello'], maxEvaluations: 0 });
  for (const args of [['claude', '--mode', 'guard'], ['claude', '--max-evaluations', '-1'],
    ['claude', '--', '--settings=x'], ['claude', '--', '--bare']]) {
    assert.throws(() => parseClaudeArgs(args));
  }
});

test('missing Claude executable fails cleanly and writes a zero-request summary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jbrancher-launch-test-'));
  await assert.rejects(wrapClaude({ maxEvaluations: 0, executable: 'jbrancher-nonexistent-cli-92813',
    logDirectory: directory }), /Could not launch Claude Code/);
  const files = await readdir(directory);
  const row = JSON.parse(await readFile(join(directory, files[0]), 'utf8'));
  assert.equal(row.summary.evaluated, 0);
});
