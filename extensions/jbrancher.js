import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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
    const contents = await readFile(join(cwd, '.env'), 'utf8');
    for (const line of contents.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || match[1] in process.env) continue;
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
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
    const routes = [
      ...(config.includeBuiltins === false ? [] : builtInRoutes()),
      ...(config.routes ?? [])
    ];
    const evaluate = evaluationForEnvironment();
    const mode = process.env.JBRANCHER_PI_MODE || config.mode || 'active';
    if (!['active', 'shadow'].includes(mode)) throw new TypeError('JBRANCHER_PI_MODE must be active or shadow');
    runtime = {
      mode,
      evaluate,
      routes,
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
      notify(ctx, `JBrancher loaded ${runtime.routes.length} deterministic route(s). Non-matches stay on Pi's frontier model.`);
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
    let outcome;
    try {
      outcome = await runtime.router.handle({
        task: event.text,
        state: { cwd: ctx.cwd, mode: ctx.mode },
        signal: ctx.signal,
        exec: (program, args = []) => pi.exec(program, args)
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

  pi.registerCommand('jbrancher', {
    description: 'Show or reload JBrancher deterministic routing',
    handler: async (args, ctx) => {
      if ((args || '').trim() === 'reload') {
        try {
          await load(ctx.cwd);
          notify(ctx, `JBrancher reloaded ${runtime.routes.length} deterministic route(s).`);
        } catch (error) {
          notify(ctx, `JBrancher reload failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
        }
        return;
      }
      const routeNames = runtime?.routes.map(route => route.id).join(', ') || 'none';
      notify(ctx, `JBrancher ${runtime?.mode || 'inactive'} · routes: ${routeNames} · handled: ${stats.handled} · frontier: ${stats.fallback} · Jev choices: ${stats.jev}`);
    }
  });
}
