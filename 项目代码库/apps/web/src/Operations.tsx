import { useState } from "react";
import type {
  ProcessConfig,
  StageMeasurement,
} from "../../../packages/contracts/v01";
import { api } from "./api";

const fmtHours = (value: number | null) =>
  value === null ? "无数据" : `${value.toFixed(1)}h`;
const fmtRate = (value: number | null) =>
  value === null ? "无数据" : `${(value * 100).toFixed(1)}%`;

type Props = {
  state: any;
  reload: () => Promise<void> | void;
};

const itemMap = (state: any) =>
  new Map(state.operations.items.map((item: any) => [item.ticketId, item]));
const reasonKey = (ticketId: string, stageId: string, kind: string) =>
  `${ticketId}|${stageId}|${kind}`;
const reasonMap = (state: any) =>
  new Map(
    state.operations.reasons.map((reason: any) => [
      reasonKey(reason.ticket_id, reason.stage_id, reason.kind),
      reason,
    ]),
  );

const delayCategories = [
  "需求不清晰",
  "资源与排期",
  "依赖与协作",
  "评审与等待",
  "技术复杂度",
  "工具或环境",
  "流程状态未更新",
  "其他",
];
const failureCategories = [
  "发布验证失败",
  "配置或环境异常",
  "依赖服务异常",
  "质量问题回退",
  "数据或脚本问题",
  "其他",
];

export function ReasonQueue({ state, reload }: Props) {
  const [kind, setKind] = useState<"delay" | "release_failure">("delay");
  const [tab, setTab] = useState<"todo" | "done">("todo");
  const items = itemMap(state),
    reasons = reasonMap(state);
  const events =
    kind === "delay"
      ? state.operations.measurements
          .filter(
            (m: StageMeasurement) => m.overdue && m.state !== "not_started",
          )
          .map((m: StageMeasurement) => ({
            ticketId: m.ticketId,
            stageId: m.stageId,
            stageName: m.stageName,
            detail: `${fmtHours(m.hours)} / SLA ${fmtHours(m.slaHours)}`,
            item: items.get(m.ticketId),
          }))
      : state.operations.items
          .filter((item: any) => item.releaseResult === "failed")
          .map((item: any) => ({
            ticketId: item.ticketId,
            stageId: "release_result",
            stageName: "发布结果",
            detail: "发布失败",
            item,
          }));
  const decorated = events.map((event: any) => ({
    ...event,
    reason: reasons.get(reasonKey(event.ticketId, event.stageId, kind)),
  }));
  const rows = decorated.filter((event: any) =>
    tab === "done"
      ? event.reason?.status === "已填写"
      : event.reason?.status !== "已填写",
  );
  return (
    <section className="card ops-card">
      <SectionTitle
        title="原因待填"
        desc="对每个超时环节或发布失败分别记录分类和具体原因，作为改进分析的证据。"
      />
      <div className="seg-control">
        <button
          className={kind === "delay" ? "active" : ""}
          onClick={() => setKind("delay")}
        >
          延期原因
        </button>
        <button
          className={kind === "release_failure" ? "active" : ""}
          onClick={() => setKind("release_failure")}
        >
          发布失败原因
        </button>
      </div>
      <div className="tabs compact-tabs">
        <button
          className={tab === "todo" ? "active" : ""}
          onClick={() => setTab("todo")}
        >
          待填写{" "}
          {decorated.filter((x: any) => x.reason?.status !== "已填写").length}
        </button>
        <button
          className={tab === "done" ? "active" : ""}
          onClick={() => setTab("done")}
        >
          已填写{" "}
          {decorated.filter((x: any) => x.reason?.status === "已填写").length}
        </button>
      </div>
      <div className="reason-list">
        {rows.map((event: any) => (
          <ReasonEditor
            key={reasonKey(event.ticketId, event.stageId, kind)}
            event={event}
            kind={kind}
            initial={event.reason}
            categories={kind === "delay" ? delayCategories : failureCategories}
            onSaved={reload}
          />
        ))}
        {!rows.length && (
          <div className="empty-small">
            <b>当前没有记录</b>
            <span>可切换待填写/已填写查看</span>
          </div>
        )}
      </div>
    </section>
  );
}

function ReasonEditor({ event, kind, initial, categories, onSaved }: any) {
  const [category, setCategory] = useState(initial?.category ?? "");
  const [detail, setDetail] = useState(initial?.detail ?? "");
  const [responsibleTeam, setResponsibleTeam] = useState(
    initial?.responsible_team ?? event.item?.team ?? "",
  );
  const [owner, setOwner] = useState(initial?.owner ?? "");
  const [dueDate, setDueDate] = useState(initial?.due_date ?? "");
  const [message, setMessage] = useState("");
  const save = async () => {
    if (!responsibleTeam.trim() || !owner.trim() || !dueDate)
      return setMessage("责任团队、负责人和计划完成日期均为必填");
    if (Boolean(category) !== Boolean(detail.trim()))
      return setMessage("原因分类和原因说明需要同时填写");
    await api("/api/operational-reasons", {
      method: "POST",
      body: JSON.stringify({
        ticketId: event.ticketId,
        stageId: event.stageId,
        kind,
        category,
        detail,
        responsibleTeam,
        owner,
        dueDate,
      }),
    });
    setMessage("已保存");
    await onSaved();
  };
  return (
    <article className="reason-card">
      <div className="reason-meta">
        <b>
          {event.ticketId} · {event.item?.title}
        </b>
        <span>
          {event.item?.team} · {event.item?.priority} · {event.stageName}
        </span>
        <em>{event.detail}</em>
      </div>
      <select value={category} onChange={(e) => setCategory(e.target.value)}>
        <option value="">选择原因分类</option>
        {categories.map((item: string) => (
          <option key={item}>{item}</option>
        ))}
      </select>
      <textarea
        value={detail}
        onChange={(e) => setDetail(e.target.value)}
        placeholder="填写可验证的具体原因"
      />
      <input
        value={responsibleTeam}
        onChange={(e) => setResponsibleTeam(e.target.value)}
        placeholder="责任团队 *"
      />
      <input
        value={owner}
        onChange={(e) => setOwner(e.target.value)}
        placeholder="负责人 *"
      />
      <label>
        计划完成日期 *
        <input
          type="date"
          value={dueDate}
          onChange={(e) => setDueDate(e.target.value)}
        />
      </label>
      {initial?.status === "待填写" &&
        initial?.due_date &&
        initial.due_date < new Date().toISOString().slice(0, 10) && (
          <span className="pill bad">已逾期</span>
        )}
      <button className="primary compact" onClick={save}>
        {category && detail.trim() ? "保存原因" : "保存责任安排"}
      </button>
      {message && (
        <small className={message === "已保存" ? "ok-text" : "error-text"}>
          {message}
        </small>
      )}
    </article>
  );
}

export function ImprovementView({
  state,
  kind,
}: Props & { kind: "efficiency" | "effect" }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const items = itemMap(state),
    reasons = reasonMap(state);
  const records =
    kind === "efficiency"
      ? state.operations.measurements
          .filter((m: StageMeasurement) => m.overdue)
          .map((m: StageMeasurement) => ({
            key: m.stageId,
            label: m.stageName,
            ticketId: m.ticketId,
            item: items.get(m.ticketId),
            detail: `${fmtHours(m.hours)} / ${fmtHours(m.slaHours)}`,
            reason: reasons.get(reasonKey(m.ticketId, m.stageId, "delay")),
          }))
      : state.operations.items
          .filter((item: any) => item.releaseResult === "failed")
          .map((item: any) => ({
            key: "release_result",
            label: "发布失败",
            ticketId: item.ticketId,
            item,
            detail: "发布结果 failed",
            reason: reasons.get(
              reasonKey(item.ticketId, "release_result", "release_failure"),
            ),
          }));
  const firstGroups = groupCount(
    records,
    (r: any) => r.key,
    (r: any) => r.label,
  );
  const selectedRows = selected
    ? records.filter((r: any) => r.key === selected)
    : records;
  const categories = groupCount(
    selectedRows,
    (r: any) => r.reason?.category ?? "未填写原因",
    (r: any) => r.reason?.category ?? "未填写原因",
  );
  const details = category
    ? selectedRows.filter(
        (r: any) => (r.reason?.category ?? "未填写原因") === category,
      )
    : selectedRows;
  return (
    <section className="card ops-card">
      <SectionTitle
        title={kind === "efficiency" ? "效率改进" : "效果改进"}
        desc="三层下钻：异常分布 → 原因分类 → 具体单据与原因。"
      />
      <div className="crumb">
        <button
          onClick={() => {
            setSelected(null);
            setCategory(null);
          }}
        >
          异常分布
        </button>
        {selected && (
          <>
            <span>/</span>
            <button onClick={() => setCategory(null)}>
              {firstGroups.find((x) => x.key === selected)?.label}
            </button>
          </>
        )}
        {category && (
          <>
            <span>/</span>
            <b>{category}</b>
          </>
        )}
      </div>
      {!selected ? (
        <BarGroups groups={firstGroups} onClick={(key) => setSelected(key)} />
      ) : !category ? (
        <BarGroups groups={categories} onClick={(key) => setCategory(key)} />
      ) : (
        <DataTable
          headers={["单号", "标题", "团队", "优先级", "异常", "原因"]}
          rows={details.map((row: any) => [
            row.ticketId,
            row.item?.title,
            row.item?.team,
            row.item?.priority,
            row.detail,
            row.reason?.detail ?? "未填写",
          ])}
        />
      )}
    </section>
  );
}

function groupCount(
  rows: any[],
  key: (row: any) => string,
  label: (row: any) => string,
) {
  const map = new Map<string, { key: string; label: string; count: number }>();
  rows.forEach((row) => {
    const id = key(row),
      current = map.get(id);
    map.set(id, {
      key: id,
      label: label(row),
      count: (current?.count ?? 0) + 1,
    });
  });
  return [...map.values()].sort((a, b) => b.count - a.count);
}

function BarGroups({
  groups,
  onClick,
}: {
  groups: any[];
  onClick: (key: string) => void;
}) {
  const max = Math.max(1, ...groups.map((group) => group.count));
  return (
    <div className="analysis-bars">
      {groups.map((group) => (
        <button key={group.key} onClick={() => onClick(group.key)}>
          <b>{group.count}</b>
          <span
            style={{ height: `${Math.max(12, (group.count / max) * 180)}px` }}
          />
          <small>{group.label}</small>
        </button>
      ))}
      {!groups.length && (
        <div className="empty-small">
          <b>暂无异常数据</b>
        </div>
      )}
    </div>
  );
}

export function BaselinePanel({ state, reload }: Props) {
  const [config, setConfig] = useState<ProcessConfig>(
    structuredClone(state.config),
  );
  const [target, setTarget] = useState(
    Number(state.operations.baselines.releaseSuccessTarget ?? 0.9) * 100,
  );
  const [message, setMessage] = useState("");
  const [changeNote, setChangeNote] = useState("");
  const [busyId, setBusyId] = useState<number | null>(null);
  const [slaScope, setSlaScope] = useState("__default__");
  const save = async () => {
    const value = await api<any>("/api/process-versions/drafts", {
      method: "POST",
      body: JSON.stringify({
        config,
        baselines: {
          ...state.operations.baselines,
          releaseSuccessTarget: target / 100,
        },
        changeNote,
      }),
    });
    setMessage(`配置 V${value.versionNo} 草稿已保存，尚未影响正式看板`);
    setChangeNote("");
    await reload();
  };
  const publish = async (id: number, overwrite = false) => {
    setBusyId(id);
    try {
      const value = await api<any>(`/api/process-versions/${id}/publish`, {
        method: "POST",
        body: JSON.stringify(
          overwrite ? { confirmStructureOverride: "OVERWRITE_PROCESS" } : {},
        ),
      });
      setMessage(`配置 V${value.versionNo} 已发布，仅对后续导入生效`);
      await reload();
    } finally {
      setBusyId(null);
    }
  };
  const reject = async (id: number) => {
    if (!window.confirm(`确认放弃批次 #${id}？该批次不会改变正式看板。`))
      return;
    setBusyId(id);
    try {
      await api(`/api/import-batches/${id}/reject`, {
        method: "POST",
        body: "{}",
      });
      setMessage(`批次 #${id} 已放弃`);
      await reload();
    } finally {
      setBusyId(null);
    }
  };
  const displayedSla = (
    stage: ProcessConfig["stages"][number],
    priority: "P0" | "P1" | "P2",
  ) =>
    slaScope === "__default__"
      ? stage.slaHours[priority]
      : (config.teamSlaHours?.[slaScope]?.[stage.id]?.[priority] ??
        stage.slaHours[priority]);
  const update = (
    stageIndex: number,
    priority: "P0" | "P1" | "P2",
    value: number,
  ) => {
    setConfig((current) => {
      const stage = current.stages[stageIndex];
      if (slaScope === "__default__")
        return {
          ...current,
          stages: current.stages.map((item, index) =>
            index === stageIndex
              ? { ...item, slaHours: { ...item.slaHours, [priority]: value } }
              : item,
          ),
        };
      return {
        ...current,
        teamSlaHours: {
          ...current.teamSlaHours,
          [slaScope]: {
            ...current.teamSlaHours?.[slaScope],
            [stage.id]: {
              ...current.teamSlaHours?.[slaScope]?.[stage.id],
              [priority]: value,
            },
          },
        },
      };
    });
  };
  return (
    <section className="card ops-card">
      <SectionTitle
        title="SLA 与效果基线配置"
        desc="设置流程默认值或团队覆盖值；新版本只影响后续导入，不改写历史观测。"
      />
      <div className="baseline-outcome">
        <label>
          SLA 适用范围{" "}
          <select
            value={slaScope}
            onChange={(e) => setSlaScope(e.target.value)}
          >
            <option value="__default__">流程默认值</option>
            {state.dashboard.teams.map((team: string) => (
              <option key={team} value={team}>
                {team}
              </option>
            ))}
          </select>
        </label>
        <span className="muted">
          {slaScope === "__default__"
            ? "未单独配置的团队继承这里的数值"
            : `${slaScope} 未修改的单元格继续继承流程默认值`}
        </span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>环节</th>
              <th>类型</th>
              <th>P0 SLA(h)</th>
              <th>P1 SLA(h)</th>
              <th>P2 SLA(h)</th>
            </tr>
          </thead>
          <tbody>
            {config.stages.map((stage, index) => (
              <tr key={stage.id}>
                <td>
                  <b>{stage.name}</b>
                </td>
                <td>{stage.type === "waiting" ? "等待" : "处理"}</td>
                {(["P0", "P1", "P2"] as const).map((priority) => (
                  <td key={priority}>
                    <input
                      type="number"
                      min="0.1"
                      step="0.5"
                      value={displayedSla(stage, priority)}
                      onChange={(e) =>
                        update(index, priority, Number(e.target.value))
                      }
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="baseline-outcome">
        <label>
          发布成功率目标{" "}
          <input
            type="number"
            min="0"
            max="100"
            value={target}
            onChange={(e) => setTarget(Number(e.target.value))}
          />{" "}
          %
        </label>
        <label>
          变更说明{" "}
          <input
            value={changeNote}
            onChange={(e) => setChangeNote(e.target.value)}
            placeholder="例如：调整 P0 等待开发 SLA"
          />
        </label>
      </div>
      <div className="action-bar">
        <span className="ok-text">{message}</span>
        <button className="primary" onClick={save}>
          保存配置草稿
        </button>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>版本</th>
              <th>状态</th>
              <th>变更说明</th>
              <th>创建时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {state.processVersions.map((version: any) => (
              <tr key={version.id}>
                <td>V{version.version_no}</td>
                <td>
                  {{ DRAFT: "草稿", PUBLISHED: "已发布", RETIRED: "历史" }[
                    version.status as "DRAFT" | "PUBLISHED" | "RETIRED"
                  ] ?? version.status}
                </td>
                <td>{version.change_note}</td>
                <td>{new Date(version.created_at).toLocaleString()}</td>
                <td>
                  {version.status === "DRAFT" ? (
                    <button
                      className="primary compact"
                      disabled={busyId !== null}
                      onClick={() => publish(version.id)}
                    >
                      {busyId === version.id ? "发布中…" : "发布版本"}
                    </button>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function ImportBatchPanel({ state, reload }: Props) {
  const [busyId, setBusyId] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const publish = async (id: number) => {
    setBusyId(id);
    setMessage("");
    try {
      await api(`/api/import-batches/${id}/publish`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      setMessage(`批次 #${id} 已发布`);
      await reload();
    } finally {
      setBusyId(null);
    }
  };
  const statusLabel: Record<string, string> = {
    READY_TO_PUBLISH: "待发布",
    READY_WITH_ERRORS: "有错误，可发布有效记录",
    PUBLISHED: "已发布",
    PUBLISH_FAILED: "发布失败",
    REJECTED: "已放弃",
    AWAITING_STRUCTURE_DECISION: "流程结构待确认",
  };
  const structureChanges = (batch: any) => {
    const value = batch.structure_diff_json;
    return (
      (typeof value === "string" ? JSON.parse(value) : value)?.changes ?? []
    );
  };
  const changeLabel: Record<string, string> = {
    added: "新增",
    removed: "删除",
    renamed: "改名",
    reordered: "调序",
    type_changed: "类型变化",
  };
  return (
    <section className="card ops-card">
      <SectionTitle
        title="导入批次"
        desc="上传只生成待发布批次；人工发布后才改变正式看板。"
      />
      {message && <p className="ok-text">{message}</p>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>批次</th>
              <th>文件</th>
              <th>状态</th>
              <th>新增</th>
              <th>更新</th>
              <th>无变化</th>
              <th>错误</th>
              <th>配置版本</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {state.importBatches.map((batch: any) => (
              <tr key={batch.id}>
                <td>#{batch.id}</td>
                <td>{batch.filename}</td>
                <td>
                  {statusLabel[batch.status] ?? batch.status}
                  {structureChanges(batch).map((change: any, index: number) => (
                    <small className="structure-change" key={index}>
                      {changeLabel[change.kind]}：{change.stageId}
                      {change.before !== undefined ? ` ${change.before}` : ""}
                      {change.after !== undefined ? ` → ${change.after}` : ""}
                    </small>
                  ))}
                </td>
                <td>{batch.new_rows}</td>
                <td>{batch.updated_rows}</td>
                <td>{batch.unchanged_rows}</td>
                <td>{batch.error_rows}</td>
                <td>
                  {batch.config_version_id
                    ? `V${state.processVersions.find((v: any) => v.id === batch.config_version_id)?.version_no ?? "?"}`
                    : "—"}
                </td>
                <td>
                  {batch.status === "AWAITING_STRUCTURE_DECISION" ? (
                    <div className="batch-actions">
                      <button
                        disabled={busyId !== null}
                        onClick={() => reject(batch.id)}
                      >
                        放弃导入
                      </button>
                      <button
                        className="danger compact"
                        disabled={busyId !== null}
                        onClick={() => {
                          if (
                            window.confirm(
                              "覆盖将发布新的流程结构，只影响后续数据。确认继续？",
                            )
                          )
                            void publish(batch.id, true);
                        }}
                      >
                        覆盖流程
                      </button>
                    </div>
                  ) : ["READY_TO_PUBLISH", "READY_WITH_ERRORS"].includes(
                      batch.status,
                    ) ? (
                    <button
                      className="primary compact"
                      disabled={busyId !== null}
                      onClick={() => publish(batch.id)}
                    >
                      {busyId === batch.id ? "发布中…" : "确认发布"}
                    </button>
                  ) : (
                    <span className="muted">已完成</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!state.importBatches.length && (
        <div className="empty-small">
          <b>暂无导入批次</b>
        </div>
      )}
    </section>
  );
}

export function DefinitionView() {
  return (
    <section className="card ops-card definitions">
      <SectionTitle
        title="口径说明与原型映射"
        desc="只实现当前软件开发流程适用的运营能力。"
      />
      <h3>已实现的通用能力</h3>
      <ul>
        <li>团队 × 环节矩阵，P90/达标率切换，异常单据下钻。</li>
        <li>延期与发布失败原因待填，以及三层改进分析。</li>
        <li>SLA/效果基线配置。</li>
        <li>问题、原因、行动与改进复核闭环。</li>
      </ul>
      <h3>当前流程不适用</h3>
      <ul>
        <li>安全 Case 的独立/root/叶子角色、长短路径和跨域 Link。</li>
        <li>Root Owner 审核、Reject 理由、PJ/委员会仲裁。</li>
        <li>
          Agent
          运行失败率、人工审核率和策略采纳率；当前用发布成功率作为效果护栏。
        </li>
      </ul>
      <h3>核心原则</h3>
      <p>
        平台只读取来源事实，计算处理/等待耗时并支持运营闭环；不执行、审批或改写客户的软件开发流程。
      </p>
    </section>
  );
}

function SectionTitle({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="section-title">
      <h2>{title}</h2>
      <p>{desc}</p>
    </div>
  );
}

function DataTable({ headers, rows }: { headers: string[]; rows: any[][] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {headers.map((header) => (
              <th key={header}>{header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && (
        <div className="empty-small">
          <b>暂无数据</b>
        </div>
      )}
    </div>
  );
}
