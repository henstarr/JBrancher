import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createJBrancher } from '../src/index.js';
import { createLocalLearningStore } from '../src/learning.js';

const execFileAsync = promisify(execFile);
const node = process.execPath;
const repetitionsIndex = process.argv.indexOf('--repetitions');
const repetitions = Number(repetitionsIndex === -1 ? 6 : process.argv[repetitionsIndex + 1]);
const assertMode = process.argv.includes('--assert');
if (!Number.isSafeInteger(repetitions) || repetitions < 3 || repetitions > 12) {
  throw new Error('--repetitions must be an integer from 3 to 12');
}

const brokenSource = 'export function add(left, right) { return left + right + 1; }\n';
const fixedSource = 'export function add(left, right) { return left + right; }\n';
const testSource = [
  "import assert from 'node:assert/strict';",
  "import { add } from './src/add.js';",
  'assert.equal(add(2, 3), 5);',
  ''
].join('\n');
const packageSource = '{"type":"module"}\n';
const task = 'Fix the add function regression and run the focused test';
const writeAction = { tool: 'write_file', args: { path: 'src/add.js', content: fixedSource } };
const testAction = { tool: 'run_tests', args: { command: `${node} test.mjs` } };

async function createFixture(root) {
  const workspace = await mkdtemp(join(root, 'workspace-'));
  await mkdir(join(workspace, 'src'), { recursive: true });
  await Promise.all([
    writeFile(join(workspace, 'package.json'), packageSource),
    writeFile(join(workspace, 'src', 'add.js'), brokenSource),
    writeFile(join(workspace, 'test.mjs'), testSource)
  ]);
  return workspace;
}

const root = await mkdtemp(join(tmpdir(), 'jbrancher-verified-patch-'));
const learningDirectory = join(root, 'learning');
const store = createLocalLearningStore({ directory: learningDirectory });
let activeWorkspace;
let frontierCalls = 0;

const brancher = createJBrancher({
  getCandidates: ({ state }) => {
    if (state.phase === 0) return [writeAction];
    if (state.phase === 1) return [testAction];
    return [];
  },
  actor: async ({ candidates }) => {
    if (candidates.length === 0) return { action: null };
    frontierCalls++;
    return { action: candidates[0], usage: [{ provider: 'frontier-fixture', inputTokens: 1500, outputTokens: 100 }] };
  },
  execute: async action => {
    if (action.tool === 'write_file') {
      await writeFile(join(activeWorkspace, action.args.path), action.args.content);
      return { ok: true, changed: action.args.path };
    }
    if (action.tool === 'run_tests') {
      try {
        const result = await execFileAsync(node, ['test.mjs'], { cwd: activeWorkspace, windowsHide: true });
        return { ok: true, output: result.stdout };
      } catch (error) {
        return { ok: false, output: error.stdout || '', error: error.stderr || error.message };
      }
    }
    throw new Error(`Unknown fixture action: ${action.tool}`);
  },
  learningStore: store,
  learningSource: 'verified-patch-benchmark',
  learningCwd: root,
  learningPromotionMode: 'verified',
  learningOutcome: async ({ events }) => {
    const testEvent = [...events].reverse().find(event => event.decision.action?.tool === 'run_tests');
    const source = await readFile(join(activeWorkspace, 'src', 'add.js'), 'utf8');
    return source === fixedSource && testEvent?.result?.ok === true;
  }
});

try {
  const rows = [];
  for (let repetition = 1; repetition <= repetitions; repetition++) {
    activeWorkspace = await createFixture(root);
    const started = performance.now();
    const result = await brancher.run({
      task,
      state: { phase: 0 },
      observe: brancherObserve
    });
    const source = result.learningRouteId
      ? 'learned'
      : result.events.find(event => event.decision.action)?.decision.source || 'abstain';
    const testPassed = (await readFile(join(activeWorkspace, 'src', 'add.js'), 'utf8')) === fixedSource;
    rows.push({
      repetition,
      source,
      frontierCalls: result.learningRouteId ? 0 : 2,
      testPassed,
      steps: result.events.length,
      elapsedMs: Number((performance.now() - started).toFixed(1))
    });
  }

  const routes = await store.readRoutes();
  const learnedReplays = rows.filter(row => row.source === 'learned').length;
  const baselineFrontierCalls = repetitions * 2;
  const report = {
    benchmark: 'JBrancher verified local patch workflow replay',
    task,
    repetitions,
    baselineFrontierCalls,
    actualFrontierCalls: frontierCalls,
    frontierCallsAvoided: baselineFrontierCalls - frontierCalls,
    frontierCallReduction: Number(((baselineFrontierCalls - frontierCalls) / baselineFrontierCalls).toFixed(3)),
    learnedReplays,
    verifiedActiveRoutes: routes.filter(route => route.status === 'active' && route.verified === true).length,
    allPostconditionsPassed: rows.every(row => row.testPassed),
    caveat: 'Real temporary file writes and test execution; deterministic frontier fixture, not an official SWE-bench patch-resolution score.',
    rows
  };
  if (assertMode) {
    assert.ok(frontierCalls < baselineFrontierCalls);
    assert.ok(learnedReplays >= repetitions - 2);
    assert.equal(report.verifiedActiveRoutes, 1);
    assert.equal(report.allPostconditionsPassed, true);
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}

// Keep the state transition in one place so the harness-facing observe hook is
// the same function used by the learned workflow replay and the frontier path.
async function brancherObserve({ state, event }) {
  return {
    ...state,
    phase: event.decision.action ? state.phase + 1 : state.phase
  };
}
