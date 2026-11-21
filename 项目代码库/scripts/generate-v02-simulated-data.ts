import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import Papa from "papaparse";
import { DEFAULT_CONFIG } from "../packages/core/v01.js";

const root = path.resolve(import.meta.dirname, "..");
const output1800 = path.join(root, "data", "v02-simulated-pilot-1800-utf8.csv");
const generatedDir = path.join(root, "data", "generated");
const output10000 = path.join(generatedDir, "v02-pressure-10000-utf8.csv");

const teams = [
  { name: "交易平台", subjects: ["支付路由", "结算对账", "交易风控"] },
  { name: "用户增长", subjects: ["注册转化", "活动增长", "会员权益"] },
  { name: "数据平台", subjects: ["指标口径", "数据任务", "分析服务"] },
  { name: "基础架构", subjects: ["发布平台", "资源治理", "服务稳定性"] },
  { name: "商家产品", subjects: ["商家入驻", "商品管理", "营销工具"] },
  { name: "内部工具", subjects: ["审批效率", "研发工具", "协作门户"] },
];
const baseDurations: Record<string, number> = {
  requirements: 5,
  wait_design: 4,
  design: 7,
  wait_development: 16,
  development: 22,
  wait_testing: 5,
  testing: 10,
  wait_release: 4,
  release: 3,
};

function random(seed: number) {
  let value = seed >>> 0;
  return () => {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return (value >>> 0) / 4_294_967_296;
  };
}

function iso(milliseconds: number) {
  return new Date(milliseconds).toISOString();
}

function buildDataset(count: number, seed: number, prefix: string) {
  const next = random(seed);
  return Array.from({ length: count }, (_, index) => {
    const month = Math.min(11, Math.floor((index * 12) / count));
    const availableTeams = month >= 9 ? teams : teams.slice(0, 5);
    const team = availableTeams[index % availableTeams.length];
    const priorityRoll = next();
    const priority =
      priorityRoll < 0.1 ? "P0" : priorityRoll < 0.65 ? "P1" : "P2";
    const priorityFactor =
      priority === "P0" ? 0.72 : priority === "P2" ? 1.22 : 1;
    const day = 1 + Math.floor(next() * 20);
    let cursor = Date.UTC(2025, 9 + month, day, 1 + Math.floor(next() * 8));
    const completed = next() > 0.06;
    const activeStage = completed
      ? DEFAULT_CONFIG.stages.length
      : Math.floor(next() * DEFAULT_CONFIG.stages.length);
    const row: Record<string, string> = {
      ticket_id: `${prefix}-${String(index + 1).padStart(5, "0")}`,
      title: `${team.subjects[index % team.subjects.length]}改进 ${index + 1}`,
      team: team.name,
      priority,
      current_status: completed
        ? "released"
        : DEFAULT_CONFIG.stages[activeStage].id,
      release_result: completed
        ? next() < (month === 7 || month === 8 ? 0.84 : 0.92)
          ? "success"
          : "failed"
        : "",
    };
    DEFAULT_CONFIG.stages.forEach((stage, stageIndex) => {
      if (
        stageIndex > activeStage ||
        (completed && stageIndex >= activeStage)
      ) {
        row[stage.startField] = "";
        row[stage.endField] = "";
        return;
      }
      row[stage.startField] = iso(cursor);
      let storyFactor = 1;
      if (
        month <= 1 &&
        team.name === "交易平台" &&
        stage.id === "wait_development"
      )
        storyFactor = 2.4;
      if (
        (month === 7 || month === 8) &&
        ["wait_testing", "testing"].includes(stage.id)
      )
        storyFactor = 2.1;
      if (
        month >= 2 &&
        team.name === "交易平台" &&
        stage.id === "wait_development"
      )
        storyFactor = 0.72;
      const longTail = next() < 0.11 ? 1.8 + next() * 1.7 : 1;
      const jitter = 0.78 + next() * 0.5;
      const duration = Math.max(
        0.5,
        baseDurations[stage.id] *
          priorityFactor *
          storyFactor *
          longTail *
          jitter,
      );
      if (!completed && stageIndex === activeStage) {
        row[stage.endField] = "";
        return;
      }
      cursor += Math.round(duration * 3_600_000);
      row[stage.endField] = iso(cursor);
    });
    return row;
  });
}

async function save(file: string, rows: Record<string, string>[]) {
  await mkdir(path.dirname(file), { recursive: true });
  const csv = Papa.unparse(rows, { newline: "\n" });
  await writeFile(file, `\uFEFF${csv}\n`, "utf8");
}

const pilot = buildDataset(1_800, 20_261_007, "YH");
const pressure = buildDataset(10_000, 20_261_008, "LOAD");
await save(output1800, pilot);
await save(output10000, pressure);
console.log(`模拟试点数据：${output1800}（${pilot.length} 条）`);
console.log(`压力测试数据：${output10000}（${pressure.length} 条）`);
