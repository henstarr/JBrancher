import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJBrancher } from '../src/index.js';
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
    rows.push({
      attempt,
      taskVariant: taskForAttempt === tasks.task ? 'base' : 'paraphrase',
      holdout: attempt > warmupAttempts,
      source: result.source,
      handled: Boolean(result.routeId),
      correct
    });

    if (attempt === warmupAttempts) {
      await store.refreshCandidates({ minimumObservations: 2 });
      const candidates = (await store.readRoutes()).filter(route => route.status === 'candidate');
      for (const candidate of candidates) await store.promote(candidate.id);
      router = createPiRouter({ routes: createLearnedRoutes(await store.readRoutes()) });
    }
  }

  const holdoutRows = rows.filter(row => row.holdout);
  return {
    instance_id: instance.instance_id,
    frontierCalls,
    handled,
    savedPromptTokens,
    holdoutRouteCoverage: holdoutRows.length > 0 && holdoutRows.every(row => row.handled),
    rows
  };
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

async function benchmarkGenericHarness(instance, store) {
  const tasks = benchmarkTasks(instance);
  const expectedPaths = [instance.fail_to_pass[0], 'README.md'];
  let actorCalls = 0;
  const brancher = createJBrancher({
    getCandidates: async ({ state }) => state.phase === 0
      ? [{ tool: 'read', args: { path: expectedPaths[0] } }]
      : state.phase === 1 ? [{ tool: 'read', args: { path: expectedPaths[1] } }] : [],
    actor: async ({ state }) => {
      actorCalls++;
      if (state.phase === 0) return { action: { tool: 'read', args: { path: expectedPaths[0] } } };
      if (state.phase === 1) return { action: { tool: 'read', args: { path: expectedPaths[1] } } };
      return { action: null };
    },
    execute: async action => `fixture contents for ${action.args.path}`,
    learningStore: store,
    learningSource: 'benchmark-harness'
  });
  const rows = [];
  for (let attempt = 1; attempt <= repetitions; attempt++) {
    const task = attempt <= warmupAttempts
      ? tasks.warmup[(attempt - 1) % tasks.warmup.length]
      : tasks.reuse;
    const result = await brancher.run({
      task,
      state: { phase: 0 },
      observe: async ({ state }) => ({ phase: state.phase + 1 })
    });
    rows.push({
      attempt,
      holdout: attempt > warmupAttempts,
      sources: result.events.map(event => event.decision.source),
      learnedSteps: result.events.filter(event => event.decision.source === 'learned').length,
      correct: result.events.length >= expectedPaths.length
        && result.events.slice(0, expectedPaths.length).every((event, index) =>
          event.result === `fixture contents for ${expectedPaths[index]}`)
    });
  }
  const holdoutRows = rows.filter(row => row.holdout);
  return {
    instance_id: instance.instance_id,
    baselineActorCalls: repetitions * (expectedPaths.length + 1),
    actorCalls,
    learnedCalls: repetitions * (expectedPaths.length + 1) - actorCalls,
    holdoutLearnedStepCoverage: holdoutRows.length > 0
      && holdoutRows.every(row => row.learnedSteps >= expectedPaths.length),
    rows
  };
}

async function benchmarkVerifiedWorkflow(store) {
  let actorCalls = 0;
  const brancher = createJBrancher({
    getCandidates: async () => [{ tool: 'write', args: { path: 'out.txt', content: 'verified' } }],
    actor: async () => {
      actorCalls++;
      return { action: { tool: 'write', args: { path: 'out.txt', content: 'verified' } } };
    },
    execute: async () => ({ written: true }),
    learningStore: store,
    learningSource: 'verified-learning-benchmark',
    learningPromotionMode: 'verified',
    learningOutcome: ({ event }) => event?.result?.written === true
  });
  const rows = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await brancher.step({ task: 'apply the verified fixture update' });
    rows.push({ attempt, source: result.decision.source, correct: result.result?.written === true });
  }
  return {
    baselineActorCalls: rows.length,
    actorCalls,
    actorCallsAvoided: rows.length - actorCalls,
    actorCallReduction: Number(((rows.length - actorCalls) / rows.length).toFixed(3)),
    routeCoverage: rows.every(row => row.correct) ? 1 : 0,
    activeVerifiedRoutes: (await store.readRoutes()).filter(route => route.status === 'active' && route.verified).length,
    rows
  };
}

const directory = await mkdtemp(join(process.env.TEMP || process.env.TMP || '.', 'jbrancher-swebench-learning-'));
try {
  const store = createLocalLearningStore({ directory: join(directory, 'swebench') });
  const pathTemplateStore = createLocalLearningStore({ directory: join(directory, 'path-template') });
  const genericStore = createLocalLearningStore({ directory: join(directory, 'generic-harness') });
  const verifiedStore = createLocalLearningStore({ directory: join(directory, 'verified-harness') });
  const rows = [];
  const genericRows = [];
  for (const instance of fixture.instances) rows.push(await benchmarkInstance(instance, store));
  for (const instance of fixture.instances) genericRows.push(await benchmarkGenericHarness(instance, genericStore));
  const baselineFrontierCalls = fixture.instances.length * repetitions;
  const learnedFrontierCalls = rows.reduce((sum, row) => sum + row.frontierCalls, 0);
  const savedPromptTokens = rows.reduce((sum, row) => sum + row.savedPromptTokens, 0);
  const outcomes = rows.flatMap(row => row.rows);
  const genericBaselineActorCalls = genericRows.reduce((sum, row) => sum + row.baselineActorCalls, 0);
  const genericLearnedActorCalls = genericRows.reduce((sum, row) => sum + row.actorCalls, 0);
  const pathTemplate = await benchmarkPathTemplate(pathTemplateStore);
  const verifiedWorkflow = await benchmarkVerifiedWorkflow(verifiedStore);
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
      routeCoverage: rows.every(row => row.holdoutRouteCoverage) ? 1 : 0,
      holdoutAttempts: outcomes.filter(row => row.holdout).length,
      holdoutHandled: outcomes.filter(row => row.holdout && row.handled).length,
      frontierCallsAvoided: baselineFrontierCalls - learnedFrontierCalls,
      frontierCallReduction: Number(((baselineFrontierCalls - learnedFrontierCalls) / baselineFrontierCalls).toFixed(3)),
      estimatedPromptTokensSaved: savedPromptTokens
    },
    genericHarness: {
      baselineActorCalls: genericBaselineActorCalls,
      learnedActorCalls: genericLearnedActorCalls,
      actorCallsAvoided: genericBaselineActorCalls - genericLearnedActorCalls,
      actorCallReduction: Number(((genericBaselineActorCalls - genericLearnedActorCalls)
        / genericBaselineActorCalls).toFixed(3)),
      routeCoverage: genericRows.every(row => row.holdoutLearnedStepCoverage) ? 1 : 0,
      holdoutLearnedStepCoverage: genericRows.filter(row => row.holdoutLearnedStepCoverage).length
        / genericRows.length,
      rows: genericRows
    },
    verifiedHarness: verifiedWorkflow,
    pathTemplate,
    rows
  }, null, 2));
} finally {
  await rm(directory, { recursive: true, force: true });
}
