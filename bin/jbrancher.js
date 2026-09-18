#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createJBrancher } from '../src/index.js';
import { createJevEvaluator } from '../src/jev.js';

function loadDotEnv(file = resolve(process.cwd(), '.env')) {
  if (!existsSync(file)) return false;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] in process.env) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
  return true;
}

function printHelp() {
  console.log(`JBrancher\n\nCommands:\n  demo        Run the offline demo\n  doctor      Check local runtime and credential configuration\n  live-check  Run three bounded synthetic Jev decisions\n`);
}

async function liveCheck() {
  loadDotEnv();
  if (!process.env.TYPESAFE_API_KEY) {
    throw new Error('TYPESAFE_API_KEY is not configured. Put it in .env or the process environment.');
  }
  const evaluate = createJevEvaluator({
    apiKey: process.env.TYPESAFE_API_KEY,
    model: 'jev-1.13.0',
    timeoutMs: 10_000
  });
  const cases = [
    { id: 'written-needs-verification', task: 'Choose the next safe step for a written artifact.', state: { artifact: 'written', verification: 'not-run' }, candidates: [{ tool: 'verify', args: {} }, null] },
    { id: 'verified-can-finish', task: 'Choose the next safe step for an already verified artifact.', state: { artifact: 'verified', verification: 'passed' }, candidates: [{ tool: 'verify', args: {} }, null] },
    { id: 'failed-needs-repair', task: 'Choose the next safe step after verification failed.', state: { artifact: 'written', verification: 'failed', error: 'expected value mismatch' }, candidates: [{ tool: 'repair', args: {} }, { tool: 'verify', args: {} }, null] }
  ];
  const rows = [];
  for (const item of cases) {
    const brancher = createJBrancher({
      getCandidates: async () => item.candidates,
      evaluate,
      actor: async () => ({ action: null, usage: [] })
    });
    const event = await brancher.step({ task: item.task, state: item.state });
    rows.push({ id: item.id, source: event.decision.source, action: event.decision.action,
      scores: event.decision.evaluation?.scores ?? null, usage: event.decision.evaluation?.usage ?? [] });
  }
  console.log(JSON.stringify({ model: 'jev-1.13.0', cases: rows }, null, 2));
}

async function main() {
  const command = process.argv[2] ?? 'help';
  if (command === 'help' || command === '--help' || command === '-h') return printHelp();
  if (command === 'demo') return import('../examples/demo.js');
  if (command === 'doctor') {
    const envLoaded = loadDotEnv();
    const nodeMajor = Number(process.versions.node.split('.')[0]);
    const report = { node: process.versions.node, nodeSupported: nodeMajor >= 20,
      envFileFound: envLoaded, typesafeKeyConfigured: Boolean(process.env.TYPESAFE_API_KEY) };
    console.log(JSON.stringify(report, null, 2));
    if (!report.nodeSupported || !report.typesafeKeyConfigured) process.exitCode = 1;
    return;
  }
  if (command === 'live-check') return liveCheck();
  throw new Error(`Unknown command: ${command}`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
