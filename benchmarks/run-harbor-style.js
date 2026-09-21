#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJBrancherServer } from '../src/server.js';

const fixturePath = fileURLToPath(new URL('./fixtures/swebench-lite-mini.json', import.meta.url));
const scriptPath = fileURLToPath(new URL('./run-harbor-style.py', import.meta.url));
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));

function valueFlag(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] ?? fallback;
}

function integerFlag(name, fallback, minimum) {
  const value = Number(valueFlag(name, String(fallback)));
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}

function findPython() {
  for (const command of process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']) {
    const probe = spawnSync(command, ['--version'], { stdio: 'ignore' });
    if (probe.status === 0) return command;
  }
  throw new Error('Python 3 is required for the Harbor-style bridge benchmark');
}

function runPython(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`Harbor-style Python benchmark failed (${code}): ${stderr || stdout}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`Harbor-style benchmark returned invalid JSON: ${error.message}\n${stdout}`));
      }
    });
  });
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const python = findPython();
const instanceCount = integerFlag('--instances', fixture.instances.length, 1);
const repetitions = integerFlag('--repetitions', 4, 3);
const actorInputTokens = integerFlag('--actor-input-tokens', 1800, 0);
const actorOutputTokens = integerFlag('--actor-output-tokens', 140, 0);
const args = [
  scriptPath,
  '--base-url',
  '',
  '--fixture',
  fixturePath,
  '--instances',
  String(instanceCount),
  '--repetitions',
  String(repetitions),
  '--actor-input-tokens',
  String(actorInputTokens),
  '--actor-output-tokens',
  String(actorOutputTokens),
];
if (process.argv.includes('--assert')) args.push('--assert');

const directory = await mkdtemp(join(tmpdir(), 'jbrancher-harbor-style-'));
const service = createJBrancherServer({
  learningDirectory: directory,
  learningSource: 'harbor-style-benchmark',
});

try {
  const address = await service.listen({ port: 0 });
  args[2] = `http://${address.host}:${address.port}`;
  const report = await runPython(python, args, repoRoot);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await service.close();
  await rm(directory, { recursive: true, force: true });
}
