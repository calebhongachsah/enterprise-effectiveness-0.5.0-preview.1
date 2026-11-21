import type {
  ProcessConfig,
  ProcessStructureDiff,
  StageMeasurement,
} from "../../../packages/contracts/v01.js";

export interface Storage {
  listProcessSpaces(): PromiseLike<unknown[]> | unknown[];
  createProcessSpace(input: {
    name: string;
    code: string;
    description: string;
    owner: string;
  }): PromiseLike<{ id: number }> | { id: number };
  updateProcessSpaceStatus(
    id: number,
    status: "ACTIVE" | "INACTIVE",
  ): PromiseLike<void> | void;
  listImportBatches(): PromiseLike<unknown[]> | unknown[];
  listProcessVersions(): PromiseLike<unknown[]> | unknown[];
  createProcessVersionDraft(
    config: ProcessConfig,
    baselines: unknown,
    changeNote: string,
  ):
    | PromiseLike<{ id: number; versionNo: number }>
    | {
        id: number;
        versionNo: number;
      };
  publishProcessVersion(
    id: number,
  ):
    | PromiseLike<{ id: number; versionNo: number; published: boolean }>
    | { id: number; versionNo: number; published: boolean };
  getSetting<T>(key: string): PromiseLike<T | null> | T | null;
  setSetting(key: string, value: unknown): PromiseLike<void> | void;
  listOperationalReasons(teams?: string[] | null): PromiseLike<unknown[]> | unknown[];
  saveOperationalReason(input: {
    ticketId: string;
    stageId: string;
    kind: string;
    category: string;
    detail: string;
    responsibleTeam: string;
    owner: string;
    dueDate: string;
    status: "待填写" | "已填写";
  }, teams: string[] | null): PromiseLike<boolean> | boolean;
  updateProcessConfig(config: ProcessConfig): PromiseLike<void> | void;
  resetDemo?(): PromiseLike<void> | void;
  prepareImportBatch(
    filename: string,
    asOf: string,
    totalRows: number,
    rows: Record<string, string>[],
    measurements: StageMeasurement[],
    config: ProcessConfig,
    issues: Array<{
      row: number;
      ticketId?: string;
      code: string;
      message: string;
    }>,
    structureDiff: ProcessStructureDiff,
  ): PromiseLike<any> | any;
  publishImportBatch(
    batchId: number,
    allowStructureOverride?: boolean,
    dataSourceId?: number,
  ): PromiseLike<any> | any;
  rejectImportBatch(batchId: number): PromiseLike<void> | void;
  listProblems(teams?: string[] | null): PromiseLike<any[]> | any[];
  listWorkItemsRaw(): PromiseLike<any[]> | any[];
  listStageObservationsForTickets(
    ticketIds: string[],
  ): PromiseLike<any[]> | any[];
  getLatestPublishedBatch(): PromiseLike<any | undefined> | any | undefined;
  listWorkItemTeams(): PromiseLike<string[]> | string[];
  getSampleSource():
    | PromiseLike<{ source_json: string } | undefined>
    | { source_json: string }
    | undefined;
  listStageObservationsForStage(stageId: string): PromiseLike<any[]> | any[];
  getWorkItemWithObservations(
    ticketId: string,
  ): PromiseLike<any | null> | any | null;
  createProblem(input: {
    title: string;
    stageId: string;
    impact: string;
    owner: string;
    team: string;
    ticketIds: string[];
  }): PromiseLike<number> | number;
  addProblemReason(problemId: number, input: any): PromiseLike<void> | void;
  addProblemAction(problemId: number, input: any): PromiseLike<void> | void;
  addProblemVerification(
    problemId: number,
    input: any,
  ): PromiseLike<void> | void;
  updateProblemStatus(
    problemId: number,
    status: string,
    dueDate: string | undefined,
    teams: string[] | null,
  ): PromiseLike<boolean> | boolean;
  updateProblem(
    problemId: number,
    input: {
      title: string;
      impact: string;
      owner: string;
      team: string;
      dueDate?: string;
    },
    teams: string[] | null,
  ): PromiseLike<boolean> | boolean;
  updateProblemActionStatus(
    problemId: number,
    actionId: number,
    status: string,
    teams: string[] | null,
  ): PromiseLike<boolean> | boolean;
}

const usePostgres = Boolean(process.env.DATABASE_URL?.trim());
export const storageKind = usePostgres ? "postgresql" : "sqlite-demo";

export const storage: Storage = usePostgres
  ? (await import("./postgres-storage.js")).postgresStorage
  : await import("./db.js");
