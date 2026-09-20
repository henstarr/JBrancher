#!/usr/bin/env node

import { resolve } from 'node:path';
import { createJBrancher } from '../src/index.js';
import { createJevEvaluator } from '../src/jev.js';
import { createLocalLearningStore, refreshAndPromoteReadOnly } from '../src/learning.js';
import { loadDotEnv } from '../src/env.js';
import { createJBrancherServer } from '../src/server.js';
import { parseClaudeArgs, wrapClaude } from '../src/claude.js';
import { parseCodexArgs, wrapCodex } from '../src/codex.js';

function printHelp() {
  console.log('Codex batch: jbrancher wrap codex --mode shadow|adaptive --prompt "task" [--max-evaluations 25] -- [Codex exec options]');
  console.log('Claude Code: jbrancher wrap claude [--mode shadow|adaptive] [--max-evaluations 25] -- [Claude arguments]');
  console.log(`JBrancher\n\nCommands:\n  demo       Run the offline demo\n  doctor     Check local runtime and credential configuration\n  dataset    Export the local redacted fallback dataset\n  preferences Inspect local Pi route preferences\n  learn      Mine local traces and refresh safe learned routes\n  proxy      Start the language-agnostic decision service\n  live-check Run three bounded synthetic Jev decisions\n\nLearning:\n  jbrancher dataset [--dir .jbrancher] [--success-only]\n  Writes dataset.jsonl without changing route status.\n  jbrancher preferences [--dir .jbrancher]\n  Prints local Pi preference status without changing it.\n  jbrancher learn [--dir .jbrancher]\n  Mines candidates and promotes only safe read-only routes.\n\nProxy:\n  jbrancher proxy --port 8787 [--learning-dir .jbrancher]\n  POST /v1/decide with task, state, history, and candidates\n  POST /v1/episodes to record an open-world harness episode\n  GET  /health, /stats, or /v1/learning\n  --learning-dir also enables ingestion-only mode without a Jev key\n  --learning-allow-verified enables postcondition-certified write promotion\n`);
}

function flag(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] ?? fallback;
}

async function proxy() {
  loadDotEnv();
  const port = Number(flag('--port', '8787'));
  const host = flag('--host', '127.0.0.1');
  const learningDirectory = process.argv.includes('--learning-dir')
    ? resolve(process.cwd(), flag('--learning-dir', '.jbrancher'))
    : undefined;
  const learningAllowVerified = process.argv.includes('--learning-allow-verified');
  if (!process.env.TYPESAFE_API_KEY && !learningDirectory) {
    throw new Error('TYPESAFE_API_KEY is not configured. Put it in .env or the process environment, or pass --learning-dir for ingestion-only mode.');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid --port');
  const service = createJBrancherServer({
    apiKey: process.env.TYPESAFE_API_KEY,
    model: process.env.JBRANCHER_MODEL ?? 'jev-1.13.0',
    timeoutMs: Number(process.env.JBRANCHER_TIMEOUT_MS ?? 5000),
    learningDirectory,
    learningAllowVerified
  });
  const address = await service.listen({ host, port });
  console.log(JSON.stringify({ status: 'listening', ...address, endpoints: ['/health', '/stats', '/v1/decide', ...(learningDirectory ? ['/v1/episodes', '/v1/learning'] : [])] }));
  const shutdown = async () => {
    await service.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
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

async function learn() {
  const directory = resolve(process.cwd(), flag('--dir', '.jbrancher'));
  const minimumObservations = Number(flag('--min-observations', '2'));
  const candidateMinimumObservations = Number(flag('--candidate-min-observations', '1'));
  const minimumSimilarity = Number(flag('--min-similarity', '0.8'));
  if (!Number.isSafeInteger(minimumObservations) || minimumObservations < 1) {
    throw new Error('Invalid --min-observations');
  }
  if (!Number.isSafeInteger(candidateMinimumObservations) || candidateMinimumObservations < 1) {
    throw new Error('Invalid --candidate-min-observations');
  }
  if (!Number.isFinite(minimumSimilarity) || minimumSimilarity < 0 || minimumSimilarity > 1) {
    throw new Error('Invalid --min-similarity');
  }
  const store = createLocalLearningStore({ directory });
  const learned = await refreshAndPromoteReadOnly(store, {
    minimumObservations,
    candidateMinimumObservations,
    minimumSimilarity
  });
  const traces = await store.readTraces();
  const dataset = await store.writeDataset();
  const routes = await store.readRoutes();
  console.log(JSON.stringify({
    directory,
    traces: traces.length,
    datasetExamples: dataset.examples.length,
    candidates: routes.filter(route => route.status === 'candidate').length,
    activeReadOnlyRoutes: routes.filter(route => route.status === 'active' && route.safety === 'read-only').length,
    quarantinedRoutes: routes.filter(route => route.status === 'quarantined').length,
    promoted: learned.promoted.map(route => route.id),
    datasetPath: dataset.path,
    routesPath: store.routesPath
  }, null, 2));
}

async function dataset() {
  const directory = resolve(process.cwd(), flag('--dir', '.jbrancher'));
  const includeUnknown = !process.argv.includes('--success-only');
  const store = createLocalLearningStore({ directory });
  const traces = await store.readTraces();
  const exported = await store.writeDataset({ includeUnknown });
  const outcomes = traces.reduce((counts, trace) => {
    const outcome = trace.outcome || 'unknown';
    counts[outcome] = (counts[outcome] || 0) + 1;
    return counts;
  }, {});
  const resolutions = traces.reduce((counts, trace) => {
    const resolution = trace.routeResolution || trace.metadata?.routeResolution || 'unknown';
    counts[resolution] = (counts[resolution] || 0) + 1;
    return counts;
  }, {});
  console.log(JSON.stringify({
    directory,
    traces: traces.length,
    datasetExamples: exported.examples.length,
    reusableExamples: exported.examples.filter(example => example.reusable).length,
    outcomes,
    resolutions,
    datasetPath: exported.path,
    routesPath: store.routesPath
  }, null, 2));
}

async function preferences() {
  const directory = resolve(process.cwd(), flag('--dir', '.jbrancher'));
  const store = createLocalLearningStore({ directory });
  const records = await store.readPreferences();
  const counts = records.reduce((result, preference) => {
    const status = preference.status || 'unknown';
    result[status] = (result[status] || 0) + 1;
    return result;
  }, {});
  console.log(JSON.stringify({
    directory,
    preferencesPath: store.preferencesPath,
    counts,
    preferences: records
  }, null, 2));
}

async function main() {
  const command = process.argv[2] ?? 'help';
  if (command === 'help' || command === '--help' || command === '-h') return printHelp();
  if (command === 'demo') return import('../examples/demo.js');
  if (command === 'wrap') {
    const isCodex = process.argv[3] === 'codex';
    const options = (isCodex ? parseCodexArgs : parseClaudeArgs)(process.argv.slice(3));
    loadDotEnv();
    process.exitCode = await (isCodex ? wrapCodex : wrapClaude)(options);
    return;
  }
  if (command === 'doctor') {
    const envLoaded = loadDotEnv();
    const nodeMajor = Number(process.versions.node.split('.')[0]);
    const report = { node: process.versions.node, nodeSupported: nodeMajor >= 20,
      envFileFound: envLoaded, typesafeKeyConfigured: Boolean(process.env.TYPESAFE_API_KEY) };
    console.log(JSON.stringify(report, null, 2));
    if (!report.nodeSupported || !report.typesafeKeyConfigured) process.exitCode = 1;
    return;
  }
  if (command === 'learn') return learn();
  if (command === 'dataset') return dataset();
  if (command === 'preferences') return preferences();
  if (command === 'proxy') return proxy();
  if (command === 'live-check') return liveCheck();
  throw new Error(`Unknown command: ${command}`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
