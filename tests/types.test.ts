import { describe, it, expect } from "vitest";
import { TaskStatus, ForgeConfigSchema, type SupervisorFinding } from "../src/types.js";

describe("TaskStatus", () => {
  it("includes needs-review status", () => {
    const result = TaskStatus.safeParse("needs-review");
    expect(result.success).toBe(true);
  });

  it("includes all original statuses", () => {
    for (const s of ["todo", "in-progress", "blocked", "review", "done", "failed"]) {
      expect(TaskStatus.safeParse(s).success).toBe(true);
    }
  });

  it("rejects unknown status", () => {
    expect(TaskStatus.safeParse("unknown").success).toBe(false);
  });
});

describe("ForgeConfigSchema supervisor section", () => {
  const minimalConfig = {
    github: { org: "test-org" },
    hosts: {},
    agents: {},
    review: {},
    notifications: {},
    state: {},
  };

  it("applies default supervisor_enabled true", () => {
    const result = ForgeConfigSchema.parse(minimalConfig);
    expect(result.supervisor.supervisor_enabled).toBe(true);
  });

  it("applies default supervisor_model sonnet", () => {
    const result = ForgeConfigSchema.parse(minimalConfig);
    expect(result.supervisor.supervisor_model).toBe("sonnet");
  });

  it("applies default supervisor_criteria as empty array", () => {
    const result = ForgeConfigSchema.parse(minimalConfig);
    expect(result.supervisor.supervisor_criteria).toEqual([]);
  });

  it("applies default max_supervisor_rounds 2", () => {
    const result = ForgeConfigSchema.parse(minimalConfig);
    expect(result.supervisor.max_supervisor_rounds).toBe(2);
  });

  it("accepts custom supervisor values", () => {
    const result = ForgeConfigSchema.parse({
      ...minimalConfig,
      supervisor: {
        supervisor_enabled: false,
        supervisor_model: "opus",
        supervisor_criteria: ["no secrets", "tests pass"],
        max_supervisor_rounds: 3,
      },
    });
    expect(result.supervisor.supervisor_enabled).toBe(false);
    expect(result.supervisor.supervisor_model).toBe("opus");
    expect(result.supervisor.supervisor_criteria).toEqual(["no secrets", "tests pass"]);
    expect(result.supervisor.max_supervisor_rounds).toBe(3);
  });
});

describe("SupervisorFinding", () => {
  it("can be constructed with required fields", () => {
    const finding: SupervisorFinding = {
      task_id: "task-1",
      round: 1,
      verdict: "pass",
      findings: ["All tests pass"],
      feedback: "Good work.",
    };
    expect(finding.task_id).toBe("task-1");
    expect(finding.round).toBe(1);
    expect(finding.verdict).toBe("pass");
    expect(finding.findings).toHaveLength(1);
    expect(finding.feedback).toBe("Good work.");
  });

  it("supports all verdict values", () => {
    const verdicts: SupervisorFinding["verdict"][] = ["pass", "fail", "needs-revision"];
    for (const verdict of verdicts) {
      const finding: SupervisorFinding = {
        task_id: "task-1",
        round: 1,
        verdict,
        findings: [],
        feedback: "",
      };
      expect(finding.verdict).toBe(verdict);
    }
  });
});
