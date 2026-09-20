import { appendFile, mkdir, readFile as readTextFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const SECRET_KEY = /(api[_-]?key|token|password|secret|authorization|cookie)/i;
const SECRET_VALUE = /(Bearer\s+)[A-Za-z0-9._~+/=-]+|(?:sk|key|apikey)[_-][A-Za-z0-9_-]{16,}/gi;
const ROUTE_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'can', 'do', 'for', 'from', 'how', 'i', 'in', 'is',
  'it', 'me', 'my', 'of', 'on', 'or', 'please', 'tell', 'that', 'the', 'this',
  'to', 'what', 'where', 'with', 'you'
]);
const ROUTE_ACTION_WORDS = new Set([
  'check', 'display', 'find', 'get', 'inspect', 'list', 'look', 'open', 'read',
  'show', 'view'
]);
const READ_INTENT = /\b(read|open|show|view|inspect|display|look|list|cat|contents?|inside)\b/i;
const WRITE_INTENT = /\b(delete|remove|write|edit|modify|change|update|create|run|execute|deploy|install)\b/i;
const SENSITIVE_READ_PATH = /(^|[\\/])(?:\.env(?:\.|$)|credentials?(?:\.|$)|secrets?(?:\.|$)|.*\.(?:pem|key|p12|pfx))$/i;

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

function taskTokens(value) {
  return new Set(normalizeTask(value)
    .split(/[^a-z0-9]+/)
    .filter(token => token.length > 1 && !ROUTE_STOP_WORDS.has(token) && !ROUTE_ACTION_WORDS.has(token)));
}

export function taskSimilarity(left, right) {
  const leftTokens = taskTokens(left);
  const rightTokens = taskTokens(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let intersection = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) intersection++;
  return intersection / Math.max(leftTokens.size, rightTokens.size);
}

function normalizePath(value) {
  return String(value).replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

function safeRelativeReadPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) return false;
  if (/^(?:[a-z]:[\\/]|[\\/]{1,2})/i.test(value)) return false;
  if (value.split(/[\\/]/).includes('..')) return false;
  return !SENSITIVE_READ_PATH.test(value);
}

function extractPathFromTask(task) {
  if (typeof task !== 'string' || !READ_INTENT.test(task) || WRITE_INTENT.test(task)) return null;
  const matches = task.match(/(?:\.\.?[\\/])?(?:[A-Za-z0-9_.-]+[\\/])*[A-Za-z0-9_.-]+\.[A-Za-z0-9_-]+/g) || [];
  const path = matches
    .map(value => value.replace(/^[`'\"]|[`'\"),.;:!?]+$/g, ''))
    .find(value => safeRelativeReadPath(value));
  return path || null;
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
  if (toolName === 'read' && typeof input.path === 'string') {
    return safeRelativeReadPath(input.path) ? 'read-only' : 'side-effect-or-unknown';
  }
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

function matchesStoredMatcher(matcher, task) {
  const normalized = normalizeTask(task);
  if (matcher?.type === 'normalized-exact') return normalized === matcher.value;
  if (matcher?.type === 'token-similarity' && Array.isArray(matcher.values)) {
    const minimumScore = Number.isFinite(matcher.minimumScore) ? matcher.minimumScore : 0.8;
    return matcher.values.some(value => taskSimilarity(normalized, value) >= minimumScore);
  }
  if (matcher?.type === 'read-path') {
    const path = extractPathFromTask(task);
    if (!path || matcher.exactTasks?.includes(normalized)) return false;
    return !matcher.exactPaths?.includes(normalizePath(path));
  }
  return false;
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
  if (record.status !== 'active') return null;

  if (record.matcher?.type === 'read-path') {
    const action = record.action;
    if (action?.toolName !== 'read' || !action.input || record.safety !== 'read-only') return null;
    const match = ({ task }) => matchesStoredMatcher(record.matcher, task);
    return {
      id: record.id,
      description: `Learned parameterized file read (${record.observations} observations)`,
      match,
      run: async ({ task, readFile }) => {
        if (typeof readFile !== 'function') throw new Error('Pi read execution is unavailable');
        const path = extractPathFromTask(task);
        if (!path) throw new Error('No safe relative file path found in the task');
        return readFile(path, action.input.offset, action.input.limit);
      }
    };
  }

  const actions = actionsFromRecord(record);
  if (actions.length === 0 || actions.some(action => classifyActionSafety(action.toolName, action.input) !== 'read-only')) return null;
  const match = ({ task }) => matchesStoredMatcher(record.matcher, task);

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

export function proposeRoutes(traces, { minimumObservations = 2, minimumSimilarity = 0.8 } = {}) {
  if (!Array.isArray(traces)) throw new TypeError('traces must be an array');
  const actionGroups = new Map();
  for (const trace of traces) {
    if (!trace || trace.outcome !== 'success' || !Array.isArray(trace.toolCalls) || trace.toolCalls.length === 0) continue;
    if (trace.toolCalls.some(call => !call?.toolName || !call.input || call.ok === false)) continue;
    const taskNormalized = trace.taskNormalized || normalizeTask(trace.task || '');
    const actions = trace.toolCalls.map(call => ({ toolName: call.toolName, input: redactValue(call.input) }));
    const actionSignature = JSON.stringify(actions.map(action => actionKey(action.toolName, action.input)));
    const actionGroup = actionGroups.get(actionSignature) || { actions, variants: new Map() };
    const variant = actionGroup.variants.get(taskNormalized) || { taskNormalized, traces: [] };
    variant.traces.push(trace);
    actionGroup.variants.set(taskNormalized, variant);
    actionGroups.set(actionSignature, actionGroup);
  }

  const candidates = [];
  for (const actionGroup of actionGroups.values()) {
    const variants = [...actionGroup.variants.values()];
    const clusters = [];
    for (const variant of variants) {
      const cluster = clusters.find(item => item.variants.some(existing => taskSimilarity(existing.taskNormalized, variant.taskNormalized) >= minimumSimilarity));
      if (cluster) cluster.variants.push(variant);
      else clusters.push({ variants: [variant] });
    }

    for (const cluster of clusters) {
      const generalized = cluster.variants.length > 1
        && cluster.variants.every(variant => variant.traces.length >= minimumObservations);
      const outputVariants = generalized ? [cluster.variants] : cluster.variants.map(variant => [variant]);
      for (const selectedVariants of outputVariants) {
        const selectedTraces = selectedVariants.flatMap(variant => variant.traces);
        if (selectedTraces.length < minimumObservations) continue;
        const taskValues = selectedVariants.map(variant => variant.taskNormalized);
        const matcher = generalized
          ? { type: 'token-similarity', values: taskValues, minimumScore: minimumSimilarity }
          : { type: 'normalized-exact', value: taskValues[0] };
        const safety = classifyTraceSafety(actionGroup.actions);
        candidates.push({
          schemaVersion: 1,
          id: `learned-${hash(`${JSON.stringify(matcher)}\n${JSON.stringify(actionGroup.actions)}`)}`,
          status: 'candidate',
          matcher,
          action: actionGroup.actions.length === 1 ? actionGroup.actions[0] : { actions: actionGroup.actions },
          safety,
          observations: selectedTraces.length,
          examples: selectedTraces.slice(-5).map(trace => trace.task),
          firstSeen: selectedTraces[0].createdAt,
          lastSeen: selectedTraces.at(-1).createdAt
        });
      }
    }
  }
  return [...candidates, ...proposeReadPathRoutes(traces, { minimumObservations })];
}

function proposeReadPathRoutes(traces, { minimumObservations = 2 } = {}) {
  const groups = new Map();
  for (const trace of traces) {
    if (!trace || trace.outcome !== 'success' || !Array.isArray(trace.toolCalls) || trace.toolCalls.length !== 1) continue;
    const call = trace.toolCalls[0];
    if (call?.toolName !== 'read' || call.ok === false || typeof call.input?.path !== 'string') continue;
    const taskPath = extractPathFromTask(trace.task);
    if (!taskPath || normalizePath(taskPath) !== normalizePath(call.input.path)) continue;
    const action = { toolName: 'read', input: {
      ...(call.input.offset === undefined ? {} : { offset: call.input.offset }),
      ...(call.input.limit === undefined ? {} : { limit: call.input.limit })
    } };
    const key = actionKey(action.toolName, action.input);
    const group = groups.get(key) || { action, traces: [], paths: new Set() };
    group.traces.push(trace);
    group.paths.add(normalizePath(call.input.path));
    groups.set(key, group);
  }

  return [...groups.values()]
    .filter(group => group.traces.length >= minimumObservations && group.paths.size >= 2)
    .map(group => {
      const exactTasks = group.traces.map(trace => trace.taskNormalized || normalizeTask(trace.task));
      const exactPaths = [...group.paths];
      return {
        schemaVersion: 1,
        id: `learned-${hash(`read-path\n${JSON.stringify(group.action)}\n${exactPaths.join('\n')}`)}`,
        status: 'candidate',
        matcher: { type: 'read-path', exactTasks, exactPaths },
        action: group.action,
        safety: 'read-only',
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

function outputPreview(value) {
  if (typeof value === 'string') return redactText(value, 500);
  if (!Array.isArray(value)) return undefined;
  const text = value
    .filter(item => item?.type === 'text' && typeof item.text === 'string')
    .map(item => item.text)
    .join('\n');
  return text ? redactText(text, 500) : undefined;
}

/**
 * Record one harness episode using the same lifecycle shape as Pi.
 * Adapters can feed tool events here without depending on Pi internals.
 */
export function createEpisodeRecorder({ store, task, cwd = '', source = 'harness', metadata = {} } = {}) {
  if (!store || typeof store.appendTrace !== 'function') throw new TypeError('A learning store is required');
  if (typeof task !== 'string') throw new TypeError('A task string is required');
  const episode = {
    task,
    cwd,
    source,
    startedAt: new Date().toISOString(),
    toolCalls: []
  };
  let finished = false;
  let saved;

  function recordToolCall(event = {}) {
    if (finished || typeof event.toolName !== 'string') return;
    episode.toolCalls.push({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.input
    });
  }

  function recordToolResult(event = {}) {
    if (finished) return;
    const call = episode.toolCalls.find(item => item.toolCallId === event.toolCallId);
    if (!call) return;
    call.ok = !event.isError;
    call.output = outputPreview(event.output ?? event.content);
  }

  async function finish({ outcome, metadata: finishMetadata = {} } = {}) {
    if (finished) return saved;
    const resolvedOutcome = outcome || (episode.toolCalls.length > 0
      && episode.toolCalls.every(call => call.ok === true) ? 'success' : 'unknown');
    saved = await store.appendTrace({
      ...episode,
      outcome: resolvedOutcome,
      metadata: { ...metadata, ...finishMetadata }
    });
    finished = true;
    return saved;
  }

  return {
    task: episode.task,
    cwd: episode.cwd,
    source: episode.source,
    startedAt: episode.startedAt,
    toolCalls: episode.toolCalls,
    recordToolCall,
    recordToolResult,
    finish
  };
}

export function createLocalLearningStore({ directory, traceFile = 'traces.jsonl', routeFile = 'routes.json', datasetFile = 'dataset.jsonl' } = {}) {
  if (typeof directory !== 'string' || !directory) throw new TypeError('A learning directory is required');
  const tracesPath = join(directory, traceFile);
  const routesPath = join(directory, routeFile);
  const datasetPath = join(directory, datasetFile);

  async function ensure() { await mkdir(directory, { recursive: true }); }

  async function appendDatasetExample(trace) {
    await ensure();
    const example = traceToDatasetExample(trace);
    await appendFile(datasetPath, `${JSON.stringify(example)}\n`, 'utf8');
    return example;
  }

  async function appendTrace(trace) {
    await ensure();
    const record = normalizeTrace(trace);
    await appendFile(tracesPath, `${JSON.stringify(record)}\n`, 'utf8');
    await appendDatasetExample(record);
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

  return { directory, tracesPath, routesPath, datasetPath, appendTrace, appendDatasetExample, readTraces, readRoutes, writeRoutes, writeDataset, refreshCandidates, promote };
}
