import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runMarkdownBehavioralGate, verifyMarkdownTree } from '../src/markdown-cli.js';

const sameMeaning = async inputs => inputs.map(() => [1, 0]);
const sourceText = '# Overview\n\nThis system is able to process a large number of records.\n\n## Safety\n\nNever publish credentials.\n';
const checkScript = `const fs = require('node:fs');
const text = fs.readFileSync('SKILL.md', 'utf8');
const tests = [{id:'guardrail',status:text.includes('Never publish credentials.')?'passed':'failed'}];
console.log(JSON.stringify({tests}));
process.exitCode=tests.some(t=>t.status==='failed')?1:0;
`;
const testConfig = { commands: [{ name: 'skill-contract', command: [process.execPath, 'check.cjs'], format: 'json' }] };

async function fixture(action) {
  const root = await mkdtemp(join(tmpdir(), 'jbrancher-markdown-gate-test-'));
  const input = join(root, 'input');
  const output = join(root, 'output');
  await mkdir(input);
  await writeFile(join(input, 'SKILL.md'), sourceText);
  await writeFile(join(input, 'check.cjs'), checkScript);
  await chmod(join(input, 'check.cjs'), 0o755);
  try { return await action({ root, input, output }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('whole-tree gate creates a separate accepted candidate, retaining scripts and all three gates', async () => fixture(async ({ input, output }) => {
  const report = await verifyMarkdownTree({ input, output, embed: sameMeaning, tests: testConfig, targetModel: 'caller-selected-model' });
  assert.equal(report.accepted, true);
  assert.equal(report.layers.structural.status, 'passed');
  assert.equal(report.layers.semantic.status, 'passed');
  assert.equal(report.layers.behavioral.status, 'passed');
  assert.equal(report.layers.behavioral.newRegressions, 0);
  assert.ok(report.savedTokens > 0);
  assert.equal(await readFile(join(input, 'SKILL.md'), 'utf8'), sourceText);
  assert.equal(await readFile(join(output, 'check.cjs'), 'utf8'), checkScript);
  assert.equal((await lstat(join(output, 'check.cjs'))).mode & 0o777, 0o755);
  assert.equal(report.targetModel, 'caller-selected-model');
}));

test('a missing BYO test layer is explicitly skipped and never accepted', async () => fixture(async ({ input, output }) => {
  const report = await verifyMarkdownTree({ input, output, embed: sameMeaning });
  assert.equal(report.accepted, false);
  assert.equal(report.status, 'incomplete');
  assert.equal(report.layers.behavioral.status, 'skipped');
  assert.equal(report.layers.behavioral.newRegressions, null);
}));

test('missing live embeddings block changed prose and do not claim behavioral success', async () => fixture(async ({ input, output }) => {
  const report = await verifyMarkdownTree({ input, output, tests: testConfig });
  assert.equal(report.accepted, false);
  assert.equal(report.layers.semantic.status, 'blocked');
  assert.equal(report.layers.behavioral.status, 'skipped');
}));

for (const change of ['modified-script', 'deleted-script', 'added-file', 'permissions', 'changed-guardrail']) {
  test(`external upgrade gate rejects ${change}`, async () => fixture(async ({ input, output }) => {
    await verifyMarkdownTree({ input, output, embed: sameMeaning });
    if (change === 'modified-script') await writeFile(join(output, 'check.cjs'), '// changed script');
    if (change === 'deleted-script') await rm(join(output, 'check.cjs'));
    if (change === 'added-file') await writeFile(join(output, 'new-script.sh'), 'echo new');
    if (change === 'permissions') await chmod(join(output, 'check.cjs'), 0o644);
    if (change === 'changed-guardrail') await writeFile(join(output, 'SKILL.md'), sourceText.replace('Never', 'Always'));
    let called = false;
    const report = await verifyMarkdownTree({ input, candidate: output, tests: testConfig,
      embed: async inputs => { called = true; return sameMeaning(inputs); } });
    assert.equal(report.accepted, false);
    assert.equal(report.layers.structural.status, 'failed');
    assert.equal(report.layers.behavioral.status, 'skipped');
    assert.equal(called, false);
  }));
}

test('a target token-reduction budget is enforced on the verified candidate', async () => fixture(async ({ input, output }) => {
  const report = await verifyMarkdownTree({ input, output, embed: sameMeaning, tests: testConfig, minimumReduction: 0.9 });
  assert.equal(report.accepted, false);
  assert.equal(report.budget.status, 'failed');
  assert.equal(report.status, 'failed');
}));

test('input/output overlap, existing output, symlinks and malformed test config are rejected', async () => fixture(async ({ root, input, output }) => {
  await assert.rejects(() => verifyMarkdownTree({ input, output: join(input, 'candidate') }), /disjoint/);
  await assert.rejects(() => verifyMarkdownTree({ input, candidate: input }), /disjoint/);
  await assert.rejects(() => verifyMarkdownTree({ input, output, tests: { commands: [] } }), /named commands/);
  await mkdir(output);
  await assert.rejects(() => verifyMarkdownTree({ input, output }), /already exist/);
  await symlink(join(input, 'SKILL.md'), join(input, 'linked.md'));
  await assert.rejects(() => verifyMarkdownTree({ input, output: join(root, 'other') }), /Symbolic links/);
}));

test('dot-prefixed child names and symlinked parents cannot bypass disjoint-tree checks', async () => fixture(async ({ root, input }) => {
  await assert.rejects(() => verifyMarkdownTree({ input, output: join(input, '..candidate') }), /disjoint/);
  const alias = join(root, 'alias');
  await symlink(input, alias, 'dir');
  await assert.rejects(() => verifyMarkdownTree({ input, output: join(alias, 'candidate') }), /disjoint/);
  const linkedInput = spawnSync(process.execPath, ['bin/jbrancher.js', 'compact', '--input', alias, '--output', join(root, 'other-candidate'), '--offline'], { encoding: 'utf8' });
  assert.equal(linkedInput.status, 2);
  assert.match(linkedInput.stderr, /real directory/);
  const cli = spawnSync(process.execPath, ['bin/jbrancher.js', 'compact', '--input', input, '--output', join(root, 'candidate'), '--report', join(alias, '..report.json')], { encoding: 'utf8' });
  assert.equal(cli.status, 2);
  assert.match(cli.stderr, /Report must be outside/);
}));

function files(text, script) {
  return new Map([
    ['SKILL.md', { content: Buffer.from(text), text, mode: 0o644 }],
    ['check.cjs', { content: Buffer.from(script), text: null, mode: 0o755 }]
  ]);
}

const identifiedScript = `const fs=require('node:fs');
const text=fs.readFileSync('SKILL.md','utf8');
const tests=[{id:'kept',status:'passed'},{id:'legacy',status:'failed'},{id:'meaning',status:text.includes('alpha')?'passed':'failed'}];
console.log(JSON.stringify({tests}));process.exitCode=1;`;

test('known baseline failures require explicit acceptance and per-test identities', async () => {
  const baseline = files('alpha', identifiedScript);
  const candidate = files('alpha', identifiedScript);
  const base = { baseline, candidate, config: { commands: [{ name: 'contract', command: [process.execPath, 'check.cjs'], format: 'json' }] } };
  const blocked = await runMarkdownBehavioralGate(base);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.newRegressions, null);
  const accepted = await runMarkdownBehavioralGate({ ...base, config: { ...base.config, allowBaselineFailures: true } });
  assert.equal(accepted.status, 'passed');
  assert.equal(accepted.newRegressions, 0);
  assert.deepEqual(accepted.commands[0].baselineFailures, ['legacy']);
});

test('identical process exit codes cannot mask new failures in named behavioral tests', async () => {
  const report = await runMarkdownBehavioralGate({ baseline: files('alpha', identifiedScript), candidate: files('beta', identifiedScript),
    config: { allowBaselineFailures: true, commands: [{ name: 'contract', command: [process.execPath, 'check.cjs'], format: 'json' }] } });
  assert.equal(report.status, 'failed');
  assert.equal(report.newRegressions, 1);
  assert.deepEqual(report.commands[0].regressions, ['meaning']);
});

test('matching failed exit-code-only commands stay blocked instead of zero regressions', async () => {
  const tree = files('alpha', 'process.exitCode=1;');
  const report = await runMarkdownBehavioralGate({ baseline: tree, candidate: tree,
    config: { allowBaselineFailures: true, commands: [{ name: 'opaque', command: [process.execPath, 'check.cjs'] }] } });
  assert.equal(report.status, 'blocked');
  assert.equal(report.newRegressions, null);
  assert.equal(report.commands[0].reason, 'baseline-failure-requires-per-test-json');
});

test('removing or skipping a previously passing behavioral test fails the gate', async () => {
  for (const status of ['missing', 'skipped']) {
    const script = `const fs=require('node:fs');const changed=fs.readFileSync('SKILL.md','utf8')==='beta';
const tests=changed?${status === 'missing' ? '[{id:"kept",status:"passed"}]' : '[{id:"kept",status:"passed"},{id:"contract",status:"skipped"}]'}:[{id:'kept',status:'passed'},{id:'contract',status:'passed'}];
console.log(JSON.stringify({tests}));`;
    const report = await runMarkdownBehavioralGate({ baseline: files('alpha', script), candidate: files('beta', script),
      config: { commands: [{ name: 'coverage', command: [process.execPath, 'check.cjs'], format: 'json' }] } });
    assert.equal(report.status, 'failed');
    assert.deepEqual(report.commands[0].lostCoverage, ['contract']);
  }
});

for (const [name, command, script, reason] of [
  ['missing executable', ['jbrancher-missing-executable-39217'], '', 'test-command-start-failed'],
  ['timeout', [process.execPath, 'check.cjs'], 'setInterval(()=>{},1000);', 'test-command-timeout'],
  ['invalid JSON', [process.execPath, 'check.cjs'], 'console.log("not-json");', 'invalid-test-report'],
  ['contradictory JSON', [process.execPath, 'check.cjs'], 'console.log(JSON.stringify({tests:[{id:"a",status:"failed"}]}));', 'invalid-test-report'],
  ['duplicate IDs', [process.execPath, 'check.cjs'], 'console.log(JSON.stringify({tests:[{id:"a",status:"passed"},{id:"a",status:"passed"}]}));', 'invalid-test-report'],
  ['output overflow', [process.execPath, 'check.cjs'], 'process.stdout.write("a".repeat(1100000));', 'test-output-limit']
]) {
  test(`tooling failure ${name} is blocked and never a zero-regression result`, async () => {
    const tree = files('alpha', script);
    const report = await runMarkdownBehavioralGate({ baseline: tree, candidate: tree,
      config: { commands: [{ name, command, format: 'json', timeoutMs: name === 'timeout' ? 100 : 5000 }] } });
    assert.equal(report.status, 'blocked');
    assert.equal(report.newRegressions, null);
    assert.equal(report.commands[0].reason, reason);
  });
}

test('test commands run in temporary copies and cannot accidentally mutate the source tree', async () => fixture(async ({ input, output }) => {
  const script = `require('node:fs').writeFileSync('SKILL.md','test side effect');`;
  await writeFile(join(input, 'check.cjs'), script);
  const report = await verifyMarkdownTree({ input, output, embed: sameMeaning,
    tests: { commands: [{ name: 'temporary-copy', command: [process.execPath, 'check.cjs'] }] } });
  assert.equal(report.accepted, true);
  assert.equal(await readFile(join(input, 'SKILL.md'), 'utf8'), sourceText);
  assert.notEqual(await readFile(join(output, 'SKILL.md'), 'utf8'), 'test side effect');
}));

test('CLI offline reports incomplete gates and preserves modes under a restrictive umask', async () => fixture(async ({ root, input, output }) => {
  await writeFile(join(input, '.env'), 'PRIVATE_KEY=not-for-output');
  await writeFile(join(input, 'SKILL.md'), '\uFEFF' + sourceText);
  const reportPath = join(root, 'report.json');
  const cli = resolve('bin/jbrancher.js');
  const runner = `process.umask(0o077);process.argv=[process.execPath,${JSON.stringify(cli)},...JSON.parse(process.env.JBRANCHER_TEST_ARGS)];await import(${JSON.stringify('file://' + cli)});`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', runner], { encoding: 'utf8',
    env: { ...process.env, OPENAI_API_KEY: '', JBRANCHER_TEST_ARGS: JSON.stringify(['compact', '--input', input, '--output', output, '--offline', '--report', reportPath]) } });
  assert.equal(result.status, 2, result.stderr);
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  assert.equal(report.status, 'incomplete');
  assert.equal(report.layers.semantic.status, 'blocked');
  assert.equal(report.layers.behavioral.status, 'skipped');
  assert.equal((await lstat(join(output, 'check.cjs'))).mode & 0o777, 0o755);
  assert.equal((await lstat(join(output, 'SKILL.md'))).mode & 0o777, 0o644);
  assert.equal((await readFile(join(output, 'SKILL.md'))).slice(0, 3).toString('hex'), 'efbbbf');
  await assert.rejects(() => lstat(join(output, '.env')), { code: 'ENOENT' });
}));

test('CLI malformed arguments and reports inside a source tree exit inconclusively', async () => fixture(async ({ input, output }) => {
  for (const args of [
    ['compact', '--input', input, '--output', output, '--wat'],
    ['compact', '--input', input, '--output', output, '--report', join(input, 'report.json')]
  ]) {
    const result = spawnSync(process.execPath, ['bin/jbrancher.js', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 2, result.stderr);
  }
}));
