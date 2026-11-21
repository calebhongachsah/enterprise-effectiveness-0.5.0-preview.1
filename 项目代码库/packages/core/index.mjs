/** 启动验证内核：自然小时、独立阶段实例。完整事件投影与业务服务尚未实现。 */
export function validateTemplate(template) {
  const errors = [];
  if (!template || typeof template !== 'object') return ['模板必须为对象'];
  for (const key of ['id', 'name', 'version']) {
    if (typeof template[key] !== 'string' || !template[key].trim()) errors.push(`缺少 ${key}`);
  }
  if (template.clock !== 'elapsed_hours') errors.push('当前内核仅支持 elapsed_hours');
  const paths = template.paths;
  if (!Array.isArray(paths) || !paths.length || paths.some(p => typeof p !== 'string' || !p.trim()) || new Set(paths).size !== paths.length) errors.push('paths 必须为非空且唯一的字符串列表');
  if (!Array.isArray(template.stages) || !template.stages.length) return [...errors, 'stages 不能为空'];
  const ids = new Set();
  for (const s of template.stages) {
    if (!s || typeof s !== 'object') { errors.push('阶段必须为对象'); continue; }
    if (!s.id || ids.has(s.id)) errors.push(`阶段 ID 缺失或重复：${s.id}`);
    ids.add(s.id);
    for (const key of ['name', 'entity', 'from', 'to', 'owner']) if (typeof s[key] !== 'string' || !s[key].trim()) errors.push(`${s.id} 缺少 ${key}`);
    if (!Array.isArray(s.paths) || !s.paths.length || s.paths.some(p => !Array.isArray(paths) || !paths.includes(p))) errors.push(`${s.id} 路径无效`);
    if (!s.slaHours || !Object.keys(s.slaHours).length || Object.values(s.slaHours).some(v => !Number.isFinite(v) || v <= 0)) errors.push(`${s.id} SLA 必须为正数`);
  }
  return errors;
}

function timestamp(value) {
  if (typeof value !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(value)) return NaN;
  return Date.parse(value);
}

export function measureStage(record, template, asOf) {
  const stage = template.stages.find(s => s.id === record.stageId);
  if (!stage) throw new Error(`未知阶段：${record.stageId}`);
  if (!template.paths.includes(record.path)) return { state: 'unknown_path' };
  if (!stage.paths.includes(record.path)) return { state: 'not_applicable' };
  const sla = stage.slaHours[record.priority];
  if (!Number.isFinite(sla) || sla <= 0) return { state: 'invalid_sla' };
  if (!record.startedAt) return { state: 'missing_data' };
  const start = timestamp(record.startedAt);
  const now = timestamp(asOf);
  const done = record.endedAt != null;
  // 无结束时间只有在明确声明 active 时才能按在途计算。
  if (!done && record.status !== 'active') return { state: 'missing_data' };
  const end = done ? timestamp(record.endedAt) : now;
  if (![start, end, now].every(Number.isFinite) || end < start || end > now || start > now) return { state: 'invalid_time' };
  const hours = (end - start) / 3600000;
  return { state: done ? 'completed' : 'active', hours, sla, overdue: hours > sla };
}

export function summarize(measurements) {
  const completed = measurements.filter(m => m.state === 'completed');
  const active = measurements.filter(m => m.state === 'active');
  const sorted = completed.map(m => m.hours).sort((a, b) => a - b);
  const count = completed.length;
  const mean = count ? completed.reduce((a, m) => a + m.hours, 0) / count : null;
  const meanSla = count ? completed.reduce((a, m) => a + m.sla, 0) / count : null;
  const excludedByState = {};
  for (const m of measurements) if (!['completed', 'active'].includes(m.state)) excludedByState[m.state] = (excludedByState[m.state] || 0) + 1;
  return {
    completedCount: count, activeCount: active.length, meanHours: mean, meanSlaHours: meanSla,
    p90Hours: count ? sorted[Math.ceil(count * 0.9) - 1] : null,
    completedOverdueRate: count ? completed.filter(m => m.overdue).length / count : null,
    activeOverdueCount: active.filter(m => m.overdue).length,
    meanBreached: count ? mean > meanSla : null, excludedByState,
  };
}

/** 比例采用 0..1；调用方必须按指标契约先选择样本和去重。 */
export function ratio(numerator, denominator, target, operator) {
  if (![numerator, denominator].every(Number.isInteger) || numerator < 0 || denominator < numerator) throw new Error('分子分母必须为有效非负整数，且分子不超过分母');
  if (!Number.isFinite(target) || target < 0 || target > 1) throw new Error('比例目标必须在 0..1');
  const comparisons = { lt: (a,b) => a < b, lte: (a,b) => a <= b, gt: (a,b) => a > b, gte: (a,b) => a >= b };
  if (!comparisons[operator]) throw new Error('未知比较符');
  if (!denominator) return { value: null, meetsTarget: null, sampleCount: 0 };
  const value = numerator / denominator;
  return { value, meetsTarget: comparisons[operator](value, target), sampleCount: denominator };
}
