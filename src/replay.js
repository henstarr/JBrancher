import { execFile } from 'node:child_process';
import { realpath, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { relative, resolve } from 'node:path';
import { createLocalLearningStore, createLearnedRoutes, classifyActionSafety } from './learning.js';
import { createPiRouter } from './pi.js';

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 200_000;
const REPLAYABLE_MATCHERS = new Set(['normalized-exact', 'read-path']);

function withinRoot(root, target) {
  const path = relative(root, target);
  return path === '' || (!path.startsWith('..') && !path.includes(`..${'\\'}`) && !path.includes('../'));
}

async function createSafeFileReader(cwd) {
  const root = await realpath(resolve(cwd));
  return async (filePath, offset, limit) => {
    if (classifyActionSafety('read', { path: filePath }) !== 'read-only') {
      throw new Error('Learned replay rejected an unsafe file path');
    }
    const target = await realpath(resolve(root, filePath));
    if (!withinRoot(root, target)) throw new Error('Learned replay rejected a path outside the project');
    const contents = await readFile(target, 'utf8');
    if (Buffer.byteLength(contents, 'utf8') > MAX_OUTPUT_BYTES) {
      throw new Error('Learned replay rejected an oversized file');
    }
    if (offset === undefined && limit === undefined) return contents;
    const lines = contents.split(/\r?\n/);
    const start = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
    const end = Number.isSafeInteger(limit) && limit >= 0 ? start + limit : undefined;
    return lines.slice(start, end).join('\n');
  };
}

function createSafeExecutor(cwd) {
  return async (program, args = []) => {
    if (program !== 'bash' || !Array.isArray(args) || args[0] !== '-lc' || typeof args[1] !== 'string') {
      throw new Error('Learned replay only permits bounded bash inspection commands');
    }
    const result = await execFileAsync(process.platform === 'win32' ? 'bash.exe' : 'bash', args, {
      cwd: resolve(cwd),
      timeout: 5_000,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true
    }).catch(error => ({
      error,
      stdout: error.stdout || '',
      stderr: error.stderr || '',
      code: Number.isInteger(error.code) ? error.code : 1
    }));
    if (result.error || result.code !== 0) {
      throw new Error(result.stderr || result.error?.message || `bash exited with code ${result.code}`);
    }
    return { code: 0, stdout: result.stdout || '', stderr: result.stderr || '' };
  };
}

/**
 * Try a local, already-promoted read-only route for an explicit task.
 *
 * This is intentionally stricter than the general learning runtime: wrappers
 * do not have a live harness candidate set, so only exact and path-parameterized
 * read-only routes are eligible. A miss is a normal result and must launch the
 * caller's frontier actor.
 */
export async function replayLearnedTask({
  task,
  directory = '.jbrancher',
  cwd = process.cwd(),
  minimumObservations = 2
} = {}) {
  if (typeof task !== 'string' || !task.trim()) return { handled: false, reason: 'No task supplied' };
  if (!Number.isSafeInteger(minimumObservations) || minimumObservations < 1) {
    throw new TypeError('minimumObservations must be a positive integer');
  }
  try {
    const store = createLocalLearningStore({ directory });
    const records = (await store.readRoutes()).filter(record => record?.status === 'active'
      && record.safety === 'read-only'
      && Number.isSafeInteger(record.observations)
      && record.observations >= minimumObservations
      && REPLAYABLE_MATCHERS.has(record.matcher?.type));
    if (records.length === 0) return { handled: false, reason: 'No eligible local route' };
    const routes = createLearnedRoutes(records);
    if (routes.length === 0) return { handled: false, reason: 'No replayable local route' };
    const router = createPiRouter({ routes });
    const result = await router.handle({
      task,
      readFile: await createSafeFileReader(cwd),
      exec: createSafeExecutor(cwd)
    });
    if (!result.routeId) return { handled: false, reason: result.reason || 'No local route matched' };
    return { handled: true, routeId: result.routeId, source: 'learned', result: result.result };
  } catch {
    // The local cache is advisory. A malformed or unavailable cache must
    // never prevent the frontier wrapper from launching.
    return { handled: false, reason: 'Local replay unavailable' };
  }
}
