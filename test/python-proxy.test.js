import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createJBrancherServer } from '../src/server.js';

function findPython() {
  for (const executable of process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python']) {
    if (spawnSync(executable, ['--version'], { stdio: 'ignore' }).status === 0) return executable;
  }
  return null;
}

const python = findPython();
const repository = fileURLToPath(new URL('..', import.meta.url));

test('dependency-free Python client completes the proxy learning loop', { skip: !python }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jbrancher-python-proxy-'));
  const service = createJBrancherServer({ learningDirectory: directory });
  const address = await service.listen({ port: 0 });
  const script = `
import sys
import asyncio
sys.path.insert(0, sys.argv[2])
from integrations.python import JBrancherHarborLoop, JBrancherProxy

proxy = JBrancherProxy(sys.argv[1])
assert proxy.health()["learningConfigured"] is True
open_world = proxy.decide("Discover an unregistered workflow", {"ready": True})
assert open_world["source"] == "abstain", open_world
assert open_world["routeResolution"] == "unmatched", open_world
for _ in range(2):
    proxy.record_episode(
        "Inspect package.json",
        [{"tool_name": "read", "input": {"path": "package.json"}, "ok": True, "output": "ok"}],
        outcome="success",
        source="python-test",
    )
decision = proxy.decide(
    "Inspect package.json",
    {"ready": True},
    [{"tool": "read", "args": {"path": "package.json"}}],
)
assert decision["source"] == "learned", decision
feedback = proxy.record_episode(
    "Inspect package.json",
    [{"tool_name": "read", "input": {"path": "package.json"}, "ok": True, "output": "ok"}],
    outcome="success",
    source="python-test",
    route_resolution="learned",
    route_id=decision["routeId"],
)
assert feedback["routeSuccessRecorded"] is True, feedback

async def run_harness_loop():
    loop = JBrancherHarborLoop(proxy, source="python-loop-test")
    frontier_calls = []

    async def frontier(decision):
        frontier_calls.append(decision["source"])
        return {"tool": "read", "args": {"path": "README.md"}}

    async def execute(action):
        return {"ok": True, "output": action["args"]["path"]}

    for _ in range(2):
        result = await loop.step(
            "Inspect README.md",
            {"ready": True},
            frontier=frontier,
            execute=execute,
        )
        assert result.source == "frontier", result
        assert result.episode["trace"]["toolCalls"][0]["context"]["routing"]["source"] == "abstain", result
    result = await loop.step(
        "Inspect README.md",
        {"ready": True},
        candidates=[{"tool": "read", "args": {"path": "README.md"}}],
        frontier=frontier,
        execute=execute,
    )
    assert result.source == "learned", result
    assert result.episode["trace"]["toolCalls"][0]["context"]["routing"]["source"] == "learned", result
    assert len(frontier_calls) == 2, frontier_calls

asyncio.run(run_harness_loop())

async def run_failure_recovery():
    loop = JBrancherHarborLoop(proxy, source="python-recovery-test")
    frontier_calls = []
    executions = 0
    action = {"tool": "read", "args": {"path": "CHANGELOG.md"}}

    async def frontier(decision):
        frontier_calls.append(decision["source"])
        return action

    async def execute(current_action):
        nonlocal executions
        executions += 1
        return {"ok": executions != 3, "output": current_action["args"]["path"]}

    for _ in range(2):
        await loop.step("Inspect CHANGELOG.md", {}, frontier=frontier, execute=execute)
    recovered = await loop.step(
        "Inspect CHANGELOG.md",
        {},
        candidates=[action],
        frontier=frontier,
        execute=execute,
    )
    assert recovered.source == "frontier", recovered
    assert recovered.recovered is True, recovered
    assert frontier_calls == ["abstain", "abstain", "recovery"], frontier_calls
    assert proxy.learning()["quarantinedRoutes"] >= 1

asyncio.run(run_failure_recovery())
print("python-proxy-ok")
`;
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(python, ['-c', script, `http://${address.host}:${address.port}`, repository], {
        cwd: repository,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', code => resolve({ code, stdout, stderr }));
    });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /python-proxy-ok/);
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
