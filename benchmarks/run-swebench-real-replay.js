#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createJBrancher } from '../src/index.js';
import { createLocalLearningStore } from '../src/learning.js';

const execFileAsync = promisify(execFile);

const DEFAULT_INSTANCE = 'sqlfluff__sqlfluff-1625';
const DEFAULT_DATASET = 'princeton-nlp/SWE-bench_Lite';
const DEFAULT_TEST_ARGS = ['-m', 'pytest', 'test/cli/commands_test.py::test__cli__command_directed', '-q'];

function value(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function printHelp() {
  console.log(`Real SWE-bench test-boundary replay

Usage:
  npm run bench:swebench-real -- --workspace PATH [options]

The workspace must be a clean checkout at the instance base commit with the
official SWE-bench test_patch applied as uncommitted changes. The benchmark
captures that test diff, creates disposable worktrees, applies the published
gold patch, and runs the real FAIL_TO_PASS test through JBrancher.

Options:
  --workspace PATH       Repository checkout containing the base commit (required)
  --instance ID          Default: ${DEFAULT_INSTANCE}
  --dataset NAME         Default: ${DEFAULT_DATASET}
  --python PATH          Python executable; default: sibling ../venv/Scripts/python.exe when present
  --test-patch PATH      Optional local official test_patch; otherwise fetched from the dataset row
  --test-args ARGS       Space-separated pytest args; default: ${DEFAULT_TEST_ARGS.slice(2).join(' ')}
  --learning-dir PATH    Optional persistent JBrancher dataset directory
  --repetitions N        Default: 4 (range 3..8)
  --assert               Require verified replay and passing tests
`);
}

function parseArgs(valueText, fallback) {
  if (valueText === undefined) return [...fallback];
  const matches = valueText.match(/"[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*'|[^\s]+/g) ?? [];
  return matches.map(token => {
    if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
      return token.slice(1, -1);
    }
    return token;
  });
}

async function run(command, args, options = {}) {
  return execFileAsync(command, args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024, ...options });
}

async function git(worktree, args, options = {}) {
  return run('git', ['-C', worktree, ...args], options);
}

async function fetchInstance(dataset, instanceId) {
  const url = new URL('https://datasets-server.huggingface.co/rows');
  url.searchParams.set('dataset', dataset);
  url.searchParams.set('config', 'default');
  url.searchParams.set('split', 'dev');
  url.searchParams.set('offset', '0');
  url.searchParams.set('length', '100');
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Hugging Face rows request failed (${response.status})`);
  const rows = (await response.json()).rows ?? [];
  const item = rows.find(candidate => candidate.row?.instance_id === instanceId);
  if (!item) throw new Error(`Instance ${instanceId} was not found in ${dataset}/dev`);
  const row = item.row;
  for (const field of ['instance_id', 'repo', 'base_commit', 'test_patch', 'patch', 'problem_statement']) {
    if (typeof row[field] !== 'string') throw new Error(`Instance ${instanceId} is missing ${field}`);
  }
  return row;
}

function actionForPhase(instanceId, phase, testArgs) {
  if (phase === 0) return { tool: 'apply_swebench_fix', args: { instanceId } };
  if (phase === 1) return { tool: 'run_swebench_test', args: { instanceId, testArgs } };
  return null;
}

const workspaceArg = value('--workspace');
if (hasFlag('--help') || hasFlag('-h')) {
  printHelp();
  process.exit(0);
}
if (!workspaceArg) {
  printHelp();
  process.exitCode = 2;
} else {
  const workspace = resolve(workspaceArg);
  const instanceId = value('--instance', DEFAULT_INSTANCE);
  const dataset = value('--dataset', DEFAULT_DATASET);
  const repetitions = Number(value('--repetitions', '4'));
  const testArgs = [...DEFAULT_TEST_ARGS.slice(0, 2), ...parseArgs(value('--test-args'), DEFAULT_TEST_ARGS.slice(2))];
  const testPatchOverride = value('--test-patch');
  const learningDirectoryOverride = value('--learning-dir');
  const siblingVenv = join(dirname(workspace), 'venv', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
  const python = resolve(value('--python', siblingVenv));
  const assertMode = hasFlag('--assert');

  if (!Number.isSafeInteger(repetitions) || repetitions < 3 || repetitions > 8) {
    throw new Error('--repetitions must be an integer from 3 to 8');
  }

  const row = await fetchInstance(dataset, instanceId);
  const head = (await git(workspace, ['rev-parse', 'HEAD'])).stdout.trim();
  if (head !== row.base_commit) {
    throw new Error(`Workspace HEAD ${head} does not match SWE-bench base_commit ${row.base_commit}`);
  }
  const testPatch = testPatchOverride
    ? await readFile(resolve(testPatchOverride), 'utf8')
    : row.test_patch;
  if (!testPatch.trim()) throw new Error('The SWE-bench instance has an empty test_patch');
  await run(python, ['--version']);

  const root = await mkdtemp(join(tmpdir(), 'jbrancher-swebench-real-'));
  const testPatchPath = join(root, 'test.patch');
  const goldPatchPath = join(root, 'gold.patch');
  const learningDirectory = learningDirectoryOverride ? resolve(learningDirectoryOverride) : join(root, 'learning');
  await writeFile(testPatchPath, testPatch);
  await writeFile(goldPatchPath, row.patch);
  const store = createLocalLearningStore({ directory: learningDirectory });
  let frontierCalls = 0;
  let activeWorktree = '';

  const brancher = createJBrancher({
    authorize: async ({ action }) => action?.args?.instanceId === instanceId
      && (action.tool === 'apply_swebench_fix' || action.tool === 'run_swebench_test'),
    actor: async ({ state }) => {
      frontierCalls++;
      return {
        action: actionForPhase(instanceId, state.phase, testArgs),
        usage: [{ provider: 'fixture-actor', inputTokens: 0, outputTokens: 0 }]
      };
    },
    execute: async action => {
      if (action.tool === 'apply_swebench_fix') {
        await git(activeWorktree, ['apply', '--whitespace=nowarn', goldPatchPath]);
        return { ok: true, action: action.tool };
      }
      if (action.tool === 'run_swebench_test') {
        const started = performance.now();
        try {
          const result = await run(python, testArgs, {
            cwd: activeWorktree,
            env: {
              ...process.env,
              PY_COLORS: '0',
              TERM: 'dumb',
              PYTHONPATH: [join(activeWorktree, 'src'), process.env.PYTHONPATH].filter(Boolean).join(process.platform === 'win32' ? ';' : ':')
            }
          });
          return {
            ok: true,
            action: action.tool,
            exitCode: 0,
            elapsedMs: Number((performance.now() - started).toFixed(1)),
            output: `${result.stdout}${result.stderr}`.slice(-4000)
          };
        } catch (error) {
          return {
            ok: false,
            action: action.tool,
            exitCode: error.code ?? 1,
            elapsedMs: Number((performance.now() - started).toFixed(1)),
            output: `${error.stdout ?? ''}${error.stderr ?? error.message ?? ''}`.slice(-4000)
          };
        }
      }
      throw new Error(`Unknown benchmark action: ${action.tool}`);
    },
    learningStore: store,
    learningSource: 'swebench-real-replay',
    learningCwd: workspace,
    learningMetadata: { dataset, instanceId, baseCommit: row.base_commit, repo: row.repo },
    learningPromotionMode: 'verified',
    learningMinimumObservations: 2,
    maxSteps: 2,
    learningOutcome: async ({ events }) => {
      const patchEvent = events.find(event => event.decision.action?.tool === 'apply_swebench_fix');
      const testEvent = events.find(event => event.decision.action?.tool === 'run_swebench_test');
      return patchEvent?.result?.ok === true && testEvent?.result?.ok === true;
    }
  });

  const rows = [];
  try {
    for (let repetition = 1; repetition <= repetitions; repetition++) {
      activeWorktree = join(root, `worktree-${repetition}`);
      await git(workspace, ['worktree', 'add', '--detach', activeWorktree, row.base_commit]);
      try {
        await git(activeWorktree, ['apply', '--whitespace=nowarn', testPatchPath]);
        const started = performance.now();
        const result = await brancher.run({
          task: `${instanceId}: ${row.problem_statement}`,
          state: { phase: 0 },
          observe: async ({ state, event }) => ({
            ...state,
            phase: event.decision.action ? state.phase + 1 : state.phase
          })
        });
        const testEvent = [...result.events].reverse().find(event => event.decision.action?.tool === 'run_swebench_test');
        rows.push({
          repetition,
          source: result.learningRouteId ? 'learned' : result.events.find(event => event.decision.action)?.decision.source ?? 'abstain',
          frontierCalls: result.learningRouteId ? 0 : result.events.filter(event => event.decision.source === 'actor').length,
          testPassed: testEvent?.result?.ok === true,
          testElapsedMs: testEvent?.result?.elapsedMs ?? null,
          testOutput: testEvent?.result?.output ?? '',
          steps: result.events.length,
          elapsedMs: Number((performance.now() - started).toFixed(1))
        });
      } finally {
        await git(workspace, ['worktree', 'remove', '--force', activeWorktree]).catch(() => {});
        await rm(activeWorktree, { recursive: true, force: true }).catch(() => {});
      }
    }

    const routes = await store.readRoutes();
    const baselineFrontierCalls = repetitions * 2;
    const learnedReplays = rows.filter(item => item.source === 'learned').length;
    const report = {
      benchmark: 'JBrancher real SWE-bench test-boundary replay',
      dataset,
      instanceId,
      repository: row.repo,
      baseCommit: row.base_commit,
      repetitions,
      testArgs,
      testPatchSource: testPatchOverride ? resolve(testPatchOverride) : 'live dataset row',
      learningDirectory,
      baselineFrontierCalls,
      actualFrontierCalls: frontierCalls,
      frontierCallsAvoided: baselineFrontierCalls - frontierCalls,
      frontierCallReduction: Number(((baselineFrontierCalls - frontierCalls) / baselineFrontierCalls).toFixed(3)),
      learnedReplays,
      verifiedActiveRoutes: routes.filter(route => route.status === 'active' && route.verified === true).length,
      testPasses: rows.filter(item => item.testPassed).length,
      testSuccessRate: Number((rows.filter(item => item.testPassed).length / rows.length).toFixed(3)),
      providerUsageMeasured: false,
      caveat: 'Real disposable git worktrees, official SWE-bench test_patch/gold patch, and pytest postcondition. This validates replay and task-boundary wiring; it is not autonomous patch generation or an official SWE-bench resolution score.',
      rows
    };
    if (assertMode) {
      assert.equal(report.testPasses, repetitions);
      assert.ok(frontierCalls < baselineFrontierCalls);
      assert.ok(learnedReplays >= repetitions - 2);
      assert.equal(report.verifiedActiveRoutes, 1);
    }
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
