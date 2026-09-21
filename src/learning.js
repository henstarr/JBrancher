import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, open, readFile as readTextFile, rename, stat, unlink, writeFile } from 'node:fs/promises';

const SECRET_KEY = /(api[_-]?key|token|password|secret|authorization|cookie|private[_-]?key)/i;
const SECRET_VALUE = /(Bearer\s+)[A-Za-z0-9._~+/=-]+|(?:sk|key|apikey)[_-][A-Za-z0-9_-]{16,}/gi;
const USAGE_COUNT_KEY = /^(?:input|output|total|prompt|completion|cached|reasoning)[_-]?tokens?$/i;
const USAGE_KEYS = {
  input: ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens'],
  output: ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens'],
  total: ['total_tokens', 'totalTokens']
};
const ROUTE_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'can', 'do', 'for', 'from', 'how', 'i', 'in', 'is',
  'it', 'me', 'my', 'of', 'on', 'or', 'please', 'tell', 'that', 'the', 'this',
  'to', 'what', 'where', 'with', 'you'
]);
const ROUTE_ACTION_WORDS = new Set([
  'check', 'display', 'find', 'get', 'inspect', 'list', 'look', 'open', 'read',
  'show', 'view'
]);
const TASK_CONTEXT_PREFIX = /^(?:please\s+)?(?:open|read|inspect|look\s+at|check)\s+(?:the\s+)?(?:relevant\s+)?(?:test\s+)?files?\s+(?:(?:and\s+inspect\s+this\s+bug)|(?:to\s+(?:investigate|debug|understand|reproduce)\s+(?:this\s+)?(?:issue|bug|problem)))\s*:\s*/i;
const READ_INTENT = /\b(read|open|show|view|inspect|display|look|list|cat|contents?|inside)\b/i;
const WRITE_INTENT = /\b(delete|remove|write|edit|modify|change|update|create|run|execute|deploy|install)\b/i;
const SENSITIVE_READ_PATH = /(^|[\\/])(?:\.env(?:\.[^\\/]+)*|credentials?(?:\.[^\\/]+)*|secrets?(?:\.[^\\/]+)*|passwords?(?:\.[^\\/]+)*|tokens?(?:\.[^\\/]+)*|[^\\/]*\.(?:pem|key|p12|pfx))$/i;
const ROUTE_RESOLUTIONS = new Set(['registered', 'learned', 'unmatched', 'uncertain', 'ambiguous', 'failed', 'shadow', 'unknown']);

export function redactText(value, maxChars = 2000) {
  if (typeof value !== 'string') return value;
  const redacted = value.replace(SECRET_VALUE, '[REDACTED]');
  return redacted.length > maxChars ? `${redacted.slice(0, maxChars)}…` : redacted;
}

export function redactValue(value, depth = 0, maxDepth = 5) {
  if (depth > maxDepth) return '[TRUNCATED]';
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.slice(0, 50).map(item => redactValue(item, depth + 1, maxDepth));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [
    key, (SECRET_KEY.test(key) && !(USAGE_COUNT_KEY.test(key) && typeof item === 'number'))
      ? '[REDACTED]' : redactValue(item, depth + 1, maxDepth)
  ]));
}

function usageValue(row, keys) {
  for (const key of keys) {
    if (typeof row?.[key] === 'number' && Number.isFinite(row[key]) && row[key] >= 0) return row[key];
  }
  return null;
}

/**
 * Summarize numeric provider usage embedded in recorded decision contexts.
 * Unknown provider fields are ignored; the trace itself remains the source of
 * truth for later inspection and redaction.
 */
export function summarizeTraceUsage(traces = []) {
  if (!Array.isArray(traces)) throw new TypeError('traces must be an array');
  const rows = traces.flatMap(trace => trace?.toolCalls?.flatMap(call => {
    const usage = call?.context?.selection?.usage;
    if (Array.isArray(usage)) return usage;
    return usage && typeof usage === 'object' ? [usage] : [];
  }) || []);
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let observedInputRows = 0;
  let observedOutputRows = 0;
  for (const row of rows) {
    const input = usageValue(row, USAGE_KEYS.input);
    const output = usageValue(row, USAGE_KEYS.output);
    const total = usageValue(row, USAGE_KEYS.total);
    if (input !== null) {
      inputTokens += input;
      observedInputRows++;
    }
    if (output !== null) {
      outputTokens += output;
      observedOutputRows++;
    }
    totalTokens += total ?? ((input ?? 0) + (output ?? 0));
  }
  return {
    usageRows: rows.length,
    observedInputRows,
    observedOutputRows,
    inputTokens,
    outputTokens,
    totalTokens
  };
}

export function normalizeTask(value) {
  if (typeof value !== 'string') throw new TypeError('A task string is required');
  return redactText(value, 4000).toLowerCase().replace(/\s+/g, ' ').trim();
}

function taskTokens(value) {
  const comparable = normalizeTask(value).replace(TASK_CONTEXT_PREFIX, '');
  return new Set(comparable
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

/**
 * Produce a non-reversible identity for the state in which a preference was
 * observed. The raw state is deliberately not persisted: it may contain
 * paths, prompts, or provider metadata that should stay in the harness.
 * Undefined means "global preference" for backwards compatibility.
 */
export function preferenceContextFingerprint(context) {
  if (context === undefined) return null;
  const redacted = redactValue(context, 0, 5);
  return hash(JSON.stringify(stable(redacted)) ?? String(redacted));
}

function actionKey(toolName, input) {
  return JSON.stringify(stable({ toolName, input: redactValue(input) }));
}

const ACTION_TEMPLATE_SLOT_PREFIX = '{{jbrancher.slot.';
const ACTION_TEMPLATE_SLOT_SUFFIX = '}}';

function normalizeTemplateText(value) {
  return redactText(String(value), 4000).toLowerCase().replace(/\s+/g, ' ').trim();
}

function templateSlotToken(slotId) {
  return `${ACTION_TEMPLATE_SLOT_PREFIX}${slotId}${ACTION_TEMPLATE_SLOT_SUFFIX}`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function actionTemplateInput(input, slotValues = {}) {
  if (typeof input === 'string') {
    return Object.entries(slotValues).reduce((value, [slotId, replacement]) => {
      return value.split(templateSlotToken(slotId)).join(replacement);
    }, input);
  }
  if (Array.isArray(input)) return input.map(item => actionTemplateInput(item, slotValues));
  if (!input || typeof input !== 'object') return input;
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [
    key, actionTemplateInput(value, slotValues)
  ]));
}

function taskTemplateMatch(matcher, task) {
  if (!['action-template', 'action-template-workflow'].includes(matcher?.type)
    || typeof matcher.template !== 'string'
    || !Array.isArray(matcher.slots) || matcher.slots.length === 0) return null;
  // Match the normalized template case-insensitively, but capture from the
  // original task text so case-sensitive arguments are not silently changed.
  const taskText = redactText(String(task), 4000).replace(/\s+/g, ' ').trim();
  const parts = matcher.template.split(/(\{\{jbrancher\.slot\.[^}]+\}\})/g);
  let pattern = '^';
  const slotIds = [];
  for (const part of parts) {
    const match = part.match(/^\{\{jbrancher\.slot\.([^}]+)\}\}$/);
    if (match) {
      slotIds.push(match[1]);
      pattern += '(.+?)';
    } else {
      pattern += escapeRegExp(part);
    }
  }
  pattern += '$';
  const result = new RegExp(pattern, 'i').exec(taskText);
  if (!result) return null;
  const values = {};
  for (const [index, slotId] of slotIds.entries()) {
    const value = result[index + 1]?.trim();
    if (!value || value.length > 2000) return null;
    values[slotId] = value;
  }
  return values;
}

function buildActionTemplateObservation(trace) {
  if (!trace || !Array.isArray(trace.toolCalls) || trace.toolCalls.length !== 1) return null;
  const call = trace.toolCalls[0];
  if (!call?.toolName || !call.input || typeof call.input !== 'object' || Array.isArray(call.input)) return null;
  // File reads already have a stricter path-aware generalizer. Keep this
  // learner focused on other single-step actions and never template secrets.
  if (call.toolName === 'read') return null;

  const task = normalizeTemplateText(trace.task || '');
  if (!task) return null;
  let template = task;
  const slots = [];
  const templateInput = redactValue(call.input);
  for (const [inputKey, rawValue] of Object.entries(call.input)) {
    if (SECRET_KEY.test(inputKey) || typeof rawValue !== 'string') continue;
    const value = normalizeTemplateText(rawValue);
    if (value.length < 2 || value.length > 500) continue;
    const index = template.indexOf(value);
    if (index < 0) continue;
    const slotId = `key-${inputKey}`;
    const token = templateSlotToken(slotId);
    if (template.includes(token)) continue;
    template = `${template.slice(0, index)}${token}${template.slice(index + value.length)}`;
    slots.push({ id: slotId, inputKey, value, rawValue });
  }
  if (slots.length === 0) return null;

  const templatedInput = { ...templateInput };
  for (const slot of slots) templatedInput[slot.inputKey] = templateSlotToken(slot.id);
  return {
    toolName: call.toolName,
    taskTemplate: template,
    slots,
    action: { toolName: call.toolName, input: templatedInput },
    observation: {
      trace,
      values: Object.fromEntries(slots.map(slot => [slot.id, slot.value])),
      rawValues: Object.fromEntries(slots.map(slot => [slot.id, slot.rawValue]))
    }
  };
}

function buildActionTemplateWorkflowObservation(trace) {
  if (!trace || !Array.isArray(trace.toolCalls) || trace.toolCalls.length < 2) return null;
  const task = normalizeTemplateText(trace.task || '');
  if (!task) return null;
  let taskTemplate = task;
  const slots = [];
  const actions = [];
  const values = {};
  const rawValues = {};

  for (const [step, call] of trace.toolCalls.entries()) {
    if (!call?.toolName || !call.input || typeof call.input !== 'object' || Array.isArray(call.input)) return null;
    const input = redactValue(call.input);
    for (const [inputKey, rawValue] of Object.entries(call.input)) {
      if (SECRET_KEY.test(inputKey) || typeof rawValue !== 'string') continue;
      const value = normalizeTemplateText(rawValue);
      if (value.length < 2 || value.length > 500) continue;
      const existing = slots.find(slot => slot.value === value);
      if (existing) {
        input[inputKey] = templateSlotToken(existing.id);
        continue;
      }
      const index = taskTemplate.indexOf(value);
      if (index < 0) continue;
      const slotId = `step-${step}-key-${inputKey}`;
      const token = templateSlotToken(slotId);
      taskTemplate = `${taskTemplate.slice(0, index)}${token}${taskTemplate.slice(index + value.length)}`;
      slots.push({ id: slotId, inputKey, step, value, rawValue });
      values[slotId] = value;
      rawValues[slotId] = rawValue;
      input[inputKey] = token;
    }
    actions.push({ toolName: call.toolName, input });
  }
  if (slots.length === 0) return null;
  return {
    taskTemplate,
    slots,
    action: { actions },
    observation: { trace, values, rawValues }
  };
}

function safeInspectionCommand(command) {
  if (typeof command !== 'string' || command.length > 800) return false;
  if (/[;&|$><\x60\r\n]/.test(command)) return false;
  if (/(^|[\s/'\x60])(?:[A-Za-z]:[\\/]|[\\/]{1,2}|\.\.(?:[\\/]|$))/.test(command)) return false;
  if (/(^|[\s/'\x60])(?:\.env(?:\b|[./])|credentials?(?:\b|[./])|secrets?(?:\b|[./])|passwords?(?:\b|[./])|tokens?(?:\b|[./])|[^\s/'\x60]+\.(?:pem|key|p12|pfx))(?:$|[\s/'\x60])/i.test(command)) {
    return false;
  }
  if (/(^|\s)(?:-i|--in-place|--follow-symlinks|-delete|-exec(?:dir)?|-ok(?:dir)?|-fprint(?:f)?|-fls)(?=\s|$)/.test(command)
    || /(^|\s)(?:--pre|--hostname-bin)(?:=|\s)/.test(command)) return false;
  return /^(?:ls|find|rg|grep|cat|head|tail|sed)(?:\s|$)/.test(command);
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
    if (safeInspectionCommand(command)) return 'read-only';
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
  const routeResolution = trace.routeResolution || trace.metadata?.routeResolution;
  return {
    schemaVersion: 1,
    id: trace.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    createdAt: trace.createdAt || new Date().toISOString(),
    task: redactText(trace.task, 4000),
    taskNormalized: normalizeTask(trace.task),
    cwd: redactText(trace.cwd || '', 1000),
    source: trace.source || 'pi',
    toolCalls: redactValue(trace.toolCalls || [], 0, 8),
    outcome: trace.outcome || 'unknown',
    safety: classifyTraceSafety(trace.toolCalls || []),
    routeResolution: ROUTE_RESOLUTIONS.has(routeResolution) ? routeResolution : 'unknown',
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
  if (['action-template', 'action-template-workflow'].includes(matcher?.type)) {
    return taskTemplateMatch(matcher, task) !== null;
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

function isLearnedRecordUsable(record, { allowVerified = false } = {}) {
  return record?.status === 'active'
    && (record.safety === 'read-only' || (allowVerified && record.verified === true));
}

function routeFromRecord(record, options = {}) {
  if (!isLearnedRecordUsable(record, options)) return null;

  // Generic templates are filled by the harness-neutral runtime, which can
  // re-check its live candidate catalog. Pi's route adapter has no equivalent
  // authorization hook for arbitrary parameterized actions, so keep it on its
  // stricter exact/path-specific adapters.
  if (['action-template', 'action-template-workflow'].includes(record.matcher?.type)) return null;

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

export function createLearnedRoutes(records = [], options = {}) {
  return records.map(record => routeFromRecord(record, options)).filter(Boolean);
}

function learnedActionFromRecord(record, task, options = {}) {
  if (!isLearnedRecordUsable(record, options)) return null;
  const actions = actionsFromRecord(record);
  if (actions.length !== 1) return null;
  if (record.matcher?.type === 'read-path') {
    const path = extractPathFromTask(task);
    if (!path || !matchesStoredMatcher(record.matcher, task)) return null;
    return {
      tool: 'read',
      args: {
        path,
        ...(actions[0].input?.offset === undefined ? {} : { offset: actions[0].input.offset }),
        ...(actions[0].input?.limit === undefined ? {} : { limit: actions[0].input.limit })
      }
    };
  }
  if (record.matcher?.type === 'action-template') {
    const slotValues = taskTemplateMatch(record.matcher, task);
    if (!slotValues) return null;
    const input = actionTemplateInput(actions[0].input, slotValues);
    return { tool: actions[0].toolName, args: input };
  }
  if (!matchesStoredMatcher(record.matcher, task)) return null;
  return { tool: actions[0].toolName, args: actions[0].input };
}

/**
 * Return safe, single-step learned actions that match a task.
 *
 * The caller must still check the action against its own authorization and
 * candidate set before executing it. Multi-step learned workflows remain
 * available through createLearnedRoutes for Pi, but are not flattened into a
 * generic harness action.
 */
export function findLearnedActions(records = [], task = '', options = {}) {
  if (!Array.isArray(records)) throw new TypeError('records must be an array');
  if (typeof task !== 'string') throw new TypeError('task must be a string');
  const matches = records.map(record => {
    const action = learnedActionFromRecord(record, task, options);
    return action ? { id: record.id, action } : null;
  }).filter(Boolean);
  return matches.filter((match, index) => matches.findIndex(item => actionKey(item.action.tool, item.action.args)
    === actionKey(match.action.tool, match.action.args)) === index);
}

export function createLearnedActions(records = [], task = '', options = {}) {
  return findLearnedActions(records, task, options).map(match => match.action);
}

/**
 * Return safe multi-step learned workflows for a generic harness.
 * The caller must authorize every returned action against its current state.
 */
export function findLearnedWorkflows(records = [], task = '', options = {}) {
  if (!Array.isArray(records)) throw new TypeError('records must be an array');
  if (typeof task !== 'string') throw new TypeError('task must be a string');
  return records.map(record => {
    if (!isLearnedRecordUsable(record, options)) return null;
    const actions = actionsFromRecord(record);
    if (actions.length < 2 || record.matcher?.type === 'read-path' || !matchesStoredMatcher(record.matcher, task)) return null;
    const slotValues = record.matcher?.type === 'action-template-workflow'
      ? taskTemplateMatch(record.matcher, task) : null;
    if (record.matcher?.type === 'action-template-workflow' && !slotValues) return null;
    return {
      id: record.id,
      actions: actions.map(action => ({
        tool: action.toolName,
        args: slotValues ? actionTemplateInput(action.input, slotValues) : action.input
      }))
    };
  }).filter(Boolean);
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
          verified: selectedTraces.every(trace => trace.metadata?.postconditionValidated === true),
          observations: selectedTraces.length,
          usage: summarizeTraceUsage(selectedTraces),
          examples: selectedTraces.slice(-5).map(trace => trace.task),
          firstSeen: selectedTraces[0].createdAt,
          lastSeen: selectedTraces.at(-1).createdAt
        });
      }
    }
  }
  return [
    ...candidates,
    ...proposeReadPathRoutes(traces, { minimumObservations }),
    ...proposeActionTemplateRoutes(traces, { minimumObservations }),
    ...proposeActionTemplateWorkflowRoutes(traces, { minimumObservations })
  ];
}

/**
 * Learn a reusable single-step action when the task visibly contains one or
 * more action arguments. This is intentionally conservative: it only creates
 * a template after the same task shape and action shape have been observed
 * with different values. The route still inherits the trace safety class and
 * therefore cannot be auto-promoted unless the harness explicitly verifies
 * side effects.
 */
function proposeActionTemplateRoutes(traces, { minimumObservations = 2 } = {}) {
  const groups = new Map();
  for (const trace of traces) {
    if (!trace || trace.outcome !== 'success' || !Array.isArray(trace.toolCalls)
      || trace.toolCalls.length !== 1 || trace.toolCalls.some(call => call?.ok === false)) continue;
    const observation = buildActionTemplateObservation(trace);
    if (!observation) continue;
    const signature = JSON.stringify(stable({
      toolName: observation.toolName,
      taskTemplate: observation.taskTemplate,
      action: observation.action
    }));
    const group = groups.get(signature) || {
      toolName: observation.toolName,
      taskTemplate: observation.taskTemplate,
      action: observation.action,
      slots: observation.slots,
      observations: []
    };
    group.observations.push(observation);
    groups.set(signature, group);
  }

  return [...groups.values()]
    .filter(group => group.observations.length >= minimumObservations)
    .map(group => {
      const variableSlots = group.slots.filter(slot => new Set(
        group.observations.map(item => item.observation.values[slot.id])
      ).size >= 2);
      if (variableSlots.length === 0) return null;
      const selectedTraces = group.observations.map(item => item.observation.trace);
      const firstValues = group.observations[0].observation.rawValues;
      const constantValues = Object.fromEntries(group.slots
        .filter(slot => !variableSlots.some(variable => variable.id === slot.id))
        .map(slot => [slot.id, firstValues[slot.id]]));
      const matcher = {
        type: 'action-template',
        template: actionTemplateInput(group.taskTemplate, constantValues),
        slots: variableSlots.map(slot => ({ id: slot.id, inputKey: slot.inputKey }))
      };
      const action = actionTemplateInput(group.action, constantValues);
      return {
        schemaVersion: 1,
        id: `learned-${hash(`${JSON.stringify(matcher)}\n${JSON.stringify(action)}`)}`,
        status: 'candidate',
        matcher,
        action,
        safety: classifyTraceSafety([action]),
        verified: selectedTraces.every(trace => trace.metadata?.postconditionValidated === true),
        observations: selectedTraces.length,
        usage: summarizeTraceUsage(selectedTraces),
        examples: selectedTraces.slice(-5).map(trace => trace.task),
        firstSeen: selectedTraces[0].createdAt,
        lastSeen: selectedTraces.at(-1).createdAt
      };
    })
    .filter(Boolean);
}

/**
 * Learn a parameterized multi-step workflow from successful frontier traces.
 * The generic runtime still re-authorizes every filled action before replay,
 * and non-read-only workflows require verified promotion.
 */
function proposeActionTemplateWorkflowRoutes(traces, { minimumObservations = 2 } = {}) {
  const groups = new Map();
  for (const trace of traces) {
    if (!trace || trace.outcome !== 'success' || !Array.isArray(trace.toolCalls)
      || trace.toolCalls.length < 2 || trace.toolCalls.some(call => call?.ok === false)) continue;
    const observation = buildActionTemplateWorkflowObservation(trace);
    if (!observation) continue;
    const signature = JSON.stringify(stable({
      taskTemplate: observation.taskTemplate,
      action: observation.action
    }));
    const group = groups.get(signature) || {
      taskTemplate: observation.taskTemplate,
      action: observation.action,
      slots: observation.slots,
      observations: []
    };
    group.observations.push(observation);
    groups.set(signature, group);
  }

  return [...groups.values()]
    .filter(group => group.observations.length >= minimumObservations)
    .map(group => {
      const variableSlots = group.slots.filter(slot => new Set(
        group.observations.map(item => item.observation.values[slot.id])
      ).size >= 2);
      if (variableSlots.length === 0) return null;
      const selectedTraces = group.observations.map(item => item.observation.trace);
      const firstValues = group.observations[0].observation.rawValues;
      const constantValues = Object.fromEntries(group.slots
        .filter(slot => !variableSlots.some(variable => variable.id === slot.id))
        .map(slot => [slot.id, firstValues[slot.id]]));
      const matcher = {
        type: 'action-template-workflow',
        template: actionTemplateInput(group.taskTemplate, constantValues),
        slots: variableSlots.map(slot => ({ id: slot.id, inputKey: slot.inputKey, step: slot.step }))
      };
      const action = actionTemplateInput(group.action, constantValues);
      return {
        schemaVersion: 1,
        id: `learned-${hash(`${JSON.stringify(matcher)}\n${JSON.stringify(action)}`)}`,
        status: 'candidate',
        matcher,
        action,
        safety: classifyTraceSafety(action.actions),
        verified: selectedTraces.every(trace => trace.metadata?.postconditionValidated === true),
        observations: selectedTraces.length,
        usage: summarizeTraceUsage(selectedTraces),
        examples: selectedTraces.slice(-5).map(trace => trace.task),
        firstSeen: selectedTraces[0].createdAt,
        lastSeen: selectedTraces.at(-1).createdAt
      };
    })
    .filter(Boolean);
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
        verified: group.traces.every(trace => trace.metadata?.postconditionValidated === true),
        observations: group.traces.length,
        usage: summarizeTraceUsage(group.traces),
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

function datasetFingerprint(task, toolCalls) {
  return hash(JSON.stringify(stable({
    task: normalizeTask(task),
    actions: (toolCalls || []).map(call => ({
      toolName: call?.toolName || '',
      input: redactValue(call?.input)
    }))
  })));
}

export function traceToDatasetExample(trace) {
  if (!trace || typeof trace.task !== 'string') throw new TypeError('Dataset examples require a task');
  const task = redactText(trace.task, 4000);
  const toolCalls = redactValue(trace.toolCalls || [], 0, 8);
  const safety = trace.safety || classifyTraceSafety(toolCalls);
  const routeResolution = ROUTE_RESOLUTIONS.has(trace.routeResolution)
    ? trace.routeResolution
    : ROUTE_RESOLUTIONS.has(trace.metadata?.routeResolution) ? trace.metadata.routeResolution : 'unknown';
  const id = trace.id || hash(`${task}\n${JSON.stringify(toolCalls)}`);
  const fingerprint = datasetFingerprint(task, toolCalls);
  return {
    schemaVersion: 1,
    exampleId: id,
    fingerprint,
    split: datasetSplit(fingerprint),
    task,
    taskNormalized: trace.taskNormalized || normalizeTask(task),
    steps: toolCalls,
    context: redactValue(trace.metadata || {}),
    outcome: trace.outcome || 'unknown',
    safety,
    routeResolution,
    reusable: trace.outcome === 'success' && safety === 'read-only',
    source: trace.source || 'pi',
    createdAt: trace.createdAt || null
  };
}

function importedObservationCount(example, maxObservationsPerExample) {
  const reportedObservations = Number.isSafeInteger(example.evidence?.observations)
    && example.evidence.observations > 0 ? example.evidence.observations : 1;
  const reportedSuccesses = Number.isSafeInteger(example.evidence?.outcomes?.success)
    && example.evidence.outcomes.success > 0 ? example.evidence.outcomes.success : null;
  const observations = example.outcome === 'success'
    ? (reportedSuccesses ?? reportedObservations)
    : 1;
  return Math.min(Math.max(1, observations), maxObservationsPerExample);
}

function validateImportedDatasetExample(example, index) {
  if (!example || typeof example !== 'object' || Array.isArray(example)) {
    throw new TypeError(`Dataset example ${index} must be an object`);
  }
  const safeExample = redactValue(example, 0, 8);
  if (typeof safeExample.fingerprint !== 'string' || !safeExample.fingerprint) {
    throw new TypeError(`Dataset example ${index} requires a fingerprint`);
  }
  if (typeof safeExample.task !== 'string' || !safeExample.task) {
    throw new TypeError(`Dataset example ${index} requires a task`);
  }
  if (!Array.isArray(safeExample.steps)) {
    throw new TypeError(`Dataset example ${index} requires steps`);
  }
  const expectedFingerprint = datasetFingerprint(safeExample.task, safeExample.steps);
  if (safeExample.fingerprint !== expectedFingerprint) {
    throw new TypeError(`Dataset example ${index} fingerprint does not match task and steps`);
  }
  return safeExample;
}

/**
 * Import explicitly reviewed, redacted dataset rows into a local trace store.
 *
 * Imported rows are treated as evidence, not permissions. We recompute the
 * fingerprint, derive safety from the actions, cap aggregate replay counts,
 * and keep imported context nested so a shared row cannot claim a verified
 * postcondition. Callers must explicitly opt in with reviewed: true.
 */
export async function importDatasetExamples(store, examples, {
  reviewed = false,
  source = 'dataset-import',
  maxObservationsPerExample = 100
} = {}) {
  if (!store || typeof store.appendTrace !== 'function') {
    throw new TypeError('A learning store with appendTrace is required');
  }
  if (!Array.isArray(examples)) throw new TypeError('examples must be an array');
  if (reviewed !== true) throw new Error('Dataset imports require explicit reviewed: true');
  if (typeof source !== 'string' || !source) throw new TypeError('source must be a non-empty string');
  if (!Number.isSafeInteger(maxObservationsPerExample) || maxObservationsPerExample < 1) {
    throw new TypeError('maxObservationsPerExample must be a positive integer');
  }

  let importedTraces = 0;
  let importedObservations = 0;
  let cappedExamples = 0;
  let unsafeExamples = 0;
  let skippedExistingTraces = 0;
  let skippedExistingObservations = 0;
  const pendingTraces = [];
  for (const [index, rawExample] of examples.entries()) {
    const example = validateImportedDatasetExample(rawExample, index);
    const observations = importedObservationCount(example, maxObservationsPerExample);
    if ((example.evidence?.observations || 1) > observations) cappedExamples++;
    const safety = classifyTraceSafety(example.steps);
    if (safety !== 'read-only') unsafeExamples++;
    for (let observation = 0; observation < observations; observation++) {
      const trace = {
        id: `import-${hash(`${source}\n${example.fingerprint}\n${observation}`)}`,
        task: example.task,
        source,
        toolCalls: example.steps,
        outcome: example.outcome || 'unknown',
        routeResolution: example.routeResolution || 'unknown',
        metadata: {
          datasetImport: true,
          datasetFingerprint: example.fingerprint,
          importedFrom: source,
          importedContext: example.context || {}
        }
      };
      pendingTraces.push(trace);
    }
  }
  if (typeof store.appendTracesIfNew === 'function') {
    const result = await store.appendTracesIfNew(pendingTraces);
    importedTraces = result.appended;
    importedObservations = result.appended;
    skippedExistingTraces = result.skipped;
    skippedExistingObservations = result.skipped;
  } else {
    const existingIds = new Set(typeof store.readTraces === 'function'
      ? (await store.readTraces()).map(trace => trace?.id).filter(Boolean)
      : []);
    for (const trace of pendingTraces) {
      const result = typeof store.appendTraceIfNew === 'function'
        ? await store.appendTraceIfNew(trace)
        : existingIds.has(trace.id)
          ? { appended: false }
          : { appended: true, record: await store.appendTrace(trace) };
      if (result?.appended === false) {
        skippedExistingTraces++;
        skippedExistingObservations++;
      } else {
        existingIds.add(trace.id);
        importedTraces++;
        importedObservations++;
      }
    }
  }
  return {
    examples: examples.length,
    importedTraces,
    importedObservations,
    skippedExistingTraces,
    skippedExistingObservations,
    cappedExamples,
    unsafeExamples,
    source,
    reviewed: true
  };
}

export function buildDataset(traces, { includeUnknown = true, deduplicate = false } = {}) {
  if (!Array.isArray(traces)) throw new TypeError('traces must be an array');
  const examples = traces
    .filter(trace => includeUnknown || trace?.outcome === 'success')
    .map(traceToDatasetExample);
  return deduplicate ? deduplicateDataset(examples) : examples;
}

function incrementCount(counts, key) {
  const normalized = typeof key === 'string' && key ? key : 'unknown';
  counts[normalized] = (counts[normalized] || 0) + 1;
}

function datasetExampleRank(example) {
  const outcomeRank = { success: 3, unknown: 2, failure: 1 }[example?.outcome] || 0;
  const reusableRank = example?.reusable ? 1 : 0;
  const stepRank = Array.isArray(example?.steps) ? example.steps.length : 0;
  return [outcomeRank, reusableRank, stepRank];
}

function isHigherQualityExample(candidate, current) {
  const left = datasetExampleRank(candidate);
  const right = datasetExampleRank(current);
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  // Keep the earliest representative when quality is tied. This makes the
  // curated export stable as new duplicate evidence arrives.
  return String(candidate?.createdAt || '') < String(current?.createdAt || '');
}

/**
 * Collapse duplicate trajectory fingerprints for portable exports.
 *
 * Raw traces remain append-only because route mining needs repeated evidence.
 * A curated dataset keeps one representative row per task/action fingerprint
 * and records the repeated observations as redacted aggregate evidence. This
 * prevents repeated local use from overweighting a single workflow during
 * offline evaluation or later opt-in dataset sharing.
 */
export function deduplicateDataset(examples) {
  if (!Array.isArray(examples)) throw new TypeError('examples must be an array');
  const groups = new Map();
  for (const example of examples) {
    if (!example || typeof example !== 'object' || typeof example.fingerprint !== 'string') {
      throw new TypeError('Each dataset example requires a fingerprint');
    }
    const fingerprint = example.fingerprint;
    const existing = groups.get(fingerprint);
    if (!existing) {
      const representative = structuredClone(example);
      representative.schemaVersion = 2;
      representative.exampleId = `curated-${fingerprint}`;
      representative.evidence = {
        observations: 1,
        outcomes: { [example.outcome || 'unknown']: 1 },
        routeResolutions: { [example.routeResolution || 'unknown']: 1 },
        sources: example.source ? [example.source] : []
      };
      representative.firstSeen = example.createdAt || null;
      representative.lastSeen = example.createdAt || null;
      groups.set(fingerprint, representative);
      continue;
    }

    existing.evidence.observations += 1;
    incrementCount(existing.evidence.outcomes, example.outcome);
    incrementCount(existing.evidence.routeResolutions, example.routeResolution);
    if (example.source && !existing.evidence.sources.includes(example.source)) {
      existing.evidence.sources.push(example.source);
      existing.evidence.sources.sort();
    }
    const timestamps = [existing.firstSeen, example.createdAt].filter(Boolean).sort();
    if (timestamps.length > 0) existing.firstSeen = timestamps[0];
    const latest = [existing.lastSeen, example.createdAt].filter(Boolean).sort();
    if (latest.length > 0) existing.lastSeen = latest.at(-1);
    if (isHigherQualityExample(example, existing)) {
      const evidence = existing.evidence;
      const firstSeen = existing.firstSeen;
      const lastSeen = existing.lastSeen;
      Object.assign(existing, structuredClone(example));
      existing.schemaVersion = 2;
      existing.exampleId = `curated-${fingerprint}`;
      existing.evidence = evidence;
      existing.firstSeen = firstSeen;
      existing.lastSeen = lastSeen;
    }
  }
  return [...groups.values()].sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
}

/**
 * Merge redacted dataset exports from separate local workspaces.
 *
 * This is an explicit data-export operation. It does not mutate a learning
 * store or promote imported examples into executable routes.
 */
export function mergeDatasetExamples(exampleSets = []) {
  if (!Array.isArray(exampleSets) || exampleSets.some(set => !Array.isArray(set))) {
    throw new TypeError('exampleSets must be an array of example arrays');
  }
  const examples = exampleSets.flat().map((example, index) => {
    if (!example || typeof example !== 'object' || Array.isArray(example)
      || typeof example.fingerprint !== 'string' || !example.fingerprint) {
      throw new TypeError(`Dataset example ${index} requires a fingerprint`);
    }
    return redactValue(example, 0, 8);
  });
  return deduplicateDataset(examples);
}

function outputPreview(value) {
  if (typeof value === 'string') return redactText(value, 500);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    try { return redactText(JSON.stringify(value), 500); } catch { return undefined; }
  }
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
  let episodeMetadata = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? { ...metadata } : {};
  let finished = false;
  let saved;

  function recordToolCall(event = {}) {
    if (finished || typeof event.toolName !== 'string') return;
    episode.toolCalls.push({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.input,
      ...(event.context === undefined ? {} : { context: event.context })
    });
  }

  function recordToolResult(event = {}) {
    if (finished) return;
    const call = episode.toolCalls.find(item => item.toolCallId === event.toolCallId);
    if (!call) return;
    call.ok = !event.isError;
    call.output = outputPreview(event.output ?? event.content);
  }

  function setMetadata(values = {}) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      throw new TypeError('Episode metadata must be an object');
    }
    episodeMetadata = { ...episodeMetadata, ...values };
  }

  async function finish({ outcome, metadata: finishMetadata = {} } = {}) {
    if (finished) return saved;
    const resolvedOutcome = outcome || (episode.toolCalls.length > 0
      && episode.toolCalls.every(call => call.ok === true) ? 'success' : 'unknown');
    saved = await store.appendTrace({
      ...episode,
      outcome: resolvedOutcome,
      metadata: { ...episodeMetadata, ...finishMetadata }
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
    setMetadata,
    finish
  };
}

export function createLocalLearningStore({ directory, traceFile = 'traces.jsonl', routeFile = 'routes.json', datasetFile = 'dataset.jsonl', curatedDatasetFile = 'dataset-curated.jsonl', preferenceFile = 'preferences.json' } = {}) {
  if (typeof directory !== 'string' || !directory) throw new TypeError('A learning directory is required');
  const tracesPath = join(directory, traceFile);
  const routesPath = join(directory, routeFile);
  const datasetPath = join(directory, datasetFile);
  const curatedDatasetPath = join(directory, curatedDatasetFile);
  const preferencesPath = join(directory, preferenceFile);
  const lockPath = join(directory, '.learning.lock');
  const lockWaitTimeoutMs = 30_000;
  const lockStaleAfterMs = 10 * 60_000;
  const lockRetryDelayMs = 25;

  async function ensure() { await mkdir(directory, { recursive: true }); }

  async function acquireLock() {
    await ensure();
    const startedAt = Date.now();
    while (true) {
      try {
        const handle = await open(lockPath, 'wx');
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
        } finally {
          await handle.close();
        }
        return async () => {
          await unlink(lockPath).catch(error => {
            if (error?.code !== 'ENOENT') throw error;
          });
        };
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        try {
          const lockInfo = await stat(lockPath);
          if (Date.now() - lockInfo.mtimeMs > lockStaleAfterMs) {
            await unlink(lockPath).catch(staleError => {
              if (!['ENOENT', 'EACCES', 'EPERM'].includes(staleError?.code)) throw staleError;
            });
            continue;
          }
        } catch (statError) {
          if (statError?.code !== 'ENOENT') throw statError;
          continue;
        }
        if (Date.now() - startedAt >= lockWaitTimeoutMs) {
          throw new Error(`Learning store is busy: ${directory}`);
        }
        await new Promise(resolve => setTimeout(resolve, lockRetryDelayMs));
      }
    }
  }

  async function withLock(operation) {
    const release = await acquireLock();
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  async function appendDatasetExampleUnlocked(trace) {
    await ensure();
    const example = traceToDatasetExample(trace);
    await appendFile(datasetPath, `${JSON.stringify(example)}\n`, 'utf8');
    return example;
  }

  async function appendDatasetExample(trace) {
    return withLock(() => appendDatasetExampleUnlocked(trace));
  }

  async function appendTrace(trace) {
    return withLock(async () => {
      await ensure();
      const record = normalizeTrace(trace);
      await appendFile(tracesPath, `${JSON.stringify(record)}\n`, 'utf8');
      await appendDatasetExampleUnlocked(record);
      return record;
    });
  }

  async function appendTraceIfNew(trace) {
    return withLock(async () => {
      await ensure();
      const record = normalizeTrace(trace);
      const existing = (await readTraces()).find(item => item?.id === record.id);
      if (existing) return { appended: false, record: existing };
      await appendFile(tracesPath, `${JSON.stringify(record)}\n`, 'utf8');
      await appendDatasetExampleUnlocked(record);
      return { appended: true, record };
    });
  }

  async function appendTracesIfNew(traces) {
    if (!Array.isArray(traces)) throw new TypeError('traces must be an array');
    return withLock(async () => {
      await ensure();
      const existingIds = new Set((await readTraces()).map(item => item?.id).filter(Boolean));
      const records = [];
      let skipped = 0;
      for (const trace of traces) {
        const record = normalizeTrace(trace);
        if (existingIds.has(record.id)) {
          skipped++;
          continue;
        }
        existingIds.add(record.id);
        records.push(record);
      }
      if (records.length > 0) {
        await appendFile(tracesPath, `${records.map(record => JSON.stringify(record)).join('\n')}\n`, 'utf8');
        await appendFile(datasetPath, `${records.map(record => JSON.stringify(traceToDatasetExample(record))).join('\n')}\n`, 'utf8');
      }
      return { appended: records.length, skipped, records };
    });
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

  async function readPreferences() {
    try {
      const parsed = JSON.parse(await readTextFile(preferencesPath, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
  }

  async function writeRoutesUnlocked(routes) {
    await ensure();
    const tempPath = `${routesPath}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(tempPath, `${JSON.stringify(routes, null, 2)}\n`, 'utf8');
    await rename(tempPath, routesPath);
    return routes;
  }

  async function writeRoutes(routes) {
    return withLock(() => writeRoutesUnlocked(routes));
  }

  async function writePreferencesUnlocked(preferences) {
    await ensure();
    const tempPath = `${preferencesPath}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(tempPath, `${JSON.stringify(preferences, null, 2)}\n`, 'utf8');
    await rename(tempPath, preferencesPath);
    return preferences;
  }

  async function writePreferences(preferences) {
    if (!Array.isArray(preferences)) throw new TypeError('preferences must be an array');
    return withLock(() => writePreferencesUnlocked(preferences));
  }

  async function findPreference(task, routeIds = [], { minimumObservations = 2, context } = {}) {
    if (typeof task !== 'string') throw new TypeError('task must be a string');
    if (!Array.isArray(routeIds)) throw new TypeError('routeIds must be an array');
    if (!Number.isSafeInteger(minimumObservations) || minimumObservations < 1) {
      throw new TypeError('minimumObservations must be a positive integer');
    }
    const normalized = normalizeTask(task);
    const allowed = new Set(routeIds.filter(routeId => typeof routeId === 'string'));
    const contextFingerprint = preferenceContextFingerprint(context);
    const preferences = await readPreferences();
    return preferences.find(preference => preference?.status === 'active'
      && preference.taskNormalized === normalized
      && allowed.has(preference.routeId)
      && (contextFingerprint === null
        ? !preference.contextFingerprint
        : preference.contextFingerprint === contextFingerprint)
      && Number.isSafeInteger(preference.observations)
      && preference.observations >= minimumObservations) || null;
  }

  async function recordPreferenceSuccess({ task, routeId, context, minimumObservations = 2 } = {}) {
    if (typeof task !== 'string' || typeof routeId !== 'string' || !routeId) {
      throw new TypeError('task and routeId are required');
    }
    if (!Number.isSafeInteger(minimumObservations) || minimumObservations < 1) {
      throw new TypeError('minimumObservations must be a positive integer');
    }
    return withLock(async () => {
      const taskNormalized = normalizeTask(task);
      const contextFingerprint = preferenceContextFingerprint(context);
      const id = `preference-${hash(`${taskNormalized}\n${routeId}\n${contextFingerprint ?? 'global'}`)}`;
      const preferences = await readPreferences();
      let preference = preferences.find(item => item.id === id);
      if (!preference) {
        preference = {
          schemaVersion: 2,
          id,
          task: redactText(task, 4000),
          taskNormalized,
          routeId: redactText(routeId, 200),
          ...(contextFingerprint ? { contextFingerprint } : {}),
          status: 'candidate',
          observations: 0,
          failures: 0,
          createdAt: new Date().toISOString()
        };
        preferences.push(preference);
      }
      if (preference.status !== 'quarantined') {
        preference.observations = Number.isSafeInteger(preference.observations) ? preference.observations + 1 : 1;
        preference.status = preference.observations >= minimumObservations ? 'active' : 'candidate';
        preference.lastSuccessAt = new Date().toISOString();
        if (preference.status === 'active' && !preference.promotedAt) preference.promotedAt = preference.lastSuccessAt;
        await writePreferencesUnlocked(preferences);
      }
      return preference;
    });
  }

  async function recordPreferenceFailure({ task, routeId, context, reason = '' } = {}) {
    if (typeof task !== 'string' || typeof routeId !== 'string' || !routeId) {
      throw new TypeError('task and routeId are required');
    }
    return withLock(async () => {
      const taskNormalized = normalizeTask(task);
      const contextFingerprint = preferenceContextFingerprint(context);
      const id = `preference-${hash(`${taskNormalized}\n${routeId}\n${contextFingerprint ?? 'global'}`)}`;
      const preferences = await readPreferences();
      const preference = preferences.find(item => item.id === id);
      if (!preference) return null;
      preference.status = 'quarantined';
      preference.failures = Number.isSafeInteger(preference.failures) ? preference.failures + 1 : 1;
      preference.lastFailureAt = new Date().toISOString();
      if (reason) preference.failureReason = redactText(String(reason), 500);
      await writePreferencesUnlocked(preferences);
      return preference;
    });
  }

  async function writeDatasetUnlocked(options = {}) {
    await ensure();
    const examples = buildDataset(await readTraces(), options);
    const outputPath = options.deduplicate ? curatedDatasetPath : datasetPath;
    const tempPath = `${outputPath}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(tempPath, examples.map(example => JSON.stringify(example)).join('\n') + (examples.length ? '\n' : ''), 'utf8');
    await rename(tempPath, outputPath);
    return { path: outputPath, examples };
  }

  async function writeDataset(options = {}) {
    return withLock(() => writeDatasetUnlocked(options));
  }

  async function refreshCandidates(options = {}) {
    return withLock(async () => {
      const existing = await readRoutes();
      const existingById = new Map(existing.map(route => [route.id, route]));
      const candidates = proposeRoutes(await readTraces(), options);
      for (const candidate of candidates) {
        const previous = existingById.get(candidate.id);
        if (!previous) {
          existingById.set(candidate.id, candidate);
          continue;
        }
        // Candidate evidence is recomputed from the complete local trace set.
        // Keep that fresh evidence even after promotion, while preserving
        // lifecycle state and replay/failure telemetry owned by the route.
        existingById.set(candidate.id, {
          ...candidate,
          status: previous.status,
          ...(previous.promotedAt ? { promotedAt: previous.promotedAt } : {}),
          ...(Number.isSafeInteger(previous.failures) ? { failures: previous.failures } : {}),
          ...(previous.lastFailureAt ? { lastFailureAt: previous.lastFailureAt } : {}),
          ...(previous.failureReason ? { failureReason: previous.failureReason } : {}),
          ...(Number.isSafeInteger(previous.successfulReplays) ? { successfulReplays: previous.successfulReplays } : {}),
          ...(previous.lastReplayAt ? { lastReplayAt: previous.lastReplayAt } : {})
        });
      }
      return writeRoutesUnlocked([...existingById.values()]);
    });
  }

  async function promote(id, { force = false, allowVerified = false } = {}) {
    return withLock(async () => {
      const routes = await readRoutes();
      const route = routes.find(item => item.id === id);
      if (!route) throw new Error(`Unknown learned route: ${id}`);
      if (!force && route.safety !== 'read-only'
        && !(allowVerified && route.verified === true)) {
        throw new Error('Only read-only or postcondition-verified routes can be promoted automatically');
      }
      if (!force && route.status === 'quarantined') throw new Error('Quarantined routes require explicit force to promote');
      route.status = 'active';
      route.promotedAt = new Date().toISOString();
      await writeRoutesUnlocked(routes);
      return route;
    });
  }

  async function recordRouteFailure(id, { reason = '' } = {}) {
    return withLock(async () => {
      const routes = await readRoutes();
      const route = routes.find(item => item.id === id);
      if (!route) return null;
      route.status = 'quarantined';
      route.failures = Number.isSafeInteger(route.failures) ? route.failures + 1 : 1;
      route.lastFailureAt = new Date().toISOString();
      if (reason) route.failureReason = redactText(String(reason), 500);
      await writeRoutesUnlocked(routes);
      return route;
    });
  }

  async function recordRouteSuccess(id) {
    return withLock(async () => {
      const routes = await readRoutes();
      const route = routes.find(item => item.id === id);
      if (!route || route.status !== 'active') return route || null;
      route.successfulReplays = Number.isSafeInteger(route.successfulReplays)
        ? route.successfulReplays + 1 : 1;
      route.lastReplayAt = new Date().toISOString();
      await writeRoutesUnlocked(routes);
      return route;
    });
  }

  return {
    directory, tracesPath, routesPath, datasetPath, curatedDatasetPath, preferencesPath,
    appendTrace, appendTraceIfNew, appendTracesIfNew, appendDatasetExample, readTraces, readRoutes, writeRoutes,
    writeDataset, refreshCandidates, promote, recordRouteFailure, recordRouteSuccess,
    readPreferences, writePreferences, findPreference, recordPreferenceSuccess,
    recordPreferenceFailure
  };
}

export async function refreshAndPromoteReadOnly(store, {
  minimumObservations = 2,
  candidateMinimumObservations = 1,
  minimumSimilarity = 0.8,
  allowVerified = false
} = {}) {
  if (!store || typeof store.refreshCandidates !== 'function' || typeof store.promote !== 'function') {
    throw new TypeError('A complete learning store is required');
  }
  if (!Number.isSafeInteger(minimumObservations) || minimumObservations < 1) {
    throw new TypeError('minimumObservations must be a positive integer');
  }
  if (!Number.isSafeInteger(candidateMinimumObservations) || candidateMinimumObservations < 1) {
    throw new TypeError('candidateMinimumObservations must be a positive integer');
  }
  const routes = await store.refreshCandidates({
    minimumObservations: candidateMinimumObservations,
    minimumSimilarity
  });
  const promotable = routes.filter(route => route.status === 'candidate'
    && (route.safety === 'read-only' || (allowVerified && route.verified === true))
    && route.observations >= minimumObservations);
  for (const route of promotable) await store.promote(route.id, { allowVerified });
  return { routes, promoted: promotable };
}
