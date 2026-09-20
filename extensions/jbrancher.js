import { access, readFile as readTextFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLocalLearningStore, createLearnedRoutes } from '../src/learning.js';
import { createJevEvaluator } from '../src/jev.js';
import { createPiRouter, formatPiResult } from '../src/pi.js';

const CONFIG_FILES = ['jbrancher.config.js', '.jbrancher.js', '.pi/jbrancher.js'];
const STATUS_ID = 'jbrancher';

function numberEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function builtInRoutes() {
  const exact = (values) => ({ task }) => values.includes(task.trim().replace(/[?.!]+$/, ''));
  const command = (id, values, program, args, label) => ({
    id,
    description: label,
    match: exact(values),
    run: async ({ exec }) => {
      if (typeof exec !== 'function') throw new Error('Pi command execution is unavailable');
      const result = await exec(program, args);
      if (result.code !== 0) throw new Error(result.stderr || `${program} exited with code ${result.code}`);
      return (result.stdout || '').trim() || '(no output)';
    }
  });
  return [
    command('git-status', ['git status', 'show git status', 'what is the git status'], 'git', ['status', '--short'], 'Read the working tree status'),
    command('git-branch', ['git branch', 'what branch am i on', 'which branch am i on'], 'git', ['branch', '--show-current'], 'Read the current branch'),
    command('current-directory', ['pwd', 'where am i', 'show the current directory'], 'pwd', [], 'Read the current directory'),
    command('node-version', ['node --version', 'what is the node version'], 'node', ['--version'], 'Read the Node.js version')
  ];
}

async function loadConfig(cwd) {
  for (const relative of CONFIG_FILES) {
    const file = join(cwd, relative);
    try {
      await access(file);
      const module = await import(`${pathToFileURL(file).href}?jbrancher=${Date.now()}`);
      return module.default ?? module;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return {};
}

async function loadLocalEnv(cwd) {
  try {
    const contents = await readTextFile(join(cwd, '.env'), 'utf8');
    for (const line of contents.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || match[1] in process.env) continue;
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function readProjectFile(cwd, filePath, offset = 0, limit) {
  const root = resolve(cwd);
  const absolute = resolve(cwd, filePath);
  const relativePath = relative(root, absolute);
  if (relativePath.startsWith('..') || relativePath.includes(':')) throw new Error('Learned reads must stay inside the project');
  if (/(^|[\\/])(?:\.env(?:\.|$)|credentials?(?:\.|$)|secrets?(?:\.|$)|.*\.(?:pem|key|p12|pfx))$/i.test(relativePath)) {
    throw new Error('Learned reads refuse sensitive files');
  }
  const contents = await readTextFile(absolute, 'utf8');
  const lines = contents.split(/\r?\n/);
  const start = Number.isSafeInteger(offset) && offset > 0 ? offset : 0;
  const end = Number.isSafeInteger(limit) && limit > 0 ? start + limit : lines.length;
  return lines.slice(start, end).join('\n');
}

function evaluationForEnvironment() {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) return undefined;
  return createJevEvaluator({
    apiKey,
    model: process.env.JBRANCHER_PI_JEV_MODEL || 'jev-1.13.0',
    timeoutMs: numberEnv('JBRANCHER_PI_JEV_TIMEOUT_MS', 3000)
  });
}

function notify(ctx, message, level = 'info') {
  if (ctx.hasUI) ctx.ui.notify(message, level);
}

function isJsonInvocation(ctx) {
  if (ctx.mode === 'json') return true;
  const args = process.argv.slice(2);
  return args.some((arg, index) => arg === '--mode=json'
    || (arg === '--mode' && args[index + 1] === 'json'));
}

export default async function jbrancherPiExtension(pi) {
  let config = {};
  let runtime = null;
  const stats = { handled: 0, fallback: 0, failed: 0, jev: 0 };

  async function load(cwd) {
    await loadLocalEnv(cwd);
    config = await loadConfig(cwd);
    const requestedMode = process.env.JBRANCHER_PI_MODE || config.mode || 'active';
    const mode = requestedMode === 'learning' ? 'active' : requestedMode;
    const learningEnabled = requestedMode === 'learning'
      || process.env.JBRANCHER_PI_LEARNING === '1'
      || config.learning === true;
    if (!['active', 'shadow'].includes(mode)) throw new TypeError('JBRANCHER_PI_MODE must be active, shadow, or learning');
    const learning = learningEnabled ? createLocalLearningStore({
      directory: config.learningDirectory ? resolve(cwd, config.learningDirectory) : join(cwd, '.jbrancher')
    }) : null;
    const learnedRecords = learning ? (await learning.readRoutes()).filter(route => route.status === 'active') : [];
    const routes = [
      ...(config.includeBuiltins === false ? [] : builtInRoutes()),
      ...(config.routes ?? []),
      ...createLearnedRoutes(learnedRecords)
    ];
    const evaluate = evaluationForEnvironment();
    runtime = {
      mode,
      evaluate,
      routes,
      learning: { enabled: learningEnabled, store: learning, pending: null, learnedRecords },
      router: createPiRouter({
        routes,
        evaluate,
        minimumProbability: numberEnv('JBRANCHER_PI_MIN_PROBABILITY', config.minimumProbability ?? 0.7),
        minimumMargin: numberEnv('JBRANCHER_PI_MIN_MARGIN', config.minimumMargin ?? 0.15)
      })
    };
  }

  pi.on('session_start', async (_event, ctx) => {
    try {
      await load(ctx.cwd);
      if (ctx.hasUI) ctx.ui.setStatus(STATUS_ID, `JBrancher: ${runtime.routes.length} deterministic routes`);
      notify(ctx, `JBrancher loaded ${runtime.routes.length} deterministic route(s).${runtime.learning.enabled ? ' Local learning is on.' : ' Non-matches stay on Pi\'s frontier model.'}`);
    } catch (error) {
      runtime = null;
      notify(ctx, `JBrancher disabled: ${error instanceof Error ? error.message : String(error)}`, 'warning');
    }
  });

  pi.on('before_agent_start', async (event) => {
    const guidance = 'JBrancher is active. Prefer the available tools for non-deterministic work; deterministic prompts may already have been handled before this turn. Do not simulate a deterministic result that was not provided.';
    if (event.systemPromptOptions?.promptGuidelines) {
      const guidelines = event.systemPromptOptions.promptGuidelines;
      if (!guidelines.includes(guidance)) guidelines.push(guidance);
      return;
    }
    return { systemPrompt: `${event.systemPrompt}\n\n${guidance}` };
  });

  pi.on('input', async (event, ctx) => {
    if (event.source === 'extension' || !runtime) return { action: 'continue' };
    if (runtime.learning.enabled) {
      runtime.learning.pending = {
        task: event.text,
        cwd: ctx.cwd,
        source: event.source || 'interactive',
        startedAt: new Date().toISOString(),
        toolCalls: []
      };
    }
    let outcome;
    try {
      outcome = await runtime.router.handle({
        task: event.text,
        state: { cwd: ctx.cwd, mode: ctx.mode },
        signal: ctx.signal,
        exec: (program, args = []) => pi.exec(program, args),
        readFile: (filePath, offset, limit) => readProjectFile(ctx.cwd, filePath, offset, limit)
      });
    } catch (error) {
      stats.failed++;
      notify(ctx, `JBrancher failed open to Pi: ${error instanceof Error ? error.message : String(error)}`, 'warning');
      return { action: 'continue' };
    }
    if (!outcome.routeId) {
      stats.fallback++;
      return { action: 'continue' };
    }
    if (outcome.source === 'jev') stats.jev++;
    if (outcome.source === 'frontier' || runtime.mode === 'shadow') {
      stats.fallback++;
      if (runtime.mode === 'shadow') notify(ctx, `JBrancher shadow match: ${outcome.matched?.join(', ') || 'none'}; Pi handled the prompt.`);
      return { action: 'continue' };
    }
    stats.handled++;
    if (runtime.learning.enabled) runtime.learning.pending = null;
    const content = `[JBrancher · ${outcome.source} · ${outcome.routeId}]\n${formatPiResult(outcome.result)}`;
    const isPrintMode = !isJsonInvocation(ctx)
      && (ctx.mode === 'print' || (ctx.mode === undefined && ctx.hasUI === false));
    if (isPrintMode) {
      // Print mode has no transcript renderer, so make a handled result visible
      // without starting a frontier turn or contaminating JSON mode output.
      console.log(content);
    } else {
      pi.sendMessage({
        customType: 'jbrancher',
        content,
        display: true,
        details: { routeId: outcome.routeId, source: outcome.source, score: outcome.score }
      }, { deliverAs: 'nextTurn' });
    }
    return { action: 'handled' };
  });

  pi.on('tool_call', async event => {
    const pending = runtime?.learning?.pending;
    if (!pending) return;
    pending.toolCalls.push({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.input
    });
  });

  pi.on('tool_result', async event => {
    const pending = runtime?.learning?.pending;
    const call = pending?.toolCalls.find(item => item.toolCallId === event.toolCallId);
    if (!call) return;
    call.ok = !event.isError;
    call.output = Array.isArray(event.content)
      ? event.content.filter(item => item?.type === 'text').map(item => item.text).join('\n').slice(0, 500)
      : undefined;
  });

  pi.on('agent_end', async (_event, ctx) => {
    const learning = runtime?.learning;
    const pending = learning?.pending;
    if (!learning?.enabled || !pending) return;
    const mode = ctx.mode;
    const cwd = pending.cwd;
    const outcome = pending.toolCalls.length > 0 && pending.toolCalls.every(call => call.ok === true)
      ? 'success' : 'unknown';
    try {
      await learning.store.appendTrace({ ...pending, outcome, metadata: { mode } });
      await learning.store.writeDataset();
      if (outcome === 'success' && config.autoPromoteReadOnly !== false) {
        const routes = await learning.store.refreshCandidates({
          minimumObservations: Number(config.minimumObservations || 2),
          minimumSimilarity: Number(config.minimumSimilarity || 0.8)
        });
        const promotable = routes.filter(route => route.status === 'candidate'
          && route.safety === 'read-only'
          && route.observations >= Number(config.minimumObservations || 2));
        for (const route of promotable) await learning.store.promote(route.id);
        if (promotable.length > 0) {
          await load(cwd);
          // Do not touch the agent context after an awaited reload: print-mode
          // sessions may already be replacing or shutting down their context.
        }
      }
    } catch (error) {
      notify(ctx, `JBrancher learning trace failed: ${error instanceof Error ? error.message : String(error)}`, 'warning');
    } finally {
      learning.pending = null;
    }
  });

  pi.registerCommand('jbrancher', {
    description: 'Show or reload JBrancher deterministic routing',
    handler: async (args, ctx) => {
      const command = (args || '').trim();
      if (command === 'reload') {
        try {
          await load(ctx.cwd);
          notify(ctx, `JBrancher reloaded ${runtime.routes.length} deterministic route(s).`);
        } catch (error) {
          notify(ctx, `JBrancher reload failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
        }
        return;
      }
      if (command === 'learn' || command === 'candidates') {
        if (!runtime?.learning.enabled) {
          notify(ctx, 'Enable local learning with JBRANCHER_PI_LEARNING=1 or JBRANCHER_PI_MODE=learning.');
          return;
        }
        const routes = await runtime.learning.store.refreshCandidates({
          minimumObservations: Number(config.minimumObservations || 2),
          minimumSimilarity: Number(config.minimumSimilarity || 0.8)
        });
        const candidates = routes.filter(route => route.status === 'candidate');
        notify(ctx, candidates.length
          ? `Learned ${candidates.length} candidate route(s): ${candidates.map(route => `${route.id} [${route.safety}]`).join(', ')}`
          : 'No repeated successful workflows are ready to become candidates.');
        return;
      }
      if (command === 'export' || command === 'dataset') {
        if (!runtime?.learning.enabled) {
          notify(ctx, 'Enable local learning before exporting the local dataset.');
          return;
        }
        const dataset = await runtime.learning.store.writeDataset();
        notify(ctx, `Exported ${dataset.examples.length} redacted episode(s) to ${dataset.path}.`);
        return;
      }
      if (command.startsWith('promote ')) {
        if (!runtime?.learning.enabled) {
          notify(ctx, 'Enable local learning before promoting routes.');
          return;
        }
        try {
          const id = command.slice('promote '.length).trim();
          const promoted = await runtime.learning.store.promote(id);
          await load(ctx.cwd);
          notify(ctx, `Promoted ${promoted.id}; it is now active for exact matching.`);
        } catch (error) {
          notify(ctx, `Promotion failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
        }
        return;
      }
      const routeNames = runtime?.routes.map(route => route.id).join(', ') || 'none';
      const learningText = runtime?.learning.enabled ? ` · learning: local (${runtime.learning.store.directory})` : '';
      notify(ctx, `JBrancher ${runtime?.mode || 'inactive'} · routes: ${routeNames} · handled: ${stats.handled} · frontier: ${stats.fallback} · Jev choices: ${stats.jev}${learningText}`);
    }
  });
}
