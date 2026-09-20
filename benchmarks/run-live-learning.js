import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJBrancher } from '../src/index.js';
import { createJevEvaluator } from '../src/jev.js';
import { loadDotEnv } from '../src/env.js';
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

function optionalNumberFlag(name, { min = 0 } = {}) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = Number(process.argv[index + 1]);
  if (!Number.isFinite(value) || value < min) throw new Error(`${name} must be a number >= ${min}`);
  return value;
}

function sumUsage(rows) {
  return rows.reduce((total, usage) => ({
    inputTokens: total.inputTokens + (Number.isSafeInteger(usage.inputTokens) ? usage.inputTokens : 0),
    outputTokens: total.outputTokens + (Number.isSafeInteger(usage.outputTokens) ? usage.outputTokens : 0)
  }), { inputTokens: 0, outputTokens: 0 });
}

function addUsage(left, right) {
  if (!left || !right) return null;
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens
  };
}

function assumedUsage(calls, inputTokens, outputTokens) {
  if (inputTokens === null || outputTokens === null) return null;
  return { inputTokens: calls * inputTokens, outputTokens: calls * outputTokens };
}

function estimateCost(usage, rates) {
  if (!usage || !rates) return null;
  return Number(((usage.inputTokens * rates.input + usage.outputTokens * rates.output) / 1_000_000).toFixed(8));
}

loadDotEnv();
if (!process.env.TYPESAFE_API_KEY) {
  throw new Error('TYPESAFE_API_KEY is not configured. Put it in .env or the process environment.');
}

const instanceCount = numericFlag('--instances', 1, { min: 1, max: fixture.instances.length });
const repetitions = numericFlag('--repetitions', 4, { min: 3, max: 10 });
const actorInputTokens = optionalNumberFlag('--actor-input-tokens');
const actorOutputTokens = optionalNumberFlag('--actor-output-tokens');
if ((actorInputTokens === null) !== (actorOutputTokens === null)) {
  throw new Error('Pass both --actor-input-tokens and --actor-output-tokens, or neither.');
}
const actorRates = {
  input: optionalNumberFlag('--actor-input-rate'),
  output: optionalNumberFlag('--actor-output-rate')
};
const jevRates = {
  input: optionalNumberFlag('--jev-input-rate'),
  output: optionalNumberFlag('--jev-output-rate')
};
const anyRate = [...Object.values(actorRates), ...Object.values(jevRates)].some(value => value !== null);
const allRates = [...Object.values(actorRates), ...Object.values(jevRates)].every(value => value !== null);
if (anyRate && !allRates) throw new Error('Pass all four input/output rates, or none.');
const instances = fixture.instances.slice(0, instanceCount);
const directory = await mkdtemp(join(process.env.TEMP || process.env.TMP || '.', 'jbrancher-live-learning-'));
const usageRows = [];
const actorUsageRows = [];
let evaluatorCalls = 0;
let actorCalls = 0;
const evaluateWithUsage = createJevEvaluator({
  apiKey: process.env.TYPESAFE_API_KEY,
  model: process.env.JBRANCHER_MODEL ?? 'jev-1.13.0',
  timeoutMs: Number(process.env.JBRANCHER_TIMEOUT_MS ?? 10_000)
});

try {
  const rows = [];
  for (const instance of instances) {
    const store = createLocalLearningStore({ directory: join(directory, instance.instance_id) });
    const task = `${instance.instance_id}: ${instance.problem_statement}`;
    const action = { tool: 'read', args: { path: instance.fail_to_pass[0] } };
    const brancher = createJBrancher({
      getCandidates: async () => [action],
      evaluate: async input => {
        evaluatorCalls++;
        const result = await evaluateWithUsage(input);
        usageRows.push(...(result.usage || []));
        return result;
      },
      actor: async () => {
        actorCalls++;
        const usage = actorInputTokens === null ? [] : [{ provider: 'synthetic-actor-assumption',
          status: 'assumed', inputTokens: actorInputTokens, outputTokens: actorOutputTokens }];
        actorUsageRows.push(...usage);
        return { action, usage };
      },
      execute: async selected => `fixture contents for ${selected.args.path}`,
      learningStore: store,
      learningSource: 'live-learning-benchmark',
      learningOnlyFallback: false
    });
    const attempts = [];
    let instanceActorCalls = 0;
    let instanceEvaluatorCalls = 0;
    for (let attempt = 1; attempt <= repetitions; attempt++) {
      const actorCallsBefore = actorCalls;
      const evaluatorCallsBefore = evaluatorCalls;
      const startedAt = performance.now();
      const result = await brancher.step({ task, state: { repository: instance.repo } });
      attempts.push({
        attempt,
        source: result.decision.source,
        correct: result.result === `fixture contents for ${action.args.path}`,
        actorCalls: actorCalls - actorCallsBefore,
        evaluatorCalls: evaluatorCalls - evaluatorCallsBefore,
        elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
        usage: result.decision.evaluation?.usage ?? []
      });
      instanceActorCalls += actorCalls - actorCallsBefore;
      instanceEvaluatorCalls += evaluatorCalls - evaluatorCallsBefore;
    }
    rows.push({
      instance_id: instance.instance_id,
      baselineJevCalls: repetitions,
      baselineActorCalls: repetitions,
      actorCalls: instanceActorCalls,
      evaluatorCalls: instanceEvaluatorCalls,
      attempts,
      routeCoverage: attempts.slice(2).every(attempt => attempt.source === 'learned' && attempt.correct)
    });
  }
  const usage = sumUsage(usageRows);
  const actorUsage = sumUsage(actorUsageRows);
  const baselineCalls = instances.length * repetitions;
  const savedCalls = baselineCalls - evaluatorCalls;
  const baselineActorUsage = assumedUsage(baselineCalls, actorInputTokens, actorOutputTokens);
  const actualProviderUsage = actorInputTokens === null ? null : addUsage(usage, actorUsage);
  const rates = allRates ? {
    actor: actorRates,
    jev: jevRates
  } : null;
  const baselineCost = rates ? estimateCost(baselineActorUsage, rates.actor) : null;
  const actualCost = rates && actorInputTokens !== null
    ? Number((estimateCost(actorUsage, rates.actor) + estimateCost(usage, rates.jev)).toFixed(8))
    : null;
  const averageInputTokens = evaluatorCalls > 0 ? usage.inputTokens / evaluatorCalls : 0;
  const averageOutputTokens = evaluatorCalls > 0 ? usage.outputTokens / evaluatorCalls : 0;
  const allAttemptsSuccessful = rows.every(row => row.attempts.every(attempt => attempt.correct));
  console.log(JSON.stringify({
    benchmark: 'JBrancher live Jev route-learning benchmark',
    model: process.env.JBRANCHER_MODEL ?? 'jev-1.13.0',
    source: { url: fixture.sourceUrl, instances: instances.length, repetitions },
    caveat: 'Live TypeSafe usage measurement with deterministic read execution; not an official SWE-bench patch-resolution score.',
    baselineJevCalls: baselineCalls,
    actualJevCalls: evaluatorCalls,
    jevCallsAvoided: savedCalls,
    jevCallReduction: Number((savedCalls / baselineCalls).toFixed(3)),
    actorCallsBaseline: baselineCalls,
    actorCallsActual: actorCalls,
    actorCallsAvoided: baselineCalls - actorCalls,
    observedUsage: usage,
    observedActorUsage: actorUsage,
    baselineActorUsage,
    actualProviderUsage,
    pairedComparison: {
      baselineSuccessRate: 1,
      actualSuccessRate: allAttemptsSuccessful ? 1 : 0,
      taskSuccessRatePreserved: allAttemptsSuccessful,
      providerTokensSaved: baselineActorUsage && actualProviderUsage
        ? (baselineActorUsage.inputTokens + baselineActorUsage.outputTokens)
          - (actualProviderUsage.inputTokens + actualProviderUsage.outputTokens)
        : null,
      baselineCost,
      actualCost,
      costSaved: baselineCost === null || actualCost === null
        ? null : Number((baselineCost - actualCost).toFixed(8))
    },
    estimatedAvoidedUsageAtObservedAverage: {
      inputTokens: Math.round(savedCalls * averageInputTokens),
      outputTokens: Math.round(savedCalls * averageOutputTokens)
    },
    routeCoverage: rows.every(row => row.routeCoverage),
    assumptions: {
      actorTokensProvided: actorInputTokens !== null,
      ratesProvided: allRates,
      actorInputTokens,
      actorOutputTokens,
      rates
    },
    rows
  }, null, 2));
} finally {
  await rm(directory, { recursive: true, force: true });
}
