import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createJevEvaluator } from './jev.js';

export function parseClaudeArgs(args) {
  if (args.shift() !== 'claude') throw new Error('Usage: jbrancher wrap claude [--mode shadow] [--max-evaluations 25] -- [Claude arguments]');
  let maxEvaluations = 25;
  while (args.length && args[0] !== '--') {
    const option = args.shift();
    if (option === '--mode') {
      if (args.shift() !== 'shadow') throw new Error('Only shadow mode is supported.');
    } else if (option === '--max-evaluations') {
      maxEvaluations = Number(args.shift());
    } else throw new Error('Unknown wrapper option. Put Claude arguments after --.');
  }
  if (args[0] === '--') args.shift();
  if (!Number.isSafeInteger(maxEvaluations) || maxEvaluations < 0 || maxEvaluations > 1000) {
    throw new Error('--max-evaluations must be an integer from 0 to 1000.');
  }
  if (args.some(arg => /^(--settings|--bare|--safe-mode)(=|$)/.test(arg))) {
    throw new Error('The wrapper owns --settings; --bare and --safe-mode disable its hooks.');
  }
  return { args, maxEvaluations };
}

// HTTP callbacks always return {}. Scores never become permission decisions.
export async function startClaudeShadow({ evaluate, maxEvaluations = 25, record = async () => {} }) {
  if (!Number.isSafeInteger(maxEvaluations) || maxEvaluations < 0 || maxEvaluations > 1000) throw new Error('Invalid evaluation budget');
  const token = randomBytes(32).toString('hex');
  const prompts = new Map();
  const pending = new Set();
  const stats = { observed: 0, evaluated: 0, skipped: 0, unavailable: 0, logErrors: 0 };
  const server = createServer(async (req, res) => {
    const reply = status => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end('{}'); };
    if (req.method !== 'POST' || req.url !== '/hooks' || req.headers.origin
      || req.headers.authorization !== `Bearer ${token}`) return reply(403);
    try {
      let body = '';
      req.setEncoding('utf8');
      for await (const chunk of req) {
        body += chunk.toString();
        if (Buffer.byteLength(body) > 65536) { reply(413); req.resume(); return; }
      }
      const input = JSON.parse(body);
      if (!input || typeof input !== 'object' || typeof input.session_id !== 'string') return reply(400);
      const key = `${input.session_id}:${input.prompt_id ?? ''}`;
      if (input.hook_event_name === 'UserPromptSubmit' && typeof input.prompt === 'string') {
        if (prompts.size >= 32) prompts.delete(prompts.keys().next().value);
        prompts.set(key, input.prompt.slice(0, 16000));
      }
      if (input.hook_event_name === 'PreToolUse') {
        stats.observed++;
        const prompt = prompts.get(key);
        if (!prompt || !evaluate || stats.evaluated >= maxEvaluations || pending.size >= 2
          || typeof input.tool_name !== 'string' || !input.tool_input) {
          stats.skipped++;
        } else {
          stats.evaluated++;
          const started = performance.now();
          const job = (async () => {
            let row;
            try {
              const verdict = await evaluate({ task: prompt,
                state: { contextLimit: 'Only the current user prompt and proposed tool are available. No repository contents or earlier tool results are provided.' },
                history: [], candidates: [{ tool: input.tool_name, args: input.tool_input }] });
              const score = verdict?.scores?.[0];
              if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) throw new Error('Invalid score');
              row = { status: 'scored', score };
            } catch { stats.unavailable++; row = { status: 'unavailable' }; }
            // Do not persist prompts, tool arguments, provider errors, or credentials.
            try { await record({ at: new Date().toISOString(), mode: 'shadow', ...row,
              latencyMs: Math.round(performance.now() - started), actorCallsAvoided: 0 }); }
            catch { stats.logErrors++; }
          })();
          pending.add(job);
          job.finally(() => pending.delete(job));
        }
      }
      reply(200);
    } catch { if (!res.headersSent) reply(400); }
  });
  server.requestTimeout = 5000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const settings = { hooks: Object.fromEntries(['UserPromptSubmit', 'PreToolUse'].map(event => [event, [{
    hooks: [{ type: 'http', url: `http://127.0.0.1:${server.address().port}/hooks`,
      headers: { Authorization: `Bearer ${token}` }, timeout: 2 }]
  }]])) };
  return { settings, stats, async close() {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await Promise.allSettled([...pending]);
    prompts.clear();
  } };
}

export async function wrapClaude({ args = [], maxEvaluations = 25,
  env = process.env, executable = process.platform === 'win32' ? 'claude.exe' : 'claude',
  evaluate, logDirectory = join(homedir(), '.jbrancher', 'sessions') } = {}) {
  if (maxEvaluations > 0 && !evaluate && !env.TYPESAFE_API_KEY) {
    throw new Error('Set TYPESAFE_API_KEY in .env, or use --max-evaluations 0 for local hook diagnostics.');
  }
  const evaluator = maxEvaluations === 0 ? undefined : evaluate ?? createJevEvaluator({
    apiKey: env.TYPESAFE_API_KEY, model: env.JBRANCHER_MODEL ?? 'jev-1.13.0', timeoutMs: 3000
  });
  await mkdir(logDirectory, { recursive: true, mode: 0o700 });
  const logPath = join(logDirectory, `${randomUUID()}.jsonl`);
  await writeFile(logPath, '', { mode: 0o600, flag: 'wx' });
  const temporary = await mkdtemp(join(tmpdir(), 'jbrancher-claude-'));
  let service;
  try {
    service = await startClaudeShadow({ evaluate: evaluator, maxEvaluations,
      record: row => appendFile(logPath, JSON.stringify(row) + '\n') });
    const settingsPath = join(temporary, 'settings.json');
    await writeFile(settingsPath, JSON.stringify(service.settings), { mode: 0o600 });
    const childEnv = { ...env };
    delete childEnv.TYPESAFE_API_KEY;
    console.error(`JBrancher shadow: up to ${maxEvaluations} TypeSafe evaluations. Scores: ${logPath}`);
    const child = spawn(executable, ['--settings', settingsPath, ...args], { stdio: 'inherit', env: childEnv, shell: false });
    const interrupt = () => child.kill('SIGINT');
    const terminate = () => child.kill('SIGTERM');
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    try {
      return await new Promise((resolve, reject) => {
        child.once('error', () => reject(new Error('Could not launch Claude Code. Install its native CLI and ensure claude is on PATH.')));
        child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 143)));
      });
    } finally {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
    }
  } finally {
    try {
      if (service) {
        await service.close();
        await appendFile(logPath, JSON.stringify({ mode: 'shadow', summary: service.stats, actorCallsAvoided: 0 }) + '\n');
        console.error(`JBrancher shadow: ${JSON.stringify(service.stats)}`);
      }
    } finally {
      await rm(join(temporary, 'settings.json'), { force: true });
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
