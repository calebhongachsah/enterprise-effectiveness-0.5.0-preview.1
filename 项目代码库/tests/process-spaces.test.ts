import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const databasePath = path.resolve("data/test-v04-process-spaces.sqlite");
process.env.SQLITE_DATABASE_PATH = databasePath;

test("流程空间默认迁移、创建和生命周期约束", async () => {
  fs.rmSync(databasePath, { force: true });
  const storage = await import("../apps/api/src/db.js");
  try {
    const initial = storage.listProcessSpaces() as any[];
    assert.equal(initial.length, 1);
    assert.equal(initial[0].code, "default");
    assert.equal(initial[0].status, "ACTIVE");
    assert.equal(initial[0].is_default, 1);

    const created = storage.createProcessSpace({
      name: "研发交付流程",
      code: "rd-delivery",
      description: "验证多流程空间目录",
      owner: "研发负责人",
    });
    storage.updateProcessSpaceStatus(created.id, "INACTIVE");
    const spaces = storage.listProcessSpaces() as any[];
    assert.equal(spaces.length, 2);
    assert.equal(spaces[1].status, "INACTIVE");

    assert.throws(
      () => storage.updateProcessSpaceStatus(initial[0].id, "INACTIVE"),
      /默认流程空间不能停用/,
    );
  } finally {
    storage.db.close();
    fs.rmSync(databasePath, { force: true });
  }
});
