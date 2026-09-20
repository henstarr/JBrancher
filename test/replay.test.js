import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalLearningStore } from '../src/learning.js';
import { replayLearnedTask } from '../src/replay.js';

test('replayLearnedTask executes only an active exact read route inside the project', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jbrancher-replay-'));
  try {
    await writeFile(join(directory, 'README.md'), 'local replay\n', 'utf8');
    const store = createLocalLearningStore({ directory: join(directory, '.jbrancher') });
    await store.writeRoutes([{
      schemaVersion: 1,
      id: 'learned-read-readme',
      status: 'active',
      matcher: { type: 'normalized-exact', value: 'read readme.md' },
      action: { toolName: 'read', input: { path: 'README.md' } },
      safety: 'read-only',
      observations: 2
    }]);
    const replay = await replayLearnedTask({
      task: 'read README.md',
      directory: join(directory, '.jbrancher'),
      cwd: directory
    });
    assert.equal(replay.handled, true);
    assert.equal(replay.routeId, 'learned-read-readme');
    assert.equal(replay.result, 'local replay\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('replayLearnedTask refuses candidates and unsafe routes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jbrancher-replay-reject-'));
  try {
    const store = createLocalLearningStore({ directory });
    await store.writeRoutes([
      { id: 'candidate', status: 'candidate', matcher: { type: 'normalized-exact', value: 'read README.md' },
        action: { toolName: 'read', input: { path: 'README.md' } }, safety: 'read-only', observations: 10 },
      { id: 'unsafe', status: 'active', matcher: { type: 'normalized-exact', value: 'delete build' },
        action: { toolName: 'bash', input: { command: 'rm -rf build' } }, safety: 'side-effect-or-unknown', observations: 10 }
    ]);
    const replay = await replayLearnedTask({ task: 'read README.md', directory, cwd: directory });
    assert.equal(replay.handled, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

