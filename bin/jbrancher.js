#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createJBrancher } from '../src/index.js';
import { createJevEvaluator } from '../src/jev.js';
import { createJBrancherServer } from '../src/server.js';
import { parseClaudeArgs, wrapClaude } from '../src/claude.js';
import { parseCodexArgs, wrapCodex } from '../src/codex.js';

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
  console.log('Codex batch: jbrancher wrap codex --prompt "task" [--max-evaluations 25] -- [Codex exec options]');
  console.log('Claude Code: jbrancher wrap claude [--mode shadow] [--max-evaluations 25] -- [Claude arguments]');
  console.log(`JBrancher\n\nCommands:\n  demo        Run the offline demo\n  doctor      Check local runtime and credential configuration\n  proxy       Start the language-agnostic decision service\n  live-check  Run three bounded synthetic Jev decisions\n\nProxy:\n  jbrancher proxy --port 8787\n  POST /v1/decide with task, state, history, and candidates\n  GET  /health or /stats\n`);
}

function flag(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] ?? fallback;
}

async function proxy() {
  loadDotEnv();
  if (!process.env.TYPESAFE_API_KEY) {
    throw new Error('TYPESAFE_API_KEY is not configured. Put it in .env or the process environment.');
  }
  const port = Number(flag('--port', '8787'));
  const host = flag('--host', '127.0.0.1');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid --port');
  const service = createJBrancherServer({
    apiKey: process.env.TYPESAFE_API_KEY,
    model: process.env.JBRANCHER_MODEL ?? 'jev-1.13.0',
    timeoutMs: Number(process.env.JBRANCHER_TIMEOUT_MS ?? 5000)
  });
  const address = await service.listen({ host, port });
  console.log(JSON.stringify({ status: 'listening', ...address, endpoints: ['/health', '/stats', '/v1/decide'] }));
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
  if (command === 'proxy') return proxy();
  if (command === 'live-check') return liveCheck();
  throw new Error(`Unknown command: ${command}`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
