import { appendFile, mkdir, readFile as readTextFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const clone = value => structuredClone(value);
const SECRET_KEY = /(api[_-]?key|token|password|secret|authorization|cookie)/i;
const SECRET_VALUE = /(Bearer\s+)[A-Za-z0-9._~+/=-]+|(?:sk|key|apikey)[_-][A-Za-z0-9_-]{16,}/gi;

export function redactText(value, maxChars = 2000) {
  if (typeof value !== 'string') return value;
  const redacted = value.replace(SECRET_VALUE, '[REDACTED]');
  return redacted.length > maxChars ? `${redacted.slice(0, maxChars)}…` : redacted;
}

export function redactValue(value, depth = 0) {
  if (depth > 5) return '[TRUNCATED]';
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.slice(0, 50).map(item => redactValue(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [
    key, SECRET_KEY.test(key) ? '[REDACTED]' : redactValue(item, depth + 1)
  ]));
}

export function normalizeTask(value) {
  if (typeof value !== 'string') throw new TypeError('A task string is required');
  return redactText(value, 4000).toLowerCase().replace(/\s+/g, ' ').trim();
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function actionKey(toolName, input) {
  return JSON.stringify(stable({ toolName, input: redactValue(input) }));
}

export function classifyActionSafety(toolName, input = {}) {
  if (toolName === 'read' && typeof input.path === 'string') return 'read-only';
  if (toolName === 'ls' || toolName === 'find' || toolName === 'grep') return 'read-only';
  if (toolName === 'bash' && typeof input.command === 'string') {
    const command = input.command.trim();
    if (/^(git\s+(status(?:\s+--short)?|branch(?:\s+--show-current)?|log(?:\s+--oneline)?|diff(?:\s+--stat)?|rev-parse\s+--show-toplevel)|pwd|node\s+--version)$/.test(command)) {
      return 'read-only';
    }
    if (/^(npm\s+test|pytest(?:\s|$)|python\s+-m\s+pytest(?:\s|$))/.test(command)) return 'verification';
  }
  return 'side-effect-or-unknown';
}

export function classifyTraceSafety(toolCalls = []) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return 'side-effect-or-unknown';
  const safety = toolCalls.map(call => classifyActionSafety(call?.toolName, call?.input));
  if (safety.every(value => value === 'read-only')) return 'read-only';
  if (safety.every(value => value === 'read-only' || value === 'verification')
    && safety.includes('verification')) return 'verification';
  return 'side-effect-or-unknown';
}

function normalizeTrace(trace) {
  if (!trace || typeof trace !== 'object' || typeof trace.task !== 'string') {
    throw new TypeError('Trace requires a task');
  }
  return {
    schemaVersion: 1,
    id: trace.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    createdAt: trace.createdAt || new Date().toISOString(),
    task: redactText(trace.task, 4000),
    taskNormalized: normalizeTask(trace.task),
    cwd: redactText(trace.cwd || '', 1000),
    source: trace.source || 'pi',
    toolCalls: redactValue(trace.toolCalls || []),
    outcome: trace.outcome || 'unknown',
    safety: classifyTraceSafety(trace.toolCalls || []),
    metadata: redactValue(trace.metadata || {})
  };
}

function actionsFromRecord(record) {
  if (Array.isArray(record.action?.actions)) return record.action.actions;
  if (record.action?.toolName) return [record.action];
  return [];
}

async function executeAction(action, { exec, readFile }) {
  if (action.toolName === 'read' && typeof action.input?.path === 'string') {
    if (typeof readFile !== 'function') throw new Error('Pi read execution is unavailable');
    return readFile(action.input.path, action.input.offset, action.input.limit);
  }

  if (action.toolName === 'bash' && classifyActionSafety(action.toolName, action.input) === 'read-only') {
    if (typeof exec !== 'function') throw new Error('Pi command execution is unavailable');
    const result = await exec('bash', ['-lc', action.input.command]);
    if (result.code !== 0) throw new Error(result.stderr || `bash exited with code ${result.code}`);
    return (result.stdout || '').trim() || '(no output)';
  }

  throw new Error(`Learned action is not replayable: ${action.toolName || 'unknown'}`);
}

function routeFromRecord(record) {
  if (record.status !== 'active' || record.matcher?.type !== 'normalized-exact') return null;
  const actions = actionsFromRecord(record);
  if (actions.length === 0 || actions.some(action => classifyActionSafety(action.toolName, action.input) !== 'read-only')) return null;
  const match = ({ task }) => normalizeTask(task) === record.matcher.value;

  return {
    id: record.id,
    description: `Learned read-only workflow (${record.observations} observations)`,
    match,
    run: async ({ exec, readFile }) => {
      const results = [];
      for (const action of actions) {
        results.push(await executeAction(action, { exec, readFile }));
      }
      return results.length === 1 ? results[0] : results;
    }
  };
}

export function createLearnedRoutes(records = []) {
  return records.map(routeFromRecord).filter(Boolean);
}

export function proposeRoutes(traces, { minimumObservations = 2 } = {}) {
  if (!Array.isArray(traces)) throw new TypeError('traces must be an array');
  const groups = new Map();
  for (const trace of traces) {
    if (!trace || trace.outcome !== 'success' || !Array.isArray(trace.toolCalls) || trace.toolCalls.length === 0) continue;
    if (trace.toolCalls.some(call => !call?.toolName || !call.input || call.ok === false)) continue;
    const taskNormalized = trace.taskNormalized || normalizeTask(trace.task || '');
    const actions = trace.toolCalls.map(call => ({ toolName: call.toolName, input: redactValue(call.input) }));
    const key = `${taskNormalized}\n${JSON.stringify(actions.map(action => actionKey(action.toolName, action.input)))}`;
    const group = groups.get(key) || { traces: [], actions };
    group.taskNormalized = taskNormalized;
    group.traces.push(trace);
    groups.set(key, group);
  }

  return [...groups.values()]
    .filter(group => group.traces.length >= minimumObservations)
    .map(group => {
      const first = group.traces[0];
      const safety = classifyTraceSafety(group.actions);
      return {
        schemaVersion: 1,
        id: `learned-${hash(`${group.taskNormalized}\n${JSON.stringify(group.actions)}`)}`,
        status: 'candidate',
        matcher: { type: 'normalized-exact', value: group.taskNormalized },
        action: group.actions.length === 1 ? group.actions[0] : { actions: group.actions },
        safety,
        observations: group.traces.length,
        examples: group.traces.slice(-5).map(trace => trace.task),
        firstSeen: group.traces[0].createdAt,
        lastSeen: group.traces.at(-1).createdAt
      };
    });
}

function datasetSplit(id) {
  const bucket = Number.parseInt(hash(id).slice(0, 2), 16) % 10;
  return bucket === 0 ? 'test' : bucket < 3 ? 'validation' : 'train';
}

export function traceToDatasetExample(trace) {
  if (!trace || typeof trace.task !== 'string') throw new TypeError('Dataset examples require a task');
  const task = redactText(trace.task, 4000);
  const toolCalls = redactValue(trace.toolCalls || []);
  const safety = trace.safety || classifyTraceSafety(toolCalls);
  const id = trace.id || hash(`${task}\n${JSON.stringify(toolCalls)}`);
  return {
    schemaVersion: 1,
    exampleId: id,
    split: datasetSplit(id),
    task,
    taskNormalized: trace.taskNormalized || normalizeTask(task),
    steps: toolCalls,
    outcome: trace.outcome || 'unknown',
    safety,
    reusable: trace.outcome === 'success' && safety === 'read-only',
    source: trace.source || 'pi',
    createdAt: trace.createdAt || null
  };
}

export function buildDataset(traces, { includeUnknown = true } = {}) {
  if (!Array.isArray(traces)) throw new TypeError('traces must be an array');
  return traces
    .filter(trace => includeUnknown || trace?.outcome === 'success')
    .map(traceToDatasetExample);
}

export function createLocalLearningStore({ directory, traceFile = 'traces.jsonl', routeFile = 'routes.json', datasetFile = 'dataset.jsonl' } = {}) {
  if (typeof directory !== 'string' || !directory) throw new TypeError('A learning directory is required');
  const tracesPath = join(directory, traceFile);
  const routesPath = join(directory, routeFile);
  const datasetPath = join(directory, datasetFile);

  async function ensure() { await mkdir(directory, { recursive: true }); }

  async function appendTrace(trace) {
    await ensure();
    const record = normalizeTrace(trace);
    await appendFile(tracesPath, `${JSON.stringify(record)}\n`, 'utf8');
    return record;
  }

  async function readTraces() {
    try {
      const contents = await readTextFile(tracesPath, 'utf8');
      return contents.split(/\r?\n/).filter(Boolean).flatMap(line => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
  }

  async function readRoutes() {
    try {
      const parsed = JSON.parse(await readTextFile(routesPath, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
  }

  async function writeRoutes(routes) {
    await ensure();
    const tempPath = `${routesPath}.tmp-${process.pid}`;
    await writeFile(tempPath, `${JSON.stringify(routes, null, 2)}\n`, 'utf8');
    await rename(tempPath, routesPath);
    return routes;
  }

  async function writeDataset(options = {}) {
    await ensure();
    const examples = buildDataset(await readTraces(), options);
    const tempPath = `${datasetPath}.tmp-${process.pid}`;
    await writeFile(tempPath, examples.map(example => JSON.stringify(example)).join('\n') + (examples.length ? '\n' : ''), 'utf8');
    await rename(tempPath, datasetPath);
    return { path: datasetPath, examples };
  }

  async function refreshCandidates(options = {}) {
    const existing = await readRoutes();
    const existingById = new Map(existing.map(route => [route.id, route]));
    const candidates = proposeRoutes(await readTraces(), options);
    for (const candidate of candidates) {
      const previous = existingById.get(candidate.id);
      existingById.set(candidate.id, previous?.status === 'active' ? previous : { ...previous, ...candidate });
    }
    return writeRoutes([...existingById.values()]);
  }

  async function promote(id, { force = false } = {}) {
    const routes = await readRoutes();
    const route = routes.find(item => item.id === id);
    if (!route) throw new Error(`Unknown learned route: ${id}`);
    if (!force && route.safety !== 'read-only') throw new Error('Only read-only routes can be promoted automatically');
    route.status = 'active';
    route.promotedAt = new Date().toISOString();
    await writeRoutes(routes);
    return route;
  }

  return { directory, tracesPath, routesPath, datasetPath, appendTrace, readTraces, readRoutes, writeRoutes, writeDataset, refreshCandidates, promote };
}
