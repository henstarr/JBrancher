#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

function value(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function printHelp() {
  console.log(`Official SWE-bench evaluator runner

Usage:
  npm run bench:swebench -- --predictions predictions/jbrancher.jsonl [options]

Options:
  --predictions PATH     Required SWE-bench prediction JSONL file
  --dataset NAME         Default: princeton-nlp/SWE-bench_Lite
  --instance-ids IDS     Space-separated IDs after this flag
  --max-workers N        Default: 2
  --run-id NAME          Default: jbrancher-local
  --modal                Use the official Modal evaluation path
  --dry-run              Print the official command without running it
`);
}

function commandFor(options) {
  const args = [
    '-m', 'swebench.harness.run_evaluation',
    '--dataset_name', options.dataset,
    '--predictions_path', options.predictions,
    '--max_workers', options.maxWorkers,
    '--run_id', options.runId
  ];
  if (options.instanceIds.length > 0) args.push('--instance_ids', ...options.instanceIds);
  if (options.modal) args.push('--modal', 'true');
  return { executable: options.python, args };
}

function dockerAvailable() {
  const result = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'ignore' });
  return result.status === 0;
}

const options = {
  predictions: value('--predictions'),
  dataset: value('--dataset', 'princeton-nlp/SWE-bench_Lite'),
  maxWorkers: value('--max-workers', '2'),
  runId: value('--run-id', 'jbrancher-local'),
  python: value('--python', process.platform === 'win32' ? 'python' : 'python3'),
  modal: hasFlag('--modal'),
  dryRun: hasFlag('--dry-run'),
  instanceIds: []
};

const idsIndex = process.argv.indexOf('--instance-ids');
if (idsIndex !== -1) {
  for (let index = idsIndex + 1; index < process.argv.length && !process.argv[index].startsWith('--'); index++) {
    options.instanceIds.push(process.argv[index]);
  }
}

if (hasFlag('--help') || hasFlag('-h')) {
  printHelp();
  process.exit(0);
}
if (!options.predictions) {
  printHelp();
  process.exitCode = 2;
} else if (!/^\d+$/.test(options.maxWorkers) || Number(options.maxWorkers) < 1) {
  throw new Error('--max-workers must be a positive integer');
} else {
  const command = commandFor(options);
  console.error(`SWE-bench dataset: ${options.dataset}`);
  console.error(`Prediction file: ${options.predictions}`);
  console.error(`Official command: ${command.executable} ${command.args.join(' ')}`);
  if (options.dryRun) process.exit(0);
  if (!options.modal && !dockerAvailable()) {
    throw new Error('Docker is unavailable. Install Docker, or rerun with --modal after configuring Modal credentials.');
  }
  const result = spawnSync(command.executable, command.args, { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
}
