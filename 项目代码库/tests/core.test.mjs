import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateTemplate, measureStage, summarize, ratio } from '../packages/core/index.mjs';
const load = async name => JSON.parse(await readFile(new URL(`../templates/${name}.json`, import.meta.url), 'utf8'));
const serviceRequest = await load('service-request');
const software = await load('software');
const now = '2026-09-25T12:00:00Z';
const record = { stageId: 'triage', path: 'standard', priority: 'P0', startedAt: '2026-09-25T00:00:00Z', endedAt: '2026-09-25T04:00:00Z' };
test('两个业务模板均通过校验', () => {
  assert.deepEqual(validateTemplate(serviceRequest), []);
  assert.deepEqual(validateTemplate(software), []);
});
test('拒绝重复阶段和无效 SLA', () => {
  const t = structuredClone(serviceRequest); t.stages.push(t.stages[0]); t.stages[0].slaHours.P0 = -1;
  assert.ok(validateTemplate(t).length >= 2);
});
test('SLA 边界严格大于才算超时', () => {
  assert.equal(measureStage(record, serviceRequest, now).overdue, false);
  assert.equal(measureStage({ ...record, endedAt: '2026-09-25T04:01:00Z' }, serviceRequest, now).overdue, true);
});
test('完成均值与在途超时分开', () => {
  const done = measureStage(record, serviceRequest, now);
  const active = measureStage({ ...record, endedAt: null, status: 'active' }, serviceRequest, now);
  const result = summarize([done, active]);
  assert.equal(result.meanHours, 4); assert.equal(result.activeOverdueCount, 1); assert.equal(result.completedOverdueRate, 0);
});
test('不适用、未知路径和缺数据不混为 0', () => {
  assert.equal(measureStage({ ...record, stageId: 'fulfillment', path: 'expedited' }, serviceRequest, now).state, 'not_applicable');
  assert.equal(measureStage({ ...record, path: 'unknown' }, serviceRequest, now).state, 'unknown_path');
  assert.equal(measureStage({ ...record, startedAt: null }, serviceRequest, now).state, 'missing_data');
  assert.equal(measureStage({ ...record, endedAt: null }, serviceRequest, now).state, 'missing_data');
});
test('倒序、未来和无时区时间被排除', () => {
  for (const endedAt of ['2026-09-24T23:00:00Z', '2026-09-26T00:00:00Z', '2026-09-25T04:00:00']) assert.equal(measureStage({ ...record, endedAt }, serviceRequest, now).state, 'invalid_time');
});
test('P90 使用 nearest-rank；没有完成样本时无数据', () => {
  const result = summarize(Array.from({ length: 10 }, (_, i) => ({ state: 'completed', hours: i + 1, sla: 10, overdue: false })));
  assert.equal(result.p90Hours, 9); assert.equal(summarize([]).meanHours, null);
});
test('比例保留严格边界和零分母', () => {
  assert.equal(ratio(1, 10, 0.1, 'lt').meetsTarget, false);
  assert.equal(ratio(1, 10, 0.1, 'lte').meetsTarget, true);
  assert.equal(ratio(0, 0, 0.1, 'lt').value, null);
  assert.throws(() => ratio(2, 1, 0.1, 'lt'));
});
test('研发样本使用同一个核心且有独立 SLA', () => {
  const result = measureStage({ ...record, stageId: 'development', path: 'standard' }, software, now);
  assert.equal(result.state, 'completed'); assert.equal(result.hours, 4); assert.equal(result.sla, 8);
});
