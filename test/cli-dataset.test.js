import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function runCli(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['bin/jbrancher.js', ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
}

test('dataset CLI merges exported JSONL without changing routes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jbrancher-cli-dataset-'));
  try {
    const firstPath = join(directory, 'machine-a.jsonl');
    const secondPath = join(directory, 'machine-b.jsonl');
    const outputPath = join(directory, 'merged.jsonl');
    const first = {
      fingerprint: 'same-trajectory',
      task: 'inspect package.json',
      source: 'machine-a',
      outcome: 'success',
      createdAt: '2026-09-20T00:00:00.000Z',
      secret: 'apikey_should_not_persist_cli'
    };
    const second = { ...first, source: 'machine-b', createdAt: '2026-09-20T00:01:00.000Z' };
    await writeFile(firstPath, `${JSON.stringify(first)}\n`, 'utf8');
    await writeFile(secondPath, `${JSON.stringify(second)}\n`, 'utf8');

    const result = await runCli([
      'dataset',
      '--input', firstPath,
      '--input', secondPath,
      '--dedupe',
      '--output', outputPath
    ], process.cwd());
    assert.equal(result.code, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.inputExamples, 2);
    assert.equal(summary.datasetExamples, 1);
    assert.equal(summary.evidenceObservations, 2);
    assert.equal(summary.routesChanged, false);
    const merged = (await readFile(outputPath, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(merged.length, 1);
    assert.deepEqual(merged[0].evidence.sources, ['machine-a', 'machine-b']);
    assert.doesNotMatch(JSON.stringify(merged), /apikey_should_not_persist_cli/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
