import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createJevEvaluator } from './jev.js';
import { createEpisodeRecorder, createLocalLearningStore, refreshAndPromoteReadOnly } from './learning.js';
import { replayLearnedTask } from './replay.js';

export function parseCodexArgs(args) {
  if (args.shift() !== 'codex') throw new Error('Expected codex');
  let prompt, maxEvaluations = 25, mode = 'shadow';
  while (args.length && args[0] !== '--') {
    const option = args.shift();
    if (option === '--prompt') prompt = args.shift();
    else if (option === '--max-evaluations') maxEvaluations = Number(args.shift());
    else if (option === '--mode') {
      mode = args.shift();
      if (!['shadow', 'adaptive'].includes(mode)) throw new Error('Mode must be shadow or adaptive.');
    } else throw new Error('Use --prompt "task"; put Codex exec options after --.');
  }
  if (!prompt?.trim()) throw new Error('Codex wrapper requires --prompt "task". Interactive sessions and resume are not supported.');
  if (!Number.isSafeInteger(maxEvaluations) || maxEvaluations < 0 || maxEvaluations > 1000) throw new Error('Invalid evaluation budget (0–1000).');
  if (args[0] === '--') args.shift();
  return { prompt, maxEvaluations, args, mode };
}

// Stream observation only: never feeds a score back into Codex.
export function createCodexObserver({ prompt, evaluate, maxEvaluations = 25, record = async () => {}, learningStore, cwd = process.cwd() }) {
  if (!Number.isSafeInteger(maxEvaluations) || maxEvaluations < 0 || maxEvaluations > 1000) throw new Error('Invalid evaluation budget');
  const seen = new Set(), completed = new Set(), scored = new Set(), pending = new Set();
  const stats = { observed: 0, evaluated: 0, skipped: 0, unavailable: 0, logErrors: 0 };
  const recorder = learningStore ? createEpisodeRecorder({ store: learningStore, task: prompt, cwd, source: 'codex' }) : null;
  return {
    stats,
    observe(event) {
      const item = event?.item;
      if (!['item.started', 'item.completed'].includes(event?.type) || item?.type !== 'command_execution'
        || typeof item.id !== 'string' || typeof item.command !== 'string') return;
      const isCompleted = event.type === 'item.completed';
      if (isCompleted && completed.has(item.id)) return;
      if (!seen.has(item.id)) {
        seen.add(item.id);
        stats.observed++;
        recorder?.recordToolCall({ toolCallId: item.id, toolName: 'bash', input: { command: item.command } });
      }
      if (isCompleted) {
        completed.add(item.id);
        recorder?.recordToolResult({
          toolCallId: item.id,
          isError: item.status === 'failed' || item.status === 'error',
          output: item.aggregated_output ?? item.output ?? item.result ?? item.status
        });
      }
      if (scored.has(item.id)) return;
      scored.add(item.id);
      if (!evaluate || stats.evaluated >= maxEvaluations || pending.size >= 2 || item.command.length > 16000) {
        stats.skipped++; return;
      }
      stats.evaluated++;
      const started = performance.now();
      const job = (async () => {
        let row;
        try {
          const result = await evaluate({ task: prompt.slice(0, 16000),
            state: { contextLimit: 'Only the initial task and observed command are available. No repository contents or prior results. Observation may occur after execution started.' },
            history: [], candidates: [{ tool: 'command_execution', args: { command: item.command } }] });
          const score = result?.scores?.[0];
          if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) throw new Error('Invalid score');
          row = { status: 'scored', score };
        } catch { stats.unavailable++; row = { status: 'unavailable' }; }
        try { await record({ at: new Date().toISOString(), harness: 'codex', mode: 'shadow', ...row,
          latencyMs: Math.round(performance.now() - started), actorCallsAvoided: 0 }); }
        catch { stats.logErrors++; }
      })();
      pending.add(job);
      job.finally(() => pending.delete(job));
    },
    async close() {
      await Promise.allSettled([...pending]);
      try {
        const saved = await recorder?.finish({ metadata: { hookHarness: 'codex' } });
        if (saved?.outcome === 'success' && typeof learningStore?.refreshCandidates === 'function') {
          await refreshAndPromoteReadOnly(learningStore);
        }
      }
      catch { stats.logErrors++; }
      seen.clear(); completed.clear(); scored.clear();
    }
  };
}

// Discard oversized lines for observation, but still forward every byte to stdout.
export function createEventDecoder(observe, limit = 65536) {
  let buffer = '', dropping = false;
  return chunk => {
    for (const segment of chunk.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
      const ended = segment.endsWith('\n');
      if (!dropping) {
        buffer += segment;
        if (buffer.length > limit) { buffer = ''; dropping = true; }
      }
      if (ended) {
        if (!dropping) { try { observe(JSON.parse(buffer)); } catch { /* Non-JSON diagnostics are not events. */ } }
        buffer = ''; dropping = false;
      }
    }
  };
}

export async function wrapCodex({ prompt, args = [], maxEvaluations = 25, env = process.env,
  executable = process.platform === 'win32' ? 'codex.exe' : 'codex', evaluate,
  logDirectory = join(homedir(), '.jbrancher', 'sessions'), output = process.stdout,
  learning = env.JBRANCHER_LEARNING === '1', learningDirectory = join(process.cwd(), '.jbrancher'),
  mode = 'shadow' } = {}) {
  if (!prompt?.trim()) throw new Error('A prompt is required.');
  if (!['shadow', 'adaptive'].includes(mode)) throw new Error('Mode must be shadow or adaptive.');
  if (mode === 'adaptive') {
    const replay = await replayLearnedTask({ task: prompt, directory: learningDirectory, cwd: process.cwd() });
    if (replay.handled) {
      const threadId = `jbrancher-${randomUUID()}`;
      const itemId = `${threadId}-result`;
      output.write(`${JSON.stringify({ type: 'thread.started', thread_id: threadId })}\n`);
      output.write(`${JSON.stringify({ type: 'item.completed', item: {
        id: itemId, type: 'agent_message', text: typeof replay.result === 'string'
          ? replay.result : JSON.stringify(replay.result, null, 2)
      } })}\n`);
      output.write(`${JSON.stringify({ type: 'turn.completed', usage: {
        input_tokens: 0, output_tokens: 0, cached_input_tokens: 0
      } })}\n`);
      console.error(`JBrancher adaptive replay: ${replay.routeId}`);
      return 0;
    }
  }
  if (maxEvaluations > 0 && !evaluate && !env.TYPESAFE_API_KEY) throw new Error('Set TYPESAFE_API_KEY in .env, or use --max-evaluations 0.');
  const evaluator = maxEvaluations === 0 ? undefined : evaluate ?? createJevEvaluator({
    apiKey: env.TYPESAFE_API_KEY, model: env.JBRANCHER_MODEL ?? 'jev-1.13.0', timeoutMs: 3000 });
  await mkdir(logDirectory, { recursive: true, mode: 0o700 });
  const logPath = join(logDirectory, `${randomUUID()}.jsonl`);
  await writeFile(logPath, '', { flag: 'wx', mode: 0o600 });
  const learningStore = (learning || mode === 'adaptive')
    ? createLocalLearningStore({ directory: learningDirectory }) : undefined;
  const observer = createCodexObserver({ prompt, evaluate: evaluator, maxEvaluations,
    record: row => appendFile(logPath, JSON.stringify(row) + '\n'), learningStore });
  const childEnv = { ...env };
  delete childEnv.TYPESAFE_API_KEY;
  console.error(`JBrancher Codex ${mode}: up to ${maxEvaluations} evaluations. Scores: ${logPath}`);
  // Prompt via stdin avoids positional ambiguity and never inherits unrelated piped input.
  const child = spawn(executable, ['exec', ...args, '--json', '-'], { env: childEnv, stdio: ['pipe', 'pipe', 'inherit'], shell: false });
  const decode = createEventDecoder(event => observer.observe(event));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    decode(chunk);
    if (!output.write(chunk)) child.stdout.pause();
  });
  const drain = () => child.stdout.resume();
  output.on('drain', drain);
  child.stdin.on('error', () => {}); // Early CLI exit can close stdin before reading.
  child.stdin.end(prompt);
  const interrupt = () => child.kill('SIGINT'), terminate = () => child.kill('SIGTERM');
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', () => reject(new Error('Could not launch Codex. Install its native CLI and ensure codex is on PATH.')));
      child.once('close', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 143)));
    });
  } finally {
    process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); output.off('drain', drain);
    await observer.close();
    await appendFile(logPath, JSON.stringify({ harness: 'codex', mode, summary: observer.stats, actorCallsAvoided: 0 }) + '\n');
    console.error(`JBrancher Codex ${mode}: ${JSON.stringify(observer.stats)}`);
  }
}
