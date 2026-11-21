import { readdir, readFile } from 'node:fs/promises';
import { validateTemplate } from '../packages/core/index.mjs';
const dir = new URL('../templates/', import.meta.url);
for (const file of (await readdir(dir)).filter(f => f.endsWith('.json'))) {
  const errors = validateTemplate(JSON.parse(await readFile(new URL(file, dir), 'utf8')));
  console.log(`${file}: ${errors.length ? errors.join('; ') : '有效'}`);
  if (errors.length) process.exitCode = 1;
}
