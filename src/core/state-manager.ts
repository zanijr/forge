import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import type { Plan, Task, Agent, Finding } from "../types.js";
import { PlanSchema, AgentSchema } from "../types.js";
import { withLock } from "../utils/lockfile.js";

const LOCK_STALE_MS = 60_000;
const SUBDIRS = ["agents", "outputs", "prompts", "reviews", "worktrees"] as const;

export class StateManager {
  readonly forgeDir: string;

  constructor(private readonly projectRoot: string) {
    this.forgeDir = join(projectRoot, ".forge");
    this.ensureDirs();
  }

  // ─── Plan Operations ────────────────────────────────────────────

  /** Validate and persist a plan to `.forge/plan.json`. Uses atomic writes. */
  savePlan(plan: Plan): void {
    const validated = PlanSchema.parse(plan);
    const filepath = join(this.forgeDir, "plan.json");
    // TODO: acquire lockfile via src/utils/lockfile.ts before write
    this.atomicWrite(filepath, JSON.stringify(validated, null, 2));
    // TODO: release lockfile after write
  }

  /** Load the current plan from disk. Returns null if no plan exists. */
  loadPlan(): Plan | null {
    const filepath = join(this.forgeDir, "plan.json");
    if (!existsSync(filepath)) return null;
    const raw = readFileSync(filepath, "utf-8");
    return PlanSchema.parse(JSON.parse(raw));
  }

  /** Update a single task within the plan by merging partial fields. */
  updateTask(taskId: string, updates: Partial<Task>): void {
    const plan = this.loadPlan();
    if (!plan) throw new Error("No plan found — cannot update task");

    const idx = plan.tasks.findIndex((t) => t.id === taskId);
    if (idx === -1) throw new Error(`Task not found: ${taskId}`);

    plan.tasks[idx] = { ...plan.tasks[idx], ...updates };
    plan.updated_at = new Date().toISOString();
    this.savePlan(plan);
  }

  // ─── Agent Operations ───────────────────────────────────────────

  /** Validate and persist an agent record. Uses atomic writes. */
  saveAgent(agent: Agent): void {
    const validated = AgentSchema.parse(agent);
    const filepath = join(this.forgeDir, "agents", `${validated.id}.json`);
    this.atomicWrite(filepath, JSON.stringify(validated, null, 2));
  }

  /** Load a single agent by ID. Returns null if the agent file is missing. */
  loadAgent(agentId: string): Agent | null {
    const filepath = join(this.forgeDir, "agents", `${agentId}.json`);
    if (!existsSync(filepath)) return null;
    const raw = readFileSync(filepath, "utf-8");
    return AgentSchema.parse(JSON.parse(raw));
  }

  /** List all tracked agents by reading every `.json` file in `.forge/agents/`. */
  listAgents(): Agent[] {
    const dir = join(this.forgeDir, "agents");
    if (!existsSync(dir)) return [];

    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const raw = readFileSync(join(dir, f), "utf-8");
        return AgentSchema.parse(JSON.parse(raw));
      });
  }

  /** Remove an agent's state file from disk. */
  removeAgent(agentId: string): void {
    const filepath = join(this.forgeDir, "agents", `${agentId}.json`);
    if (existsSync(filepath)) unlinkSync(filepath);
  }

  // ─── Review Operations ──────────────────────────────────────────

  /** Persist review findings for a given category (e.g. "security"). */
  saveReview(category: string, findings: Finding[]): void {
    const filepath = join(this.forgeDir, "reviews", `${category}.json`);
    this.atomicWrite(filepath, JSON.stringify(findings, null, 2));
  }

  /** Load all review files and return them keyed by category name. */
  loadAllReviews(): Record<string, Finding[]> {
    const dir = join(this.forgeDir, "reviews");
    if (!existsSync(dir)) return {};

    const result: Record<string, Finding[]> = {};
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
      const category = basename(f, ".json");
      const raw = readFileSync(join(dir, f), "utf-8");
      result[category] = JSON.parse(raw) as Finding[];
    }
    return result;
  }

  // ─── PROJECT_STATE.md ───────────────────────────────────────────

  /**
   * Generate a human-readable markdown summary at `.forge/PROJECT_STATE.md`.
   * This file survives compaction and is used by the Boss agent to recover
   * context after a session restart.
   */
  generateProjectState(): void {
    const plan = this.loadPlan();
    const agents = this.listAgents();
    const lines: string[] = [];

    lines.push("# Forge Project State");
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push("");

    if (!plan) {
      lines.push("No plan loaded.");
      this.atomicWrite(join(this.forgeDir, "PROJECT_STATE.md"), lines.join("\n"));
      return;
    }

    lines.push(`## ${plan.project}`);
    lines.push(`- **Repo:** ${plan.repo}`);
    lines.push(`- **Status:** ${plan.status}`);
    lines.push(`- **Description:** ${plan.description}`);
    lines.push(`- **Updated:** ${plan.updated_at}`);
    lines.push("");

    const byStatus = this.groupBy(plan.tasks, (t) => t.status);

    lines.push(`## Task Summary (${plan.tasks.length} total)`);
    for (const status of ["done", "in-progress", "review", "blocked", "todo", "failed"] as const) {
      const tasks = byStatus[status];
      if (!tasks?.length) continue;
      lines.push(`\n### ${status} (${tasks.length})`);
      for (const t of tasks) {
        const assignee = t.assigned_to ? ` [${t.assigned_to}]` : "";
        lines.push(`- **${t.id}:** ${t.title}${assignee}`);
      }
    }

    if (agents.length > 0) {
      const running = agents.filter((a) => a.status === "running");
      lines.push(`\n## Agents (${agents.length} total, ${running.length} running)`);
      for (const a of agents) {
        lines.push(`- **${a.id}** (${a.status}) task=${a.task_id} model=${a.model}`);
      }
    }

    this.atomicWrite(join(this.forgeDir, "PROJECT_STATE.md"), lines.join("\n"));
  }

  // ─── Internal Helpers ───────────────────────────────────────────

  /**
   * Write data to a temp file then rename into place. This prevents
   * readers from seeing a half-written file.
   */
  private atomicWrite(filepath: string, data: string): void {
    const tmp = `${filepath}.tmp`;
    writeFileSync(tmp, data, "utf-8");
    renameSync(tmp, filepath);
  }

  /** Create `.forge/` and all required subdirectories if they don't exist. */
  private ensureDirs(): void {
    if (!existsSync(this.forgeDir)) mkdirSync(this.forgeDir, { recursive: true });
    for (const sub of SUBDIRS) {
      const dir = join(this.forgeDir, sub);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
  }

  /** Group an array by a key function. */
  private groupBy<T>(items: T[], keyFn: (item: T) => string): Record<string, T[]> {
    const result: Record<string, T[]> = {};
    for (const item of items) {
      const key = keyFn(item);
      (result[key] ??= []).push(item);
    }
    return result;
  }
}
