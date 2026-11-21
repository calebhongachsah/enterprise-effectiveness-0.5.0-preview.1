export type Priority = "P0" | "P1" | "P2";
export type StageType = "processing" | "waiting";

export interface StageConfig {
  id: string;
  name: string;
  type: StageType;
  startField: string;
  endField: string;
  slaHours: Record<Priority, number>;
}

export interface ProcessConfig {
  name: string;
  timezone: string;
  keyField: string;
  titleField: string;
  teamField: string;
  priorityField: string;
  statusField: string;
  outcomeField: string;
  stages: StageConfig[];
  teamSlaHours?: Record<
    string,
    Record<string, Partial<Record<Priority, number>>>
  >;
}

export interface ProcessStructureChange {
  kind: "added" | "removed" | "renamed" | "reordered" | "type_changed";
  stageId: string;
  before?: string | number;
  after?: string | number;
}

export interface ProcessStructureDiff {
  changed: boolean;
  changes: ProcessStructureChange[];
}

export interface ImportIssue {
  row: number;
  ticketId?: string;
  code: string;
  message: string;
  severity: "error" | "warning";
}

export interface StageMeasurement {
  ticketId: string;
  stageId: string;
  stageName: string;
  stageType: StageType;
  priority: Priority;
  startedAt: string | null;
  endedAt: string | null;
  state: "completed" | "active" | "not_started" | "invalid";
  hours: number | null;
  slaHours: number;
  overdue: boolean | null;
}

export interface StageSummary {
  id: string;
  name: string;
  type: StageType;
  completedCount: number;
  activeCount: number;
  meanHours: number | null;
  p50Hours: number | null;
  p90Hours: number | null;
  completedOverdueCount: number;
  completedOverdueRate: number | null;
  slaAchievementRate: number | null;
  activeOverdueCount: number;
  p0ActiveOverdueCount: number;
  p1SlaHours: number;
  comparisonSlaHours: number;
  abnormal: boolean;
}

export interface DashboardSummary {
  ticketCount: number;
  completedTicketCount: number;
  meanLeadTimeHours: number | null;
  p90LeadTimeHours: number | null;
  stageOverdueRate: number | null;
  releaseSuccessRate: number | null;
  dataValidRate: number | null;
}
