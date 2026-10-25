import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { compactMarkdown, createMarkdownTokenCounter, createOpenAIEmbeddingVerifier, verifyMarkdown } from './markdown.js';

const EXCLUDED = new Set(['.git', 'node_modules', '.jbrancher', 'results', 'coverage']);
const markdown = path => /\.(?:md|markdown)$/i.test(path);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, path) => {
  const suffix = relative(root, path);
  return suffix === '' || (suffix !== '..' && !suffix.startsWith('..' + sep) && !isAbsolute(suffix));
};

async function canonicalPath(path) {
  try { return await realpath(path); }
  catch (error) {
    if (error.code !== 'ENOENT' || dirname(path) === path) throw error;
    return join(await canonicalPath(dirname(path)), basename(path));
  }
}

async function inventory(root) {
  if (!(await lstat(root)).isDirectory() || (await lstat(root)).isSymbolicLink()) throw new Error('Input/candidate must be a real directory');
  const files = new Map();
  let bytes = 0;
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (EXCLUDED.has(entry.name) || /^\.env(?:\.|$)/.test(entry.name) && entry.name !== '.env.example') continue;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Symbolic links are not supported in a compaction tree');
      if (entry.isDirectory()) { await walk(path); continue; }
      if (!entry.isFile()) throw new Error('Only regular files are supported in a compaction tree');
      const metadata = await lstat(path);
      bytes += metadata.size;
      if (files.size >= 10_000 || bytes > 256 * 1024 * 1024 || markdown(entry.name) && metadata.size > 2 * 1024 * 1024) {
        throw new Error('Compaction tree exceeds its file/size limits');
      }
      const content = await readFile(path);
      if (markdown(entry.name) && content.includes(0)) throw new Error('Markdown must be UTF-8 text');
      const text = markdown(entry.name) ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content) : null;
      files.set(relative(root, path), { content, text, mode: metadata.mode & 0o777 });
    }
  }
  await walk(root);
  if (![...files.keys()].some(markdown)) throw new Error('The input contains no Markdown files');
  return files;
}

async function materialize(files, root, sourceRoot) {
  await mkdir(root, { recursive: true });
  for (const [path, file] of files) {
    const destination = join(root, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, file.content, { mode: file.mode });
    await chmod(destination, file.mode);
  }
  // User-owned dependencies remain shared; temporary copies are not security sandboxes.
  if (sourceRoot) {
    const dependencies = join(sourceRoot, 'node_modules');
    try {
      if ((await lstat(dependencies)).isDirectory()) await symlink(dependencies, join(root, 'node_modules'), 'dir');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function validateTestConfig(config) {
  if (!config || !Array.isArray(config.commands) || !config.commands.length || config.commands.length > 16) {
    throw new Error('Test configuration requires 1-16 named commands');
  }
  const names = new Set();
  for (const command of config.commands) {
    if (typeof command.name !== 'string' || !command.name.trim() || names.has(command.name)
      || command.name.length > 100 || !Array.isArray(command.command) || !command.command.length
      || command.command.length > 128 || !command.command.every(value => typeof value === 'string' && value.length > 0 && value.length <= 16_384)
      || !['exit-code', 'json'].includes(command.format ?? 'exit-code')) throw new Error('Invalid or duplicate test command');
    names.add(command.name);
    if (command.timeoutMs !== undefined && (!Number.isSafeInteger(command.timeoutMs) || command.timeoutMs < 1 || command.timeoutMs > 600_000)) {
      throw new Error('Invalid test timeout');
    }
  }
}

function execute(command, cwd, targetModel) {
  return new Promise(resolveResult => {
    let child;
    let stdout = '';
    let blocked = null;
    let settled = false;
    const finish = result => { if (!settled) { settled = true; resolveResult(result); } };
    const terminate = () => {
      try { if (process.platform === 'win32') child.kill('SIGKILL'); else process.kill(-child.pid, 'SIGKILL'); } catch { /* Process already exited. */ }
    };
    try {
      child = spawn(command.command[0], command.command.slice(1), {
        cwd, shell: false, detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, JBRANCHER_MARKDOWN_ROOT: cwd, JBRANCHER_TARGET_MODEL: targetModel ?? '' }
      });
    } catch { finish({ status: 'blocked', reason: 'test-command-start-failed' }); return; }
    const timeout = setTimeout(() => { blocked = 'test-command-timeout'; terminate(); }, command.timeoutMs ?? 60_000);
    let outputBytes = 0;
    const receive = (chunk, keep) => {
      outputBytes += chunk.length;
      if (outputBytes > 1024 * 1024) { blocked = 'test-output-limit'; terminate(); }
      else if (keep) stdout += chunk;
    };
    child.stdout.on('data', chunk => receive(chunk, true));
    child.stderr.on('data', chunk => receive(chunk, false));
    child.once('error', () => {
      clearTimeout(timeout);
      finish({ status: 'blocked', reason: 'test-command-start-failed' });
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (blocked || signal || code === null) { finish({ status: 'blocked', reason: blocked ?? 'test-command-signal' }); return; }
      if ((command.format ?? 'exit-code') === 'exit-code') {
        finish({ status: 'complete', tests: [{ id: command.name, status: code === 0 ? 'passed' : 'failed' }] });
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        const ids = new Set();
        if (!Array.isArray(parsed.tests) || !parsed.tests.length || parsed.tests.length > 100_000) throw new Error();
        for (const item of parsed.tests) {
          if (typeof item.id !== 'string' || !item.id || item.id.length > 300 || ids.has(item.id)
            || !['passed', 'failed', 'skipped'].includes(item.status)) throw new Error();
          ids.add(item.id);
        }
        const failed = parsed.tests.some(item => item.status === 'failed');
        if (code === 0 && failed || code !== 0 && !failed) throw new Error();
        finish({ status: 'complete', tests: parsed.tests.map(({ id, status }) => ({ id, status })) });
      } catch { finish({ status: 'blocked', reason: 'invalid-test-report' }); }
    });
  });
}

export async function runMarkdownBehavioralGate({ baseline, candidate, sourceRoot, config, targetModel }) {
  if (!config) return { status: 'skipped', reason: 'bring-your-own-tests-not-configured', newRegressions: null };
  validateTestConfig(config);
  const temporary = await mkdtemp(join(tmpdir(), 'jbrancher-markdown-tests-'));
  const results = [];
  try {
    for (const command of config.commands) {
      // Every command gets a fresh pair, so a previous test cannot mutate the next baseline.
      const root = join(temporary, String(results.length));
      const beforeRoot = join(root, 'baseline');
      const afterRoot = join(root, 'candidate');
      await materialize(baseline, beforeRoot, sourceRoot);
      await materialize(candidate, afterRoot, sourceRoot);
      const before = await execute(command, beforeRoot, targetModel);
      const after = await execute(command, afterRoot, targetModel);
      if (before.status !== 'complete' || after.status !== 'complete') {
        results.push({ name: command.name, status: 'blocked', baseline: before.status, candidate: after.status,
          reason: before.reason ?? after.reason });
        continue;
      }
      const original = new Map(before.tests.map(item => [item.id, item.status]));
      const updated = new Map(after.tests.map(item => [item.id, item.status]));
      const regressions = [...updated].filter(([id, status]) => status === 'failed' && original.get(id) !== 'failed').map(([id]) => id);
      const lostCoverage = [...original].filter(([id, status]) => !updated.has(id) || status === 'passed' && updated.get(id) !== 'passed').map(([id]) => id);
      const baselineFailures = before.tests.filter(item => item.status === 'failed').map(item => item.id);
      const hasPassingBaseline = before.tests.some(item => item.status === 'passed');
      const opaqueFailure = (command.format ?? 'exit-code') !== 'json' && baselineFailures.length > 0;
      const blocked = opaqueFailure || !hasPassingBaseline || baselineFailures.length > 0 && config.allowBaselineFailures !== true;
      results.push({ name: command.name,
        status: regressions.length || lostCoverage.length ? 'failed' : blocked ? 'blocked' : 'passed',
        baselineFailures, regressions, lostCoverage,
        reason: opaqueFailure ? 'baseline-failure-requires-per-test-json' : blocked ? 'baseline-not-accepted' : undefined,
        baselineTests: before.tests.length, candidateTests: after.tests.length });
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
  const status = results.some(result => result.status === 'failed') ? 'failed'
    : results.some(result => result.status === 'blocked') ? 'blocked' : 'passed';
  return { status, newRegressions: results.some(result => result.status === 'blocked') ? null
    : results.reduce((total, result) => total + new Set([...(result.regressions ?? []), ...(result.lostCoverage ?? [])]).size, 0), commands: results };
}

export async function verifyMarkdownTree({ input, candidate: candidatePath, output, tests, embed,
  encoding = 'cl100k_base', embeddingModel = 'text-embedding-3-small', targetModel = null,
  minimumSimilarity = 0.98, minimumReduction = 0 } = {}) {
  const rawSourceRoot = resolve(input);
  if ((await lstat(rawSourceRoot)).isSymbolicLink()) throw new Error('Input/candidate must be a real directory');
  const sourceRoot = await realpath(rawSourceRoot);
  if (Boolean(candidatePath) === Boolean(output)) throw new Error('Choose exactly one of --output or --candidate');
  const rawDestination = resolve(candidatePath ?? output);
  if (candidatePath && (await lstat(rawDestination)).isSymbolicLink()) throw new Error('Input/candidate must be a real directory');
  const destination = await canonicalPath(rawDestination);
  if (inside(sourceRoot, destination) || inside(destination, sourceRoot)) throw new Error('Input and candidate/output directories must be disjoint');
  if (!Number.isFinite(minimumReduction) || minimumReduction < 0 || minimumReduction >= 1) throw new Error('Minimum reduction must be in [0, 1)');
  if (tests) validateTestConfig(tests);
  const baseline = await inventory(sourceRoot);
  let candidate;
  if (output) {
    try { await lstat(destination); throw new Error('Output must not already exist'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    candidate = new Map([...baseline].map(([path, file]) => [path, { ...file,
      content: file.text === null ? file.content : Buffer.from(compactMarkdown(file.text)) }]));
    for (const file of candidate.values()) if (file.text !== null) file.text = file.content.toString('utf8');
    await materialize(candidate, destination);
  } else candidate = await inventory(destination);
  const changes = [];
  for (const path of new Set([...baseline.keys(), ...candidate.keys()])) {
    const before = baseline.get(path);
    const after = candidate.get(path);
    if (!before || !after) { changes.push({ path, reason: 'file-set-changed' }); continue; }
    if (before.mode !== after.mode) changes.push({ path, reason: 'file-permissions-changed' });
    if (!markdown(path) && !before.content.equals(after.content)) changes.push({ path, reason: 'non-markdown-file-changed' });
  }
  const countTokens = createMarkdownTokenCounter(encoding);
  const files = [];
  for (const [path, before] of baseline) {
    if (!markdown(path) || !candidate.has(path)) continue;
    const after = candidate.get(path);
    const result = await verifyMarkdown({ original: before.text, candidate: after.text,
      embed: changes.length ? undefined : embed, countTokens, minimumSimilarity });
    files.push({ path, originalSha256: hash(before.content), candidateSha256: hash(after.content), ...result });
  }
  const structural = { status: changes.length || files.some(file => file.structural.status !== 'passed') ? 'failed' : 'passed', changes };
  let semantic = { status: 'skipped', reason: 'structural-gate-failed' };
  if (structural.status === 'passed') semantic = {
    status: files.some(file => file.semantic.status === 'blocked') ? 'blocked'
      : files.some(file => file.semantic.status === 'failed') ? 'failed' : 'passed', model: embeddingModel, minimumSimilarity,
    embeddingCheckedFiles: files.filter(file => file.semantic.status === 'passed' && file.semantic.reason !== 'byte-identical').length,
    byteIdenticalFiles: files.filter(file => file.semantic.reason === 'byte-identical').length
  };
  const behavioral = structural.status === 'passed' && semantic.status === 'passed'
    ? await runMarkdownBehavioralGate({ baseline, candidate, sourceRoot, config: tests, targetModel })
    : { status: 'skipped', reason: 'prior-verification-gate-not-passed', newRegressions: null };
  const inputTokens = files.reduce((total, file) => total + file.inputTokens, 0);
  const outputTokens = files.reduce((total, file) => total + file.outputTokens, 0);
  const reduction = inputTokens ? (inputTokens - outputTokens) / inputTokens : 0;
  const budget = { status: reduction >= minimumReduction ? 'passed' : 'failed', minimumReduction };
  const layers = { structural, semantic, behavioral };
  const states = Object.values(layers).map(layer => layer.status);
  const accepted = states.every(status => status === 'passed') && budget.status === 'passed';
  return { schemaVersion: 1, accepted, status: accepted ? 'passed'
    : states.includes('failed') || budget.status === 'failed' ? 'failed' : 'incomplete',
  sourceRoot, candidateRoot: destination, targetModel, encoding, embeddingModel,
  markdownFiles: files.length, inputTokens, outputTokens, savedTokens: inputTokens - outputTokens, reduction,
  layers, budget, files,
  limitations: ['Embedding similarity is a screening signal, not proof of behavioral equivalence.',
    'Behavioral evidence covers only the explicitly configured tests.',
    'Generated output remains a candidate until accepted and reviewed.'] };
}

export async function runMarkdownCli(args) {
  if (!args.length || args.includes('--help')) {
    console.log('jbrancher compact --input DIR (--output NEW_DIR | --candidate DIR) [--tests CONFIG.json] [--report FILE.json] [--offline] [--min-similarity 0.98] [--min-reduction 0] [--encoding cl100k_base] [--embedding-model text-embedding-3-small] [--target-model MODEL]');
    return 0;
  }
  const flags = new Set(['--input', '--output', '--candidate', '--tests', '--report', '--min-similarity', '--min-reduction', '--encoding', '--embedding-model', '--target-model']);
  const options = {};
  let offline = false;
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === '--offline') { offline = true; continue; }
    if (!flags.has(key) || options[key] !== undefined || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Invalid compact argument: ${key}`);
    options[key] = args[++index];
  }
  if (!options['--input']) throw new Error('--input is required');
  const embeddingModel = options['--embedding-model'] ?? 'text-embedding-3-small';
  let embed;
  if (!offline && process.env.OPENAI_API_KEY?.trim()) embed = createOpenAIEmbeddingVerifier({ model: embeddingModel });
  const tests = options['--tests'] ? JSON.parse(await readFile(resolve(options['--tests']), 'utf8')) : undefined;
  const sourceRoot = resolve(options['--input']);
  const sourceForReport = await canonicalPath(sourceRoot);
  const destination = await canonicalPath(resolve(options['--output'] ?? options['--candidate'] ?? '.'));
  const reportPath = options['--report'] ? await canonicalPath(resolve(options['--report'])) : null;
  if (reportPath && (inside(sourceForReport, reportPath) || inside(destination, reportPath))) throw new Error('Report must be outside both verification trees');
  const report = await verifyMarkdownTree({ input: sourceRoot, output: options['--output'], candidate: options['--candidate'],
    tests, embed, encoding: options['--encoding'], embeddingModel, targetModel: options['--target-model'],
    minimumSimilarity: Number(options['--min-similarity'] ?? 0.98), minimumReduction: Number(options['--min-reduction'] ?? 0) });
  const serialized = JSON.stringify(report, null, 2);
  if (reportPath) { await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, serialized + '\n'); }
  console.log(serialized);
  return report.accepted ? 0 : report.status === 'failed' ? 1 : 2;
}
