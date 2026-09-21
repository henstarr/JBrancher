import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSWEbenchPredictions } from '../src/swebench.js';

test('SWE-bench prediction validation accepts the official JSONL shape', () => {
  const report = validateSWEbenchPredictions([
    JSON.stringify({ instance_id: 'repo__project-1', model_name_or_path: 'jbrancher', model_patch: 'diff --git a/a b/a' }),
    JSON.stringify({ instance_id: 'repo__project-2', model_name_or_path: 'jbrancher', model_patch: '' })
  ].join('\n'), { expectedInstanceIds: ['repo__project-1', 'repo__project-2'] });
  assert.equal(report.valid, true);
  assert.equal(report.rows, 2);
});

test('SWE-bench prediction validation rejects malformed and duplicate rows', () => {
  const report = validateSWEbenchPredictions([
    '{"instance_id":"repo__project-1","model_name_or_path":"jbrancher"}',
    JSON.stringify({ instance_id: 'repo__project-1', model_name_or_path: 'jbrancher', model_patch: '' }),
    '{not-json}'
  ].join('\n'), { expectedInstanceIds: ['repo__project-1', 'repo__project-2'] });
  assert.equal(report.valid, false);
  assert.ok(report.errors.some(error => error.includes('model_patch')));
  assert.ok(report.errors.some(error => error.includes('duplicate instance_id')));
  assert.ok(report.errors.some(error => error.includes('invalid JSON')));
  assert.deepEqual(report.missingExpected, ['repo__project-2']);
});
