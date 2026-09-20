import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalLearningStore, createLearnedRoutes } from '../src/learning.js';
import { createPiRouter } from '../src/pi.js';

const fixturePath = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'swebench-lite-mini.json');
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const repetitions = 5;

const estimateTokens = text => Math.max(1, Math.ceil(text.length / 4));

async function benchmarkInstance(instance, store) {
  const task = `${instance.instance_id}: ${instance.problem_statement}`;
  const action = { toolName: 'read', input: { path: instance.fail_to_pass[0] } };
  let router = createPiRouter({ routes: [] });
  let frontierCalls = 0;
  let handled = 0;
  let savedPromptTokens = 0;
  const rows = [];

  for (let attempt = 1; attempt <= repetitions; attempt++) {
    const result = await router.handle({ task, readFile: async path => `fixture contents for ${path}` });
    const expected = action.input.path;
    const correct = result.routeId ? result.result === `fixture contents for ${expected}` : true;
    if (!result.routeId) {
      frontierCalls++;
      savedPromptTokens += 0;
      await store.appendTrace({ task, cwd: '/swebench-fixture', toolCalls: [{
        toolCallId: `${instance.instance_id}-${attempt}`,
        toolName: action.toolName,
        input: action.input,
        ok: true
      }], outcome: 'success', metadata: { instance_id: instance.instance_id, attempt } });
    } else {
      handled++;
      savedPromptTokens += estimateTokens(task);
    }
    rows.push({ attempt, source: result.source, correct });

    if (attempt === 2) {
      await store.refreshCandidates({ minimumObservations: 2 });
      const candidates = (await store.readRoutes()).filter(route => route.status === 'candidate');
      for (const candidate of candidates) await store.promote(candidate.id);
      router = createPiRouter({ routes: createLearnedRoutes(await store.readRoutes()) });
    }
  }

  return { instance_id: instance.instance_id, frontierCalls, handled, savedPromptTokens, rows };
}

const directory = await mkdtemp(join(process.env.TEMP || process.env.TMP || '.', 'jbrancher-swebench-learning-'));
try {
  const store = createLocalLearningStore({ directory });
  const rows = [];
  for (const instance of fixture.instances) rows.push(await benchmarkInstance(instance, store));
  const baselineFrontierCalls = fixture.instances.length * repetitions;
  const learnedFrontierCalls = rows.reduce((sum, row) => sum + row.frontierCalls, 0);
  const savedPromptTokens = rows.reduce((sum, row) => sum + row.savedPromptTokens, 0);
  const outcomes = rows.flatMap(row => row.rows);
  console.log(JSON.stringify({
    benchmark: 'JBrancher local learning replay on SWE-bench Lite bug prompts',
    source: { url: fixture.sourceUrl, instances: fixture.instances.length, repetitions, retrievedAt: fixture.retrievedAt },
    caveat: 'Routing-efficiency replay using real SWE-bench problem statements and deterministic read traces; not an official SWE-bench patch-resolution score and does not run the Docker harness.',
    baseline: { frontierCalls: baselineFrontierCalls, estimatedPromptTokens: fixture.instances.reduce((sum, instance) => sum + estimateTokens(`${instance.instance_id}: ${instance.problem_statement}`) * repetitions, 0) },
    learned: {
      frontierCalls: learnedFrontierCalls,
      routesPromoted: (await store.readRoutes()).filter(route => route.status === 'active').length,
      routeCoverage: outcomes.every(row => row.correct) ? 1 : 0,
      frontierCallsAvoided: baselineFrontierCalls - learnedFrontierCalls,
      frontierCallReduction: Number(((baselineFrontierCalls - learnedFrontierCalls) / baselineFrontierCalls).toFixed(3)),
      estimatedPromptTokensSaved: savedPromptTokens
    },
    rows
  }, null, 2));
} finally {
  await rm(directory, { recursive: true, force: true });
}
