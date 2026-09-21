import { validateSWEbenchPredictionFile } from '../src/swebench.js';

function value(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function valuesAfter(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return [];
  const values = [];
  for (let cursor = index + 1; cursor < process.argv.length && !process.argv[cursor].startsWith('--'); cursor++) {
    values.push(process.argv[cursor]);
  }
  return values;
}

const path = value('--predictions');
if (!path || process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('Usage: npm run bench:swebench-validate -- --predictions predictions/jbrancher.jsonl [--instance-ids id...]');
  process.exitCode = path ? 0 : 2;
} else {
  try {
    const report = await validateSWEbenchPredictionFile(path, {
      expectedInstanceIds: valuesAfter('--instance-ids')
    });
    console.log(JSON.stringify(report, null, 2));
    if (process.argv.includes('--assert') && !report.valid) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
