export const PROBLEM_STATUSES = ["新建", "进行中", "已完成"] as const;

export type ProblemStatus = (typeof PROBLEM_STATUSES)[number];

export function nextProblemStatus(status: string) {
  const index = PROBLEM_STATUSES.indexOf(status as ProblemStatus);
  return index >= 0 ? (PROBLEM_STATUSES[index + 1] ?? null) : null;
}

export function problemTransitionError(problem: any, target: string) {
  const expected = nextProblemStatus(problem.status);
  if (!expected) return "改进项已完成，不能继续流转";
  if (target !== expected)
    return `改进项只能从“${problem.status}”进入“${expected}”`;
  return null;
}
