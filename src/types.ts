import { z } from "zod";

// ─── Task ────────────────────────────────────────────────────────

export const TaskStatus = z.enum([
  "todo",
  "in-progress",
  "blocked",
  "review",
  "needs-review",
  "done",
  "failed",
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const TaskPriority = z.enum(["p0", "p1", "p2"]);
export type TaskPriority = z.infer<typeof TaskPriority>;

export const TaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  acceptance_criteria: z.array(z.string()),
  depends_on: z.array(z.string()),
  conflicts_with: z.array(z.string()).default([]),
  priority: TaskPriority,
  estimated_minutes: z.number().optional(),
  issue_number: z.number().optional(),
  status: TaskStatus,
  assigned_to: z.string().optional(),
});
export type Task = z.infer<typeof TaskSchema>;

// ─── Plan ────────────────────────────────────────────────────────

export const PlanStatus = z.enum(["draft", "approved", "building", "reviewing", "done"]);
export type PlanStatus = z.infer<typeof PlanStatus>;

export const PlanSchema = z.object({
  project: z.string(),
  projectRoot: z.string(),
  repo: z.string(),
  description: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  status: PlanStatus,
  tasks: z.array(TaskSchema),
  review_findings: z.array(z.any()).default([]),
});
export type Plan = z.infer<typeof PlanSchema>;

// ─── Agent ───────────────────────────────────────────────────────

export const AgentStatus = z.enum([
  "running",
  "completed",
  "failed",
  "killed",
  "timeout",
]);
export type AgentStatus = z.infer<typeof AgentStatus>;

export const EngineType = z.enum(["local", "ssh", "http"]);
export type EngineType = z.infer<typeof EngineType>;

export const AgentSchema = z.object({
  id: z.string(),
  task_id: z.string(),
  pid: z.number().optional(),
  host: z.string(),
  engine_type: EngineType.default("local"),
  model: z.string(),
  started_at: z.string(),
  finished_at: z.string().optional(),
  last_heartbeat: z.string(),
  status: AgentStatus,
  worktree_path: z.string(),
  output_path: z.string(),
  exit_code: z.number().optional(),
  token_usage: z.number().default(0),
  cost_usd: z.number().default(0),
});
export type Agent = z.infer<typeof AgentSchema>;

// ─── Review Findings ─────────────────────────────────────────────

export const Severity = z.enum(["critical", "high", "medium", "low"]);
export type Severity = z.infer<typeof Severity>;

export const ReviewCategory = z.enum([
  "security",
  "quality",
  "waste",
  "tests",
  "performance",
]);
export type ReviewCategory = z.infer<typeof ReviewCategory>;

export const FindingSchema = z.object({
  file: z.string(),
  line_start: z.number(),
  line_end: z.number(),
  severity: Severity,
  category: ReviewCategory,
  confidence: z.number().min(0).max(100),
  title: z.string(),
  description: z.string(),
  suggestion: z.string(),
});
export type Finding = z.infer<typeof FindingSchema>;

// ─── Configuration ───────────────────────────────────────────────

export const HostConfigSchema = z.object({
  type: z.enum(["local", "ssh", "http"]),
  host: z.string().optional(),
  user: z.string().optional(),
  key: z.string().optional(),
  url: z.string().optional(),
  api_token_env: z.string().optional(),
  max_agents: z.number().default(5),
  claude_path: z.string().default("claude"),
});
export type HostConfig = z.infer<typeof HostConfigSchema>;

export const LabelSchema = z.object({
  name: z.string(),
  color: z.string(),
  description: z.string().optional(),
});

export const ForgeConfigSchema = z.object({
  github: z.object({
    org: z.string(),
    default_visibility: z.enum(["public", "private"]).default("private"),
    labels: z.array(LabelSchema).default([]),
  }),
  hosts: z.record(z.string(), HostConfigSchema),
  agents: z.object({
    model: z.string().default("sonnet"),
    boss_model: z.string().default("opus"),
    review_model: z.string().default("sonnet"),
    max_turns: z.number().default(25),
    stagger_seconds: z.number().default(30),
    timeout_minutes: z.number().default(30),
    allowed_tools: z.array(z.string()).default([]),
  }),
  review: z.object({
    enabled: z.boolean().default(true),
    agents: z.array(z.string()).default(["security", "quality", "waste", "tests", "performance"]),
    confidence_threshold: z.number().default(80),
  }),
  notifications: z.object({
    terminal_bell: z.boolean().default(true),
    desktop: z.boolean().default(true),
    slack_webhook: z.string().default(""),
    discord_webhook: z.string().default(""),
    notify_on: z.array(z.string()).default([]),
  }),
  telegram: z.object({
    bot_token_env: z.string().default("FORGE_TELEGRAM_TOKEN"),
    chat_id_env: z.string().default("FORGE_TELEGRAM_CHAT"),
    notify_on: z.array(z.string()).default([]),
  }).optional(),
  deploy: z.object({
    pc: z.object({
      ssh_host: z.string().default("localhost"),
      ssh_port: z.number().default(2222),
      ssh_user: z.string().default("zbonham"),
      drives: z.record(z.string(), z.string()).default({}),
      projects_dir: z.string().default("C:\\Users\\zbonham\\source\\repos"),
    }).optional(),
  }).optional(),
  state: z.object({
    dir: z.string().default(".forge"),
    heartbeat_interval: z.number().default(60),
  }).default({}),
  supervisor: z.object({
    supervisor_enabled: z.boolean().default(true),
    supervisor_model: z.string().default("sonnet"),
    supervisor_criteria: z.array(z.string()).default([]),
    max_supervisor_rounds: z.number().default(2),
  }).default({}),
});
export type ForgeConfig = z.infer<typeof ForgeConfigSchema>;

// ─── Supervisor Finding ──────────────────────────────────────────

export interface SupervisorFinding {
  task_id: string;
  round: number;
  verdict: "pass" | "fail" | "needs-revision";
  findings: string[];
  feedback: string;
}

// ─── Worker Handle ───────────────────────────────────────────────

export interface WorkerHandle {
  id: string;
  engineType: "local" | "ssh" | "http";
  pid?: number;
  host: string;
  worktreePath: string;
  outputPath: string;
  startedAt: string;
}
