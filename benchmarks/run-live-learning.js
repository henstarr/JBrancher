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

function sumUsage(rows) {
  return rows.reduce((total, usage) => ({
    inputTokens: total.inputTokens + (Number.isSafeInteger(usage.inputTokens) ? usage.inputTokens : 0),
    outputTokens: total.outputTokens + (Number.isSafeInteger(usage.outputTokens) ? usage.outputTokens : 0)
  }), { inputTokens: 0, outputTokens: 0 });
}

loadDotEnv();
if (!process.env.TYPESAFE_API_KEY) {
  throw new Error('TYPESAFE_API_KEY is not configured. Put it in .env or the process environment.');
}

const instanceCount = numericFlag('--instances', 1, { min: 1, max: fixture.instances.length });
const repetitions = numericFlag('--repetitions', 4, { min: 3, max: 10 });
const instances = fixture.instances.slice(0, instanceCount);
const directory = await mkdtemp(join(process.env.TEMP || process.env.TMP || '.', 'jbrancher-live-learning-'));
const usageRows = [];
let evaluatorCalls = 0;
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
      actor: async () => ({ action }),
      execute: async selected => `fixture contents for ${selected.args.path}`,
      learningStore: store,
      learningSource: 'live-learning-benchmark',
      learningOnlyFallback: false
    });
    const attempts = [];
    for (let attempt = 1; attempt <= repetitions; attempt++) {
      const startedAt = performance.now();
      const result = await brancher.step({ task, state: { repository: instance.repo } });
      attempts.push({
        attempt,
        source: result.decision.source,
        correct: result.result === `fixture contents for ${action.args.path}`,
        elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
        usage: result.decision.evaluation?.usage ?? []
      });
    }
    rows.push({
      instance_id: instance.instance_id,
      baselineJevCalls: repetitions,
      attempts,
      routeCoverage: attempts.slice(2).every(attempt => attempt.source === 'learned' && attempt.correct)
    });
  }
  const usage = sumUsage(usageRows);
  const baselineCalls = instances.length * repetitions;
  const savedCalls = baselineCalls - evaluatorCalls;
  const averageInputTokens = evaluatorCalls > 0 ? usage.inputTokens / evaluatorCalls : 0;
  const averageOutputTokens = evaluatorCalls > 0 ? usage.outputTokens / evaluatorCalls : 0;
  console.log(JSON.stringify({
    benchmark: 'JBrancher live Jev route-learning benchmark',
    model: process.env.JBRANCHER_MODEL ?? 'jev-1.13.0',
    source: { url: fixture.sourceUrl, instances: instances.length, repetitions },
    caveat: 'Live TypeSafe usage measurement with deterministic read execution; not an official SWE-bench patch-resolution score.',
    baselineJevCalls: baselineCalls,
    actualJevCalls: evaluatorCalls,
    jevCallsAvoided: savedCalls,
    jevCallReduction: Number((savedCalls / baselineCalls).toFixed(3)),
    observedUsage: usage,
    estimatedAvoidedUsageAtObservedAverage: {
      inputTokens: Math.round(savedCalls * averageInputTokens),
      outputTokens: Math.round(savedCalls * averageOutputTokens)
    },
    routeCoverage: rows.every(row => row.routeCoverage),
    rows
  }, null, 2));
} finally {
  await rm(directory, { recursive: true, force: true });
}
