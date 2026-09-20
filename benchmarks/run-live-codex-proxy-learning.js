#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createJBrancherServer } from '../src/server.js';

const fixturePath = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'swebench-lite-mini.json');
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));

function integerFlag(name, fallback, { min, max }) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? fallback : Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function optionalNumberFlag(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = Number(process.argv[index + 1]);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a number >= 0`);
  return value;
}

function sumUsage(rows) {
  return rows.reduce((total, usage) => ({
    inputTokens: total.inputTokens + (Number.isSafeInteger(usage?.inputTokens) ? usage.inputTokens : 0),
    outputTokens: total.outputTokens + (Number.isSafeInteger(usage?.outputTokens) ? usage.outputTokens : 0)
  }), { inputTokens: 0, outputTokens: 0 });
}

function estimateCost(usage, inputRate, outputRate) {
  if (inputRate === null || outputRate === null) return null;
  return Number(((usage.inputTokens * inputRate + usage.outputTokens * outputRate) / 1_000_000).toFixed(8));
}

function decodeCodexOutput(stdout) {
  let finalText = '';
  let usage = { inputTokens: 0, outputTokens: 0 };
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
      finalText = typeof event.item.text === 'string' ? event.item.text : finalText;
    }
    if (event.type === 'turn.completed' && event.usage) {
      usage = {
        inputTokens: Number.isSafeInteger(event.usage.input_tokens) ? event.usage.input_tokens : 0,
        outputTokens: Number.isSafeInteger(event.usage.output_tokens) ? event.usage.output_tokens : 0
      };
    }
  }
  const objectText = finalText.match(/\{[\s\S]*\}/)?.[0];
  if (!objectText) throw new Error('Codex did not return a JSON decision');
  let decision;
  try { decision = JSON.parse(objectText); } catch { throw new Error('Codex returned malformed decision JSON'); }
  if (!Number.isSafeInteger(decision.choice) || decision.choice < 0) {
    throw new Error('Codex decision did not contain a non-negative integer choice');
  }
  return { choice: decision.choice, usage };
}

async function askCodex({ prompt, cwd, executable = process.platform === 'win32' ? 'codex.exe' : 'codex' }) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [
      'exec', '--json', '--ephemeral', '--skip-git-repo-check',
      '--cd', cwd, '--sandbox', 'read-only', '-'
    ], { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
    child.once('error', () => reject(new Error('Could not launch Codex CLI')));
    child.once('close', (code, signal) => {
      if (code !== 0) {
        reject(new Error(`Codex exited unsuccessfully (${code ?? signal ?? 'unknown'})`));
        return;
      }
      try { resolve(decodeCodexOutput(stdout)); }
      catch (error) {
        const detail = stderr.includes('authentication') ? ' (authentication failed)' : '';
        reject(new Error(`${error.message}${detail}`));
      }
    });
  });
}

function decisionPrompt(task, candidates) {
  return [
    'Choose the safest next inspection route for the software task below.',
    'Do not use tools. Return only one JSON object in the exact form {"choice":0}.',
    'The choice is the zero-based candidate index. Prefer the candidate that directly investigates the reported failure.',
    `TASK:\n${task.slice(0, 12000)}`,
    `CANDIDATES:\n${JSON.stringify(candidates)}`
  ].join('\n\n');
}

function routesFor(instance) {
  return [
    { id: 'read-failing-test', action: { tool: 'read', args: { path: instance.fail_to_pass[0] } },
      description: `Read the failing test named by the bug report: ${instance.fail_to_pass[0]}` },
    { id: 'read-repository-overview', action: { tool: 'read', args: { path: 'README.md' } },
      description: 'Read the repository overview before investigating the specific failure.' }
  ];
}

async function requestJson(baseUrl, pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const json = await response.json();
  if (!response.ok) throw new Error(`${pathname} returned ${response.status}: ${JSON.stringify(json)}`);
  return json;
}

async function runActorOnly({ instance, repetitions, cwd, executable }) {
  const routes = routesFor(instance);
  const task = `${instance.instance_id}: ${instance.problem_statement}`;
  const usage = [];
  const attempts = [];
  for (let attempt = 1; attempt <= repetitions; attempt++) {
    const started = performance.now();
    const result = await askCodex({ cwd, executable,
      prompt: decisionPrompt(task, routes.map(route => ({ id: route.id, description: route.description }))) });
    usage.push(result.usage);
    const selected = routes[result.choice];
    attempts.push({ attempt, source: 'actor', correct: selected?.id === 'read-failing-test',
      elapsedMs: Number((performance.now() - started).toFixed(1)), usage: result.usage });
  }
  return { attempts, usage: sumUsage(usage) };
}

async function runProxy({ instance, repetitions, cwd, learningDirectory, executable }) {
  const routes = routesFor(instance);
  const task = `${instance.instance_id}: ${instance.problem_statement}`;
  const usage = [];
  let actorCalls = 0;
  const service = createJBrancherServer({
    // This benchmark isolates local learning and frontier-actor savings. Jev is
    // deliberately disabled; a real harness can provide it through the proxy.
    apiKey: null,
    learningDirectory,
    learningSource: 'live-codex-proxy-learning'
  });
  const address = await service.listen({ port: 0 });
  const baseUrl = `http://${address.host}:${address.port}`;
  const attempts = [];
  try {
    for (let attempt = 1; attempt <= repetitions; attempt++) {
      const started = performance.now();
      const decision = await requestJson(baseUrl, '/v1/decide', {
        task,
        state: { repository: instance.repo, attempt },
        candidates: routes.map(route => route.action)
      });
      let selected = null;
      let selectedUsage = { inputTokens: 0, outputTokens: 0 };
      let source = 'actor';
      if (decision.source === 'learned') {
        selected = routes.find(route => JSON.stringify(route.action) === JSON.stringify(decision.action));
        source = 'learned';
      } else {
        actorCalls++;
        const result = await askCodex({ cwd, executable,
          prompt: decisionPrompt(task, routes.map(route => ({ id: route.id, description: route.description }))) });
        selected = routes[result.choice];
        selectedUsage = result.usage;
        usage.push(result.usage);
      }
      const correct = selected?.id === 'read-failing-test';
      const feedback = await requestJson(baseUrl, '/v1/episodes', {
        task,
        routeId: decision.routeId,
        source: 'live-codex-proxy-learning',
        routeResolution: source === 'learned' ? 'learned' : 'unmatched',
        metadata: { instanceId: instance.instance_id, attempt },
        toolCalls: selected ? [{
          toolName: selected.action.tool,
          input: selected.action.args,
          ok: correct,
          output: correct ? `fixture contents for ${selected.action.args.path}` : 'wrong route'
        }] : [],
        outcome: correct ? 'success' : 'failure',
        failureReason: correct ? undefined : 'frontier route choice did not match the fixture verifier'
      });
      attempts.push({ attempt, source, correct, routeId: decision.routeId ?? null,
        routeSuccessRecorded: feedback.routeSuccessRecorded,
        elapsedMs: Number((performance.now() - started).toFixed(1)), usage: selectedUsage });
    }
    const learning = await fetch(`${baseUrl}/v1/learning`).then(response => response.json());
    return { attempts, actorCalls, usage: sumUsage(usage), learning };
  } finally {
    await service.close();
  }
}

const instanceCount = integerFlag('--instances', 1, { min: 1, max: fixture.instances.length });
const repetitions = integerFlag('--repetitions', 3, { min: 3, max: 6 });
const inputRate = optionalNumberFlag('--actor-input-rate');
const outputRate = optionalNumberFlag('--actor-output-rate');
if ((inputRate === null) !== (outputRate === null)) throw new Error('Pass both actor rates or neither.');
const instances = fixture.instances.slice(0, instanceCount);
const executable = process.env.JBRANCHER_CODEX_EXECUTABLE || (process.platform === 'win32' ? 'codex.exe' : 'codex');
const root = await mkdtemp(join(tmpdir(), 'jbrancher-live-codex-proxy-'));

try {
  const rows = [];
  for (const instance of instances) {
    const baseline = await runActorOnly({ instance, repetitions, cwd: root, executable });
    const learned = await runProxy({ instance, repetitions, cwd: root,
      learningDirectory: join(root, 'learning', instance.instance_id), executable });
    rows.push({ instance_id: instance.instance_id, baseline, learned,
      learnedRouteCoverage: learned.attempts.slice(2).every(attempt => attempt.source === 'learned' && attempt.correct) });
  }
  const baselineUsage = sumUsage(rows.map(row => row.baseline.usage));
  const learnedUsage = sumUsage(rows.map(row => row.learned.usage));
  const baselineActorCalls = instances.length * repetitions;
  const learnedActorCalls = rows.reduce((total, row) => total + row.learned.actorCalls, 0);
  const baselineCost = estimateCost(baselineUsage, inputRate, outputRate);
  const learnedCost = estimateCost(learnedUsage, inputRate, outputRate);
  const report = {
    benchmark: 'JBrancher live Codex HTTP-proxy learning benchmark',
    actor: executable,
    source: { url: fixture.sourceUrl, instances: instances.length, repetitions },
    caveat: 'Real Codex actor usage with the local HTTP learning proxy and deterministic read execution; not an official SWE-bench patch-resolution score.',
    baselineActorCalls,
    learnedActorCalls,
    actorCallsAvoided: baselineActorCalls - learnedActorCalls,
    actorCallReduction: Number(((baselineActorCalls - learnedActorCalls) / baselineActorCalls).toFixed(3)),
    baselineUsage,
    learnedUsage,
    providerTokensSaved: (baselineUsage.inputTokens + baselineUsage.outputTokens)
      - (learnedUsage.inputTokens + learnedUsage.outputTokens),
    baselineCost,
    learnedCost,
    costSaved: baselineCost === null || learnedCost === null ? null : Number((baselineCost - learnedCost).toFixed(8)),
    taskSuccessPreserved: rows.every(row => row.learned.attempts.every(attempt => attempt.correct)),
    learnedRouteCoverage: rows.every(row => row.learnedRouteCoverage),
    rows
  };
  if (process.argv.includes('--assert')) {
    assert.ok(report.learnedActorCalls < report.baselineActorCalls);
    assert.equal(report.taskSuccessPreserved, true);
    assert.equal(report.learnedRouteCoverage, true);
    assert.ok(rows.every(row => row.learned.learning.successfulReplays >= repetitions - 2));
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
