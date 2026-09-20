import { optimizeContext } from '../src/context.js';

const cases = [
  {
    id: 'parser-fix',
    task: 'Fix the parser and make the failing test pass.',
    requiredIds: ['task'],
    items: [
      { id: 'task', text: 'The user task and acceptance criteria.', tokens: 120, required: true, oracleScore: 1 },
      { id: 'failing-test', text: 'The failing test output and assertion.', tokens: 260, oracleScore: 0.96 },
      { id: 'parser-source', text: 'The parser implementation under repair.', tokens: 420, oracleScore: 0.91 },
      { id: 'api-contract', text: 'The public API contract and examples.', tokens: 180, oracleScore: 0.79 },
      { id: 'old-changelog', text: 'An unrelated historical changelog.', tokens: 310, oracleScore: 0.18 },
      { id: 'vendor-readme', text: 'A dependency README not used by this task.', tokens: 380, oracleScore: 0.11 }
    ],
    relevant: ['task', 'failing-test', 'parser-source', 'api-contract']
  },
  {
    id: 'cli-regression',
    task: 'Fix the CLI regression while preserving its argument contract.',
    requiredIds: ['task'],
    items: [
      { id: 'task', text: 'The user task and acceptance criteria.', tokens: 110, required: true, oracleScore: 1 },
      { id: 'error-trace', text: 'The current CLI error trace.', tokens: 220, oracleScore: 0.94 },
      { id: 'argument-tests', text: 'Tests describing supported flags.', tokens: 280, oracleScore: 0.92 },
      { id: 'cli-source', text: 'The command parser implementation.', tokens: 360, oracleScore: 0.88 },
      { id: 'unrelated-ui', text: 'A frontend component unrelated to the CLI.', tokens: 450, oracleScore: 0.08 },
      { id: 'old-benchmark', text: 'A stale benchmark from another command.', tokens: 260, oracleScore: 0.22 }
    ],
    relevant: ['task', 'error-trace', 'argument-tests', 'cli-source']
  }
];

const ratios = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4];
const thresholds = [0.5, 0.6, 0.7, 0.75, 0.8, 0.85];

async function runConfig(config) {
  const rows = [];
  for (const item of cases) {
    const totalTokens = item.items.reduce((sum, context) => sum + context.tokens, 0);
    const oracle = new Map(item.items.map(context => [context.id, context.oracleScore]));
    const result = await optimizeContext({
      task: item.task,
      items: item.items,
      requiredIds: item.requiredIds,
      maxTokens: Math.ceil(totalTokens * config.ratio),
      minimumScore: config.threshold,
      evaluate: async ({ items }) => ({
        scores: items.map(context => oracle.get(context.id)),
        usage: [{ provider: 'synthetic-jev', status: 'succeeded' }]
      })
    });
    const selected = new Set(result.items.map(context => context.id));
    const coverage = item.relevant.filter(id => selected.has(id)).length / item.relevant.length;
    rows.push({ id: item.id, baselineTokens: totalTokens, selectedTokens: result.estimatedTokens,
      coverage, selected: [...selected], savedTokens: result.savedTokens });
  }
  const valid = rows.every(row => row.coverage === 1);
  const baselineTokens = rows.reduce((sum, row) => sum + row.baselineTokens, 0);
  const selectedTokens = rows.reduce((sum, row) => sum + row.selectedTokens, 0);
  return { ...config, valid, coverage: rows.reduce((sum, row) => sum + row.coverage, 0) / rows.length,
    baselineTokens, selectedTokens, savedTokens: baselineTokens - selectedTokens, rows };
}

function objective(result) {
  return result.valid ? result.selectedTokens : Number.POSITIVE_INFINITY;
}

function isBetter(candidate, current) {
  const candidateObjective = objective(candidate);
  const currentObjective = objective(current);
  if (candidateObjective !== currentObjective) return candidateObjective < currentObjective;
  // Cross plateaus so a tighter budget or higher threshold can unlock the next gain.
  return candidate.ratioIndex > current.ratioIndex
    || (candidate.ratioIndex === current.ratioIndex && candidate.thresholdIndex > current.thresholdIndex);
}

let current = { ratioIndex: 0, thresholdIndex: 0, ratio: ratios[0], threshold: thresholds[0] };
const baseline = {
  baselineTokens: cases.reduce((sum, item) => sum + item.items.reduce((subtotal, context) => subtotal + context.tokens, 0), 0),
  coverage: 1
};
const accepted = [];
for (let iteration = 0; iteration < 20; iteration++) {
  const neighbors = [];
  for (const delta of [-1, 1]) {
    for (const field of ['ratioIndex', 'thresholdIndex']) {
      const candidate = { ...current, [`${field}`]: current[field] + delta };
      if (candidate.ratioIndex < 0 || candidate.ratioIndex >= ratios.length
        || candidate.thresholdIndex < 0 || candidate.thresholdIndex >= thresholds.length) continue;
      candidate.ratio = ratios[candidate.ratioIndex];
      candidate.threshold = thresholds[candidate.thresholdIndex];
      neighbors.push(candidate);
    }
  }
  const measured = await Promise.all(neighbors.map(runConfig));
  const best = measured.sort((left, right) => objective(left) - objective(right)
    || right.ratioIndex - left.ratioIndex || right.thresholdIndex - left.thresholdIndex)[0];
  const currentResult = await runConfig(current);
  if (!best || !isBetter(best, currentResult)) break;
  current = { ratioIndex: best.ratioIndex, thresholdIndex: best.thresholdIndex,
    ratio: best.ratio, threshold: best.threshold };
  accepted.push({ iteration: iteration + 1, ratio: current.ratio, threshold: current.threshold,
    selectedTokens: best.selectedTokens, coverage: best.coverage });
}
const optimized = await runConfig(current);
const report = {
  benchmark: 'JBrancher context token optimization hill climb',
  caveat: 'Synthetic relevance oracle and estimated context tokens; validates optimizer behavior, not frontier task quality.',
  baseline: { selectedTokens: baseline.baselineTokens, coverage: baseline.coverage },
  optimized: { ratio: optimized.ratio, threshold: optimized.threshold,
    selectedTokens: optimized.selectedTokens, savedTokens: optimized.savedTokens,
    reduction: Number((optimized.savedTokens / optimized.baselineTokens).toFixed(3)), coverage: optimized.coverage },
  accepted,
  rows: optimized.rows
};
if (process.argv.includes('--assert')
  && (!optimized.valid || optimized.coverage < 1 || optimized.selectedTokens >= baseline.baselineTokens)) {
  throw new Error('Token benchmark assertions failed: optimization lost coverage or tokens');
}
console.log(JSON.stringify(report, null, 2));
