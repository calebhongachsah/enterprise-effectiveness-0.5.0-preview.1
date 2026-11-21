import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeSchemaDrift,
  type SourceColumn,
} from "../apps/api/src/data-sources.js";

const column = (column_name: string, data_type = "text"): SourceColumn => ({
  column_name,
  data_type,
  is_nullable: "YES",
  ordinal_position: 1,
});

test("新增未映射字段只提醒，不阻断同步", () => {
  const result = analyzeSchemaDrift(
    [column("ticket_id"), column("updated_at", "timestamp with time zone")],
    [
      column("ticket_id"),
      column("updated_at", "timestamp with time zone"),
      column("customer_segment"),
    ],
    ["ticket_id", "updated_at"],
  );
  assert.equal(result.changed, true);
  assert.equal(result.blocking, false);
  assert.deepEqual(result.added, ["customer_segment"]);
});

test("删除已映射字段会阻断同步", () => {
  const result = analyzeSchemaDrift(
    [column("ticket_id"), column("team")],
    [column("ticket_id")],
    ["ticket_id", "team"],
  );
  assert.equal(result.blocking, true);
  assert.deepEqual(result.removedMapped, ["team"]);
});

test("兼容的文本类型变化不阻断同步", () => {
  const result = analyzeSchemaDrift(
    [column("ticket_id", "character varying")],
    [column("ticket_id", "text")],
    ["ticket_id"],
  );
  assert.equal(result.blocking, false);
});

test("已映射时间字段的时区语义变化会阻断同步", () => {
  const result = analyzeSchemaDrift(
    [column("updated_at", "timestamp with time zone")],
    [column("updated_at", "timestamp without time zone")],
    ["updated_at"],
  );
  assert.equal(result.blocking, true);
  assert.deepEqual(result.typeChangedMapped, [
    {
      field: "updated_at",
      before: "timestamp with time zone",
      after: "timestamp without time zone",
    },
  ]);
});
