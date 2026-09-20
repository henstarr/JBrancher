import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalLearningStore, createLearnedRoutes } from '../src/learning.js';
import { createPiRouter } from '../src/pi.js';

const fixturePath = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'swebench-lite-mini.json');
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const repetitions = 8;
const warmupAttempts = 4;

const estimateTokens = text => Math.max(1, Math.ceil(text.length / 4));

function benchmarkTasks(instance) {
  const task = `${instance.instance_id}: ${instance.problem_statement}`;
  return {
    task,
    warmup: [
      task,
      `Open the relevant test file and inspect this bug: ${task}`
    ],
    reuse: `Please open the relevant test file to investigate this issue: ${task}`
  };
}

async function benchmarkInstance(instance, store) {
  const tasks = benchmarkTasks(instance);
  const action = { toolName: 'read', input: { path: instance.fail_to_pass[0] } };
  let router = createPiRouter({ routes: [] });
  let frontierCalls = 0;
  let handled = 0;
  let savedPromptTokens = 0;
  const rows = [];

  for (let attempt = 1; attempt <= repetitions; attempt++) {
    const taskForAttempt = attempt <= warmupAttempts
      ? tasks.warmup[(attempt - 1) % tasks.warmup.length]
      : tasks.reuse;
    const result = await router.handle({ task: taskForAttempt, readFile: async path => `fixture contents for ${path}` });
    const expected = action.input.path;
    const correct = result.routeId ? result.result === `fixture contents for ${expected}` : true;
    if (!result.routeId) {
      frontierCalls++;
      savedPromptTokens += 0;
      await store.appendTrace({ task: taskForAttempt, cwd: '/swebench-fixture', toolCalls: [{
        toolCallId: `${instance.instance_id}-${attempt}`,
        toolName: action.toolName,
        input: action.input,
        ok: true
      }], outcome: 'success', metadata: { instance_id: instance.instance_id, attempt } });
    } else {
      handled++;
      savedPromptTokens += estimateTokens(taskForAttempt);
    }
    rows.push({ attempt, taskVariant: taskForAttempt === tasks.task ? 'base' : 'paraphrase', source: result.source, correct });

    if (attempt === warmupAttempts) {
      await store.refreshCandidates({ minimumObservations: 2 });
      const candidates = (await store.readRoutes()).filter(route => route.status === 'candidate');
      for (const candidate of candidates) await store.promote(candidate.id);
      router = createPiRouter({ routes: createLearnedRoutes(await store.readRoutes()) });
    }
  }

  return { instance_id: instance.instance_id, frontierCalls, handled, savedPromptTokens, rows };
}

async function benchmarkPathTemplate(store) {
  const warmup = [
    ['read package.json', 'package.json'],
    ['open README.md', 'README.md']
  ];
  for (const [task, path] of warmup) {
    await store.appendTrace({ task, cwd: '/path-template-fixture', toolCalls: [{
      toolName: 'read', input: { path }, ok: true
    }], outcome: 'success' });
  }
  const routes = await store.refreshCandidates({ minimumObservations: 2 });
  for (const route of routes.filter(item => item.status === 'candidate' && item.matcher?.type === 'read-path')) {
    await store.promote(route.id);
  }
  const router = createPiRouter({ routes: createLearnedRoutes(await store.readRoutes()) });
  const result = await router.handle({
    task: 'inspect src/index.js',
    readFile: async path => `fixture contents for ${path}`
  });
  return {
    warmupFrontierCalls: warmup.length,
    unseenPathSource: result.source,
    unseenPathHandled: result.source === 'deterministic',
    unseenPathResult: result.result
  };
}

const directory = await mkdtemp(join(process.env.TEMP || process.env.TMP || '.', 'jbrancher-swebench-learning-'));
try {
  const store = createLocalLearningStore({ directory: join(directory, 'swebench') });
  const pathTemplateStore = createLocalLearningStore({ directory: join(directory, 'path-template') });
  const rows = [];
  for (const instance of fixture.instances) rows.push(await benchmarkInstance(instance, store));
  const baselineFrontierCalls = fixture.instances.length * repetitions;
  const learnedFrontierCalls = rows.reduce((sum, row) => sum + row.frontierCalls, 0);
  const savedPromptTokens = rows.reduce((sum, row) => sum + row.savedPromptTokens, 0);
  const outcomes = rows.flatMap(row => row.rows);
  const pathTemplate = await benchmarkPathTemplate(pathTemplateStore);
  console.log(JSON.stringify({
    benchmark: 'JBrancher local learning replay on SWE-bench Lite bug prompts',
    source: { url: fixture.sourceUrl, instances: fixture.instances.length, repetitions, warmupAttempts, retrievedAt: fixture.retrievedAt },
    caveat: 'Routing-efficiency replay using real SWE-bench problem statements and deterministic read traces; not an official SWE-bench patch-resolution score and does not run the Docker harness.',
    baseline: {
      frontierCalls: baselineFrontierCalls,
      estimatedPromptTokens: fixture.instances.reduce((sum, instance) => {
        const tasks = benchmarkTasks(instance);
        const warmupTokens = tasks.warmup.reduce((subtotal, task) => subtotal + estimateTokens(task), 0) * (warmupAttempts / tasks.warmup.length);
        const reuseTokens = estimateTokens(tasks.reuse) * (repetitions - warmupAttempts);
        return sum + warmupTokens + reuseTokens;
      }, 0)
    },
    learned: {
      frontierCalls: learnedFrontierCalls,
      routesPromoted: (await store.readRoutes()).filter(route => route.status === 'active').length,
      routeCoverage: outcomes.every(row => row.correct) ? 1 : 0,
      frontierCallsAvoided: baselineFrontierCalls - learnedFrontierCalls,
      frontierCallReduction: Number(((baselineFrontierCalls - learnedFrontierCalls) / baselineFrontierCalls).toFixed(3)),
      estimatedPromptTokensSaved: savedPromptTokens
    },
    pathTemplate,
    rows
  }, null, 2));
} finally {
  await rm(directory, { recursive: true, force: true });
}
