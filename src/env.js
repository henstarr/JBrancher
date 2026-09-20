import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Load simple KEY=value entries without overriding explicitly-set variables. */
export function loadDotEnv(file = resolve(process.cwd(), '.env')) {
  if (!existsSync(file)) return false;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] in process.env) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
  return true;
}
