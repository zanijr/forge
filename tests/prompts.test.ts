/**
 * Tests for buildWorkerPrompt in src/workers/prompts.ts
 *
 * Covers:
 * 1. supervisorEnabled parameter is optional (backward compat)
 * 2. supervisorEnabled=true → stage-only mode (no commit/push/PR)
 * 3. supervisorEnabled=false/omitted → existing commit+push+PR behavior
 * 4. review-request.json schema is specified in the supervisor prompt
 */

import { describe, it, expect } from "vitest";
import { buildWorkerPrompt } from "../src/workers/prompts.js";
import type { SpawnOptions } from "../src/execution/engine.js";

// ─── Fixtures ─────────────────────────────────────────────────────

function makeOpts(overrides: Partial<SpawnOptions["task"]> = {}): SpawnOptions {
  return {
    task: {
      id: "task-42",
      issue_number: 42,
      title: "Do the thing",
      description: "Implement the feature",
      acceptance_criteria: ["Criterion A", "Criterion B"],
      depends_on: [],
      conflicts_with: [],
      priority: "p1",
      status: "ready",
      ...overrides,
    },
    repoFullName: "org/repo",
    projectRoot: "/tmp/project",
    model: "claude-sonnet-4-6",
    maxTurns: 50,
    allowedTools: [],
  };
}

// ─── Tests ────────────────────────────────────────────────────────

describe("buildWorkerPrompt", () => {
  describe("acceptance criterion 1: optional supervisorEnabled parameter", () => {
    it("accepts no supervisorEnabled argument (backward compat)", () => {
      const opts = makeOpts();
      expect(() => buildWorkerPrompt(opts)).not.toThrow();
    });

    it("accepts supervisorEnabled=false explicitly", () => {
      const opts = makeOpts();
      expect(() => buildWorkerPrompt(opts, false)).not.toThrow();
    });

    it("accepts supervisorEnabled=true", () => {
      const opts = makeOpts();
      expect(() => buildWorkerPrompt(opts, true)).not.toThrow();
    });
  });

  describe("acceptance criterion 2: supervisorEnabled=true → stage-only mode", () => {
    it("instructs worker to stage with git add -A", () => {
      const prompt = buildWorkerPrompt(makeOpts(), true);
      expect(prompt).toContain("git add -A");
    });

    it("instructs worker to write review-request.json to .forge/outputs/", () => {
      const prompt = buildWorkerPrompt(makeOpts(), true);
      expect(prompt).toContain(".forge/outputs/task-42-review-request.json");
    });

    it("does NOT instruct worker to commit in supervisor mode", () => {
      const prompt = buildWorkerPrompt(makeOpts(), true);
      // Should not contain commit command
      expect(prompt).not.toContain("git commit");
    });

    it("does NOT instruct worker to push in supervisor mode", () => {
      const prompt = buildWorkerPrompt(makeOpts(), true);
      expect(prompt).not.toContain("git push");
    });

    it("does NOT instruct worker to create a PR in supervisor mode", () => {
      const prompt = buildWorkerPrompt(makeOpts(), true);
      expect(prompt).not.toContain("gh pr create");
    });

    it("explicitly states do NOT commit/push/PR in constraints", () => {
      const prompt = buildWorkerPrompt(makeOpts(), true);
      expect(prompt).toContain("Do NOT commit, push, or create a PR");
    });
  });

  describe("acceptance criterion 3: supervisorEnabled=false/omitted → existing behavior", () => {
    it("omitted: instructs worker to commit", () => {
      const prompt = buildWorkerPrompt(makeOpts());
      expect(prompt).toContain("git commit");
    });

    it("omitted: instructs worker to push", () => {
      const prompt = buildWorkerPrompt(makeOpts());
      expect(prompt).toContain("git push");
    });

    it("omitted: instructs worker to create PR", () => {
      const prompt = buildWorkerPrompt(makeOpts());
      expect(prompt).toContain("gh pr create");
    });

    it("false: instructs worker to commit", () => {
      const prompt = buildWorkerPrompt(makeOpts(), false);
      expect(prompt).toContain("git commit");
    });

    it("false: instructs worker to push", () => {
      const prompt = buildWorkerPrompt(makeOpts(), false);
      expect(prompt).toContain("git push");
    });

    it("false: instructs worker to create PR", () => {
      const prompt = buildWorkerPrompt(makeOpts(), false);
      expect(prompt).toContain("gh pr create");
    });

    it("omitted: does NOT mention review-request.json", () => {
      const prompt = buildWorkerPrompt(makeOpts());
      expect(prompt).not.toContain("review-request.json");
    });

    it("false: does NOT mention review-request.json", () => {
      const prompt = buildWorkerPrompt(makeOpts(), false);
      expect(prompt).not.toContain("review-request.json");
    });
  });

  describe("acceptance criterion 4: review request JSON schema specified", () => {
    it("includes task_id field in schema", () => {
      const prompt = buildWorkerPrompt(makeOpts(), true);
      expect(prompt).toContain('"task_id"');
    });

    it("includes branch field in schema", () => {
      const prompt = buildWorkerPrompt(makeOpts(), true);
      expect(prompt).toContain('"branch"');
    });

    it("includes summary field in schema", () => {
      const prompt = buildWorkerPrompt(makeOpts(), true);
      expect(prompt).toContain('"summary"');
    });

    it("includes criteria_met field in schema", () => {
      const prompt = buildWorkerPrompt(makeOpts(), true);
      expect(prompt).toContain('"criteria_met"');
    });

    it("embeds the task id in the schema example", () => {
      const prompt = buildWorkerPrompt(makeOpts(), true);
      expect(prompt).toContain('"task_id": "task-42"');
    });
  });
});
