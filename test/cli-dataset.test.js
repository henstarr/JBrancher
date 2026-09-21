import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { traceToDatasetExample } from '../src/learning.js';

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

test('learn CLI imports an approved dataset into local routes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jbrancher-cli-import-'));
  try {
    const inputPath = join(directory, 'shared.jsonl');
    const routePath = join(directory, 'routes.json');
    const example = traceToDatasetExample({
      task: 'inspect package.json',
      source: 'shared-dataset',
      outcome: 'success',
      toolCalls: [{ toolName: 'read', input: { path: 'package.json' }, ok: true }]
    });
    await writeFile(inputPath, `${JSON.stringify(example)}\n`, 'utf8');
    const result = await runCli([
      'learn',
      '--dir', directory,
      '--import', inputPath,
      '--approve-import',
      '--min-observations', '1'
    ], process.cwd());
    assert.equal(result.code, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.imported.importedTraces, 1);
    assert.equal(summary.imported.reviewed, true);
    const routes = JSON.parse(await readFile(routePath, 'utf8'));
    assert.equal(routes.length, 1);
    assert.equal(routes[0].status, 'active');
    assert.equal(routes[0].verified, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
