import { readFile } from 'node:fs/promises';

const REQUIRED_FIELDS = ['instance_id', 'model_name_or_path', 'model_patch'];

/**
 * Validate the JSONL contract consumed by the official SWE-bench harness.
 * This checks shape and requested-instance coverage only; patch correctness is
 * intentionally left to the official evaluator.
 */
export function validateSWEbenchPredictions(text, { expectedInstanceIds = [] } = {}) {
  if (typeof text !== 'string') throw new TypeError('Prediction text must be a string');
  if (!Array.isArray(expectedInstanceIds) || expectedInstanceIds.some(id => typeof id !== 'string' || !id.trim())) {
    throw new TypeError('expectedInstanceIds must be an array of non-empty strings');
  }

  const errors = [];
  const rows = [];
  const seen = new Set();
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    if (!rawLine.trim()) continue;
    let row;
    try {
      row = JSON.parse(rawLine);
    } catch (error) {
      errors.push(`line ${index + 1}: invalid JSON (${error.message})`);
      continue;
    }
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      errors.push(`line ${index + 1}: prediction must be a JSON object`);
      continue;
    }
    for (const field of REQUIRED_FIELDS) {
      if (typeof row[field] !== 'string' || (field !== 'model_patch' && !row[field].trim())) {
        errors.push(`line ${index + 1}: ${field} must be ${field === 'model_patch' ? 'a string' : 'a non-empty string'}`);
      }
    }
    if (typeof row.instance_id === 'string' && row.instance_id.trim()) {
      if (seen.has(row.instance_id)) errors.push(`line ${index + 1}: duplicate instance_id ${row.instance_id}`);
      seen.add(row.instance_id);
    }
    rows.push(row);
  }

  const missingExpected = expectedInstanceIds.filter(instanceId => !seen.has(instanceId));
  for (const instanceId of missingExpected) errors.push(`missing requested instance_id ${instanceId}`);
  return {
    valid: errors.length === 0,
    rows: rows.length,
    instanceIds: [...seen],
    missingExpected,
    errors
  };
}

export async function validateSWEbenchPredictionFile(path, options = {}) {
  const text = await readFile(path, 'utf8');
  return validateSWEbenchPredictions(text, options);
}
