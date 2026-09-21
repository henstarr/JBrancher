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

function runPython(executable, script, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-c', script, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr || stdout)));
  });
}

const python = findPython();
const repository = fileURLToPath(new URL('..', import.meta.url));

test('Harbor BaseAgent adapter learns a frontier route and reports its source', { skip: !python }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jbrancher-harbor-agent-'));
  const service = createJBrancherServer({ learningDirectory: directory });
  const address = await service.listen({ port: 0 });
  const script = `
import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0, sys.argv[2])
from integrations.python import JBrancherHarborAgent

class DemoAgent(JBrancherHarborAgent):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, max_steps=1, **kwargs)
        self.frontier_calls = 0

    async def candidate_actions(self, instruction, state, history, environment, context):
        return [{"tool": "read", "args": {"path": "README.md"}}]

    async def frontier_action(self, instruction, state, decision, environment, context):
        self.frontier_calls += 1
        return {"tool": "read", "args": {"path": "README.md"}}

    async def execute_action(self, action, environment, state, context):
        return {"ok": True, "output": action["args"]["path"]}

class Environment:
    pass

async def main():
    agent = DemoAgent(logs_dir=Path("."), proxy_url=sys.argv[1])
    await agent.setup(Environment())
    context = SimpleNamespace(metadata={})
    results = []
    for _ in range(3):
        await agent.run("Inspect README.md", Environment(), context)
        results.append(context.metadata["jbrancher"]["source"])
    assert results == ["frontier", "frontier", "learned"], results
    assert agent.frontier_calls == 2, agent.frontier_calls
    print({"sources": results, "frontierCalls": agent.frontier_calls})

asyncio.run(main())
`;
  try {
    const output = await runPython(python, script, [`http://${address.host}:${address.port}`, repository], repository);
    assert.match(output, /frontierCalls/);
    assert.match(output, /2/);
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
