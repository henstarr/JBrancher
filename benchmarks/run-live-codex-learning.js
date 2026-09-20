import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createJBrancher } from '../src/index.js';
import { createLocalLearningStore } from '../src/learning.js';

const fixturePath = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'swebench-lite-mini.json');
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));

function numericFlag(name, fallback, { min, max }) {
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

async function runActorOnly({ instance, repetitions, cwd, executable }) {
  const routes = routesFor(instance);
  const task = `${instance.instance_id}: ${instance.problem_statement}`;
  const usageRows = [];
  const attempts = [];
  for (let attempt = 1; attempt <= repetitions; attempt++) {
    const started = performance.now();
    const result = await askCodex({
      cwd,
      executable,
      prompt: decisionPrompt(task, routes.map(route => ({ id: route.id, description: route.description })))
    });
    usageRows.push(result.usage);
    const selected = routes[result.choice];
    attempts.push({
      attempt,
      source: 'actor',
      routeId: selected?.id || null,
      correct: selected?.id === 'read-failing-test',
      elapsedMs: Number((performance.now() - started).toFixed(1)),
      usage: result.usage
    });
  }
  return { attempts, usage: sumUsage(usageRows) };
}

async function runJBrancher({ instance, repetitions, cwd, learningDirectory, executable }) {
  const routes = routesFor(instance);
  const task = `${instance.instance_id}: ${instance.problem_statement}`;
  const usageRows = [];
  const store = createLocalLearningStore({ directory: learningDirectory });
  let actorCalls = 0;
  const brancher = createJBrancher({
    getCandidates: async () => routes.map(route => route.action),
    actor: async ({ candidates }) => {
      actorCalls++;
      const result = await askCodex({
        cwd,
        executable,
        prompt: decisionPrompt(task, routes.map(route => ({ id: route.id, description: route.description })))
      });
      const action = candidates[result.choice];
      usageRows.push(result.usage);
      return { action: action || null, usage: [{ provider: 'codex', status: 'succeeded', ...result.usage }] };
    },
    execute: async action => `fixture contents for ${action.args.path}`,
    learningStore: store,
    learningSource: 'live-codex-learning',
    learningOutcome: ({ event }) => event?.decision?.action?.args?.path === instance.fail_to_pass[0]
  });
  const attempts = [];
  for (let attempt = 1; attempt <= repetitions; attempt++) {
    const started = performance.now();
    const result = await brancher.step({ task, state: { repository: instance.repo } });
    attempts.push({
      attempt,
      source: result.decision.source,
      routeId: result.decision.action?.args?.path === instance.fail_to_pass[0] ? 'read-failing-test' : 'read-repository-overview',
      correct: result.decision.action?.args?.path === instance.fail_to_pass[0],
      elapsedMs: Number((performance.now() - started).toFixed(1)),
      usage: result.decision.usage ?? []
    });
  }
  return { attempts, actorCalls, usage: sumUsage(usageRows), routes: await store.readRoutes() };
}

const instanceCount = numericFlag('--instances', 1, { min: 1, max: fixture.instances.length });
const repetitions = numericFlag('--repetitions', 3, { min: 3, max: 6 });
const inputRate = optionalNumberFlag('--actor-input-rate');
const outputRate = optionalNumberFlag('--actor-output-rate');
if ((inputRate === null) !== (outputRate === null)) throw new Error('Pass both actor rates or neither.');
const instances = fixture.instances.slice(0, instanceCount);
const executable = process.env.JBRANCHER_CODEX_EXECUTABLE || (process.platform === 'win32' ? 'codex.exe' : 'codex');
const root = await mkdtemp(join(tmpdir(), 'jbrancher-live-codex-'));

try {
  const rows = [];
  for (const instance of instances) {
    const baseline = await runActorOnly({ instance, repetitions, cwd: root, executable });
    const learned = await runJBrancher({
      instance, repetitions, cwd: root,
      learningDirectory: join(root, 'learning', instance.instance_id), executable
    });
    rows.push({
      instance_id: instance.instance_id,
      baseline,
      learned,
      learnedRouteCoverage: learned.attempts.slice(2).every(attempt => attempt.source === 'learned' && attempt.correct)
    });
  }
  const baselineUsage = sumUsage(rows.flatMap(row => [row.baseline.usage]));
  const learnedUsage = sumUsage(rows.flatMap(row => [row.learned.usage]));
  const baselineActorCalls = instances.length * repetitions;
  const learnedActorCalls = rows.reduce((total, row) => total + row.learned.actorCalls, 0);
  const baselineCost = estimateCost(baselineUsage, inputRate, outputRate);
  const learnedCost = estimateCost(learnedUsage, inputRate, outputRate);
  console.log(JSON.stringify({
    benchmark: 'JBrancher live Codex actor-learning benchmark',
    actor: executable,
    source: { url: fixture.sourceUrl, instances: instances.length, repetitions },
    caveat: 'Real Codex actor usage with deterministic read execution and SWE-bench-derived prompts; not an official SWE-bench patch-resolution score.',
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
  }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
