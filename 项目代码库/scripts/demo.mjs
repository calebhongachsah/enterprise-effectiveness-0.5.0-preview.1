import { readFile } from 'node:fs/promises';
import { measureStage, summarize, validateTemplate } from '../packages/core/index.mjs';
for (const scenario of ['service-request', 'software']) {
  const template = JSON.parse(await readFile(new URL(`../templates/${scenario}.json`, import.meta.url), 'utf8'));
  const fixture = JSON.parse(await readFile(new URL(`../examples/${scenario}.json`, import.meta.url), 'utf8'));
  const errors = validateTemplate(template);
  if (errors.length) throw new Error(errors.join('; '));
  console.log(JSON.stringify({ scenario: template.name, asOf: fixture.asOf,
    stage: fixture.records[0].stageId,
    result: summarize(fixture.records.map(r => measureStage(r, template, fixture.asOf))) }, null, 2));
}
