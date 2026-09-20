#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const fixture = JSON.parse(await readFile(new URL('./fixtures/swebench-lite-mini.json', import.meta.url), 'utf8'));
const dataset = process.argv.includes('--dataset')
  ? process.argv[process.argv.indexOf('--dataset') + 1]
  : 'princeton-nlp/SWE-bench_Lite';
const pageSize = 100;
const expected = new Map(fixture.instances.map(instance => [instance.instance_id, instance]));
const splits = [...new Set(fixture.instances.map(instance => instance.split))];
const rowsById = new Map();

async function fetchRows(split, offset) {
  const url = new URL('https://datasets-server.huggingface.co/rows');
  url.searchParams.set('dataset', dataset);
  url.searchParams.set('config', 'default');
  url.searchParams.set('split', split);
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('length', String(pageSize));
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Hugging Face rows request failed (${response.status}) for ${split}@${offset}`);
  return (await response.json()).rows ?? [];
}

for (const split of splits) {
  let offset = 0;
  while (true) {
    const rows = await fetchRows(split, offset);
    for (const item of rows) {
      const row = item.row ?? {};
      if (expected.has(row.instance_id)) rowsById.set(row.instance_id, { split, row });
    }
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
}

const missing = [];
const mismatched = [];
for (const instance of fixture.instances) {
  const actual = rowsById.get(instance.instance_id);
  if (!actual) {
    missing.push(instance.instance_id);
    continue;
  }
  assert.equal(actual.split, instance.split, `${instance.instance_id} split drifted`);
  let failToPass;
  try {
    failToPass = JSON.parse(actual.row.FAIL_TO_PASS);
  } catch {
    throw new Error(`${instance.instance_id} has an invalid FAIL_TO_PASS value`);
  }
  if (JSON.stringify(failToPass) !== JSON.stringify(instance.fail_to_pass)) mismatched.push(instance.instance_id);
}

const report = {
  benchmark: 'SWE-bench Lite fixture provenance',
  dataset,
  fixtureInstances: fixture.instances.length,
  matchedInstances: rowsById.size,
  missing,
  failToPassMismatches: mismatched,
  fixtureSplits: fixture.sourceSplits
};
if (missing.length || mismatched.length) {
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify(report, null, 2));
}
