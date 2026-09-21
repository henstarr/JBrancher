#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createJBrancher } from '../src/index.js';
import { createLocalLearningStore } from '../src/learning.js';

function numericFlag(name, fallback, { min, max }) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? fallback : Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function sumUsage(rows) {
  return rows.reduce((total, usage) => ({
    inputTokens: total.inputTokens + (Number.isSafeInteger(usage?.inputTokens) ? usage.inputTokens : 0),
    outputTokens: total.outputTokens + (Number.isSafeInteger(usage?.outputTokens) ? usage.outputTokens : 0)
  }), { inputTokens: 0, outputTokens: 0 });
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
  if (!objectText) throw new Error('Codex did not return a JSON action');
  let decision;
  try { decision = JSON.parse(objectText); } catch { throw new Error('Codex returned malformed action JSON'); }
  if (!decision.action || typeof decision.action.tool !== 'string' || !decision.action.args
    || typeof decision.action.args.query !== 'string') {
    throw new Error('Codex action did not contain tool, args, and query');
  }
  return { action: decision.action, usage };
}

async function askCodex({ task, cwd, executable }) {
  const prompt = [
    'Act as a frontier tool-selection actor for a harness.',
    'Do not use tools. Return only one JSON object in this exact shape:',
    '{"action":{"tool":"lookup","args":{"query":"<query>","scope":"docs"}}}',
    'Copy the query phrase from the task into args.query exactly. Do not explain.',
    `TASK:\n${task}`
  ].join('\n\n');
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

function expectedAction(value) {
  return { tool: 'lookup', args: { query: value, scope: 'docs' } };
}

function flagValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const valueCount = numericFlag('--values', 4, { min: 3, max: 6 });
const shouldAssert = process.argv.includes('--assert');
const authorizationOnly = process.argv.includes('--authorization-only');
const phase = flagValue('--phase', 'all');
const learningDirectoryArg = flagValue('--learning-dir');
if (!['all', 'teach', 'replay'].includes(phase)) throw new Error('--phase must be all, teach, or replay');
if (phase !== 'all' && !learningDirectoryArg) throw new Error('--learning-dir is required for --phase teach or --phase replay');
const values = ['authentication', 'billing', 'payments', 'reliability', 'security', 'performance'].slice(0, valueCount);
const executable = process.env.JBRANCHER_CODEX_EXECUTABLE
  || (process.platform === 'win32' ? 'codex.exe' : 'codex');
const root = await mkdtemp(join(tmpdir(), 'jbrancher-live-codex-template-'));
const learningDirectory = learningDirectoryArg ? resolve(learningDirectoryArg) : join(root, 'learning');

try {
  const baselineUsageRows = [];
  const baselineRows = [];
  if (phase === 'all') {
    for (const value of values) {
      const task = `lookup ${value} in docs`;
      const started = performance.now();
      const result = await askCodex({ task, cwd: root, executable });
      baselineUsageRows.push(result.usage);
      baselineRows.push({
        value,
        correct: JSON.stringify(result.action) === JSON.stringify(expectedAction(value)),
        elapsedMs: Number((performance.now() - started).toFixed(1)),
        usage: result.usage
      });
    }
  }

  const learnedUsageRows = [];
  const learnedRows = [];
  const teachingRows = [];
  const novelRows = [];
  let actorCalls = 0;
  let authorizationCalls = 0;
  const teachingValues = values.slice(0, 2);
  const novelValues = values.slice(2);

  async function runLearnedValue(value, index, phase, attempt) {
    const task = `lookup ${value} in docs`;
    const expected = expectedAction(value);
    const brancher = createJBrancher({
      ...(authorizationOnly ? {} : { getCandidates: async () => [expected] }),
      ...(authorizationOnly ? {
        authorize: async ({ action }) => {
          authorizationCalls++;
          return JSON.stringify(action) === JSON.stringify(expected);
        }
      } : {}),
      actor: async () => {
        actorCalls++;
        const result = await askCodex({ task, cwd: root, executable });
        learnedUsageRows.push(result.usage);
        return { action: result.action, usage: [{ provider: 'codex', status: 'succeeded', ...result.usage }] };
      },
      execute: async action => ({
        correct: JSON.stringify(action) === JSON.stringify(expected),
        output: `lookup results for ${value}`
      }),
      learningDirectory,
      learningSource: 'live-codex-template-learning',
      learningCwd: process.cwd(),
      learningPromotionMode: 'verified',
      learningMinimumObservations: 2,
      learningOutcome: ({ event }) => event?.result?.correct === true
    });
    const started = performance.now();
    const result = await brancher.step({ task, state: { scope: 'docs', index } });
    return {
      value,
      phase,
      attempt,
      source: result.decision.source,
      correct: JSON.stringify(result.decision.action) === JSON.stringify(expected),
      elapsedMs: Number((performance.now() - started).toFixed(1)),
      usage: result.decision.usage ?? []
    };
  }

  // A frontier actor can return a well-formed but wrong action. Treat that as
  // a failed teaching postcondition and retry a bounded number of times rather
  // than crashing the benchmark or allowing bad evidence into the route cache.
  if (phase === 'all' || phase === 'teach') {
    for (const [index, value] of teachingValues.entries()) {
      let verified = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const row = await runLearnedValue(value, index, 'teaching', attempt);
        learnedRows.push(row);
        teachingRows.push(row);
        if (row.source === 'actor' && row.correct) {
          verified = true;
          break;
        }
      }
      if (!verified) throw new Error(`Codex did not produce a verified teaching action for ${value}`);
    }
  }

  if (phase === 'all' || phase === 'replay') {
    for (const [offset, value] of novelValues.entries()) {
      const row = await runLearnedValue(value, offset + teachingValues.length, 'novel', 1);
      learnedRows.push(row);
      novelRows.push(row);
    }
  }

  const store = createLocalLearningStore({ directory: learningDirectory });
  const routes = await store.readRoutes();
  const templateRoutes = routes.filter(route => route.matcher?.type === 'action-template');
  const baselineUsage = sumUsage(baselineUsageRows);
  const learnedUsage = sumUsage(learnedUsageRows);
  const report = {
    benchmark: 'live-Codex-open-world-action-template-learning',
    actor: executable,
    phase,
    learningDirectory,
    authorizationOnly,
    capabilityCatalog: authorizationOnly ? 'omitted' : 'bounded-candidates',
    values,
    baselineActorCalls: phase === 'all' ? values.length : 0,
    learnedActorCalls: actorCalls,
    actorCallsAvoided: values.length - actorCalls,
    actorCallReduction: Number(((values.length - actorCalls) / values.length).toFixed(3)),
    baselineUsage,
    learnedUsage,
    teachingValues,
    novelValues,
    verifiedTeachingEpisodes: teachingRows.filter(row => row.correct).length,
    novelFrontierCalls: novelRows.filter(row => row.source === 'actor').length,
    authorizationChecks: authorizationCalls,
    providerTokensSaved: phase === 'all'
      ? (baselineUsage.inputTokens + baselineUsage.outputTokens)
        - (learnedUsage.inputTokens + learnedUsage.outputTokens)
      : null,
    templateRoutes: templateRoutes.map(route => ({
      id: route.id,
      status: route.status,
      verified: route.verified,
      observations: route.observations,
      matcher: route.matcher
    })),
    baselineTaskSuccessRate: baselineRows.filter(row => row.correct).length / baselineRows.length,
    learnedTaskSuccessRate: learnedRows.filter(row => row.correct).length / learnedRows.length,
    learnedTaskSuccess: learnedRows.every(row => row.correct),
    novelTaskSuccessRate: novelRows.length === 0 ? 1 : novelRows.filter(row => row.correct).length / novelRows.length,
    learnedRouteCoverage: novelRows.length > 0 && novelRows.every(row => row.source === 'learned' && row.correct),
    baselineRows,
    learnedRows,
    caveat: 'Real Codex actor decisions with a deterministic lookup executor; not an official SWE-bench patch-resolution score.'
  };

  if (shouldAssert) {
    // The live baseline is intentionally measured, not treated as an oracle.
    // The learning arm must collect two verified teaching episodes and then
    // serve every novel value locally. In replay-only mode, those teaching
    // episodes came from a prior process and the provider-saving comparison is
    // intentionally reported by the paired runs rather than inferred here.
    if (phase !== 'replay') assert.equal(report.verifiedTeachingEpisodes, teachingValues.length);
    assert.ok(report.learnedTaskSuccess);
    assert.equal(report.novelFrontierCalls, 0);
    if (phase !== 'teach') assert.ok(report.learnedRouteCoverage);
    if (authorizationOnly && phase !== 'teach') assert.ok(report.authorizationChecks > 0);
    assert.equal(templateRoutes.length, 1);
    assert.equal(templateRoutes[0].status, 'active');
    assert.equal(templateRoutes[0].verified, true);
    if (phase === 'all') assert.ok(report.providerTokensSaved > 0);
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
