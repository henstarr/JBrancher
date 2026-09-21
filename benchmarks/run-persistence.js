import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
const node = process.execPath;
const assertMode = process.argv.includes('--assert');
const directory = await mkdtemp(join(tmpdir(), 'jbrancher-persistence-'));

const childSource = `
import { createJBrancher } from './src/index.js';
import { createLocalLearningStore } from './src/learning.js';

const store = createLocalLearningStore({ directory: process.env.JBRANCHER_BENCH_DIR });
let actorCalls = 0;
let authorizationChecks = 0;
const action = { tool: 'read', args: { path: 'README.md' } };
const brancher = createJBrancher({
  authorize: async ({ action: candidate }) => {
    authorizationChecks++;
    return candidate?.tool === action.tool && candidate?.args?.path === action.args.path;
  },
  actor: async () => {
    actorCalls++;
    return { action, usage: [{ provider: 'frontier-fixture', inputTokens: 1200, outputTokens: 80 }] };
  },
  execute: async () => ({ ok: true }),
  learningStore: store,
  learningSource: 'persistence-benchmark',
  learningCwd: process.cwd(),
  learningOutcome: () => true
});

const event = await brancher.step({ task: 'read README.md', state: { cwd: process.cwd() } });
const routes = await store.readRoutes();
const traces = await store.readTraces();
console.log(JSON.stringify({
  source: event.decision.source,
  routeResolution: event.decision.routeResolution,
  actorCalls,
  authorizationChecks,
  routeStatuses: routes.map(route => route.status),
  traces: traces.length
}));
`;

try {
  const rows = [];
  for (let processNumber = 0; processNumber < 3; processNumber++) {
    const output = execFileSync(node, ['--input-type=module', '-e', childSource], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, JBRANCHER_BENCH_DIR: directory }
    });
    rows.push(JSON.parse(output.trim()));
  }

  const sources = rows.map(row => row.source);
  const actorCalls = rows.map(row => row.actorCalls);
  const authorizationChecks = rows.map(row => row.authorizationChecks);
  const finalRow = rows.at(-1);
  const files = await readdir(directory);
  const passed = JSON.stringify(sources) === JSON.stringify(['actor', 'actor', 'learned'])
    && JSON.stringify(actorCalls) === JSON.stringify([1, 1, 0])
    && finalRow.authorizationChecks > 0
    && finalRow.routeStatuses.includes('active')
    && finalRow.traces === 2
    && files.includes('traces.jsonl')
    && files.includes('routes.json');
  const result = {
    benchmark: 'JBrancher local persistence across harness restarts',
    processRestarts: 2,
    candidateEnumeration: false,
    sources,
    actorCalls,
    authorizationChecks,
    finalRouteStatuses: finalRow.routeStatuses,
    durableTraceRows: finalRow.traces,
    localFiles: files.sort(),
    externalDatabase: false,
    passed
  };
  console.log(JSON.stringify(result, null, 2));
  if (assertMode && !passed) process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
