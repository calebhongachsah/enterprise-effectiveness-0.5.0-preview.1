import test from "node:test";
import assert from "node:assert/strict";
import {
  nextProblemStatus,
  problemTransitionError,
} from "../packages/core/problem-workflow.js";

const improvement = (status = "新建") => ({ status });

test("改进项按新建、进行中、已完成顺序前进", () => {
  assert.equal(nextProblemStatus("新建"), "进行中");
  assert.equal(nextProblemStatus("进行中"), "已完成");
  assert.equal(nextProblemStatus("已完成"), null);
  assert.equal(problemTransitionError(improvement(), "进行中"), null);
});

test("改进项不能跳级或在完成后继续流转", () => {
  assert.match(problemTransitionError(improvement(), "已完成")!, /只能/);
  assert.match(
    problemTransitionError(improvement("已完成"), "进行中")!,
    /已完成/,
  );
});
