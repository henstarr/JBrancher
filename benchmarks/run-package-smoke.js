import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const node = process.execPath;
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const assertMode = process.argv.includes('--assert');

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options
  });
}

const packDir = await mkdtemp(join(tmpdir(), 'jbrancher-pack-'));
const installDir = await mkdtemp(join(tmpdir(), 'jbrancher-install-'));

try {
  const packOutput = run(npm, ['pack', '--json', '--pack-destination', packDir], {
    shell: process.platform === 'win32'
  });
  const metadata = JSON.parse(packOutput.trim());
  const tarballName = metadata[0]?.filename;
  if (!tarballName) throw new Error('npm pack did not return a tarball filename');
  const tarball = join(packDir, tarballName);

  run(npm, [
    'install',
    '--prefix', installDir,
    tarball,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund'
  ], { shell: process.platform === 'win32' });

  const importCheck = run(node, [
    '--input-type=module',
    '-e',
    "const pkg = await import('jbrancher'); if (typeof pkg.createJBrancher !== 'function') throw new Error('createJBrancher export missing'); console.log(JSON.stringify({ package: 'jbrancher', exports: Object.keys(pkg).sort() }));"
  ], { cwd: installDir });

  const demoOutput = run(npx, ['--no-install', 'jbrancher', 'demo'], {
    cwd: installDir,
    shell: process.platform === 'win32'
  });
  const demoResult = JSON.parse(demoOutput);
  const importPassed = importCheck.includes('createJBrancher');
  const demoPassed = demoResult?.decision?.source === 'jev'
    && demoResult?.decision?.action?.tool === 'write';
  const passed = importPassed && demoPassed;
  const result = {
    package: tarballName,
    cleanInstall: true,
    importCheck: importPassed,
    cliDemo: demoPassed,
    installDirectory: installDir
  };
  console.log(JSON.stringify(result, null, 2));
  if (assertMode && !passed) process.exitCode = 1;
} finally {
  await Promise.all([
    rm(packDir, { recursive: true, force: true }),
    rm(installDir, { recursive: true, force: true })
  ]);
}
