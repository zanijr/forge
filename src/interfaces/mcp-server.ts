import "dotenv/config";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execSync, spawnSync } from "node:child_process";
import { loadConfig } from "../config.js";
import { StateManager } from "../core/state-manager.js";
import { Scheduler } from "../core/scheduler.js";
import { Notifier } from "../core/notifier.js";
import { LocalEngine } from "../execution/local-engine.js";
import { RemoteEngine } from "../execution/remote-engine.js";
import { HttpEngine } from "../execution/http-engine.js";
import { GitHubManager } from "../github/manager.js";
import { ReviewPipeline } from "../review/pipeline.js";
import type { ForgeConfig, Plan, Task } from "../types.js";

// ─── Service Factory ──────────────────────────────────────────

function resolveProjectRoot(explicitRoot?: string): string {
  if (explicitRoot) return explicitRoot;
  // Check env var first (set by MCP config or user)
  if (process.env.FORGE_PROJECT_ROOT) return process.env.FORGE_PROJECT_ROOT;
  // Try to load existing plan to get stored projectRoot
  const cwd = process.cwd();
  const state = new StateManager(cwd);
  const plan = state.loadPlan();
  if (plan?.projectRoot) return plan.projectRoot;
  return cwd;
}

function createServices(explicitProjectRoot?: string) {
  const config = loadConfig();
  const projectRoot = resolveProjectRoot(explicitProjectRoot);
  const state = new StateManager(projectRoot);
  const github = new GitHubManager(config.github);
  github.setCwd(projectRoot);
  const firstHost = Object.values(config.hosts)[0];
  const engine = firstHost?.type === "http"
    ? new HttpEngine(firstHost.url!, process.env[firstHost.api_token_env || ""] || "", state.forgeDir)
    : firstHost?.type === "ssh"
      ? new RemoteEngine(state.forgeDir, firstHost)
      : new LocalEngine(state.forgeDir);
  const notifier = new Notifier(config.notifications, config.telegram);
  const repoFullName = state.loadPlan()?.repo ?? github.getRepoFullName() ?? `${config.github.org}/unknown`;
  const scheduler = new Scheduler(state, engine, github, notifier, {
    staggerSeconds: config.agents.stagger_seconds,
    heartbeatInterval: config.state.heartbeat_interval,
    maxAgents: Object.values(config.hosts).reduce((sum, h) => sum + h.max_agents, 0),
    model: config.agents.model,
    maxTurns: config.agents.max_turns,
    allowedTools: config.agents.allowed_tools,
    timeoutMinutes: config.agents.timeout_minutes,
    repoFullName,
    projectRoot,
  });
  return { config, state, github, engine, notifier, scheduler, projectRoot };
}

// ─── Plan Prompt (shared with CLI) ────────────────────────────

function buildPlanPrompt(description: string): string {
  return [
    "You are a project planner. Break this project description into discrete implementation tasks.",
    "", `Project: ${description}`, "",
    "Output ONLY a JSON object with this exact structure (no other text):",
    '{ "tasks": [{ "id": "task-1", "title": "Short task title", "description": "Detailed description",',
    '  "acceptance_criteria": ["Criterion 1", "Criterion 2"], "depends_on": [], "priority": "p0",',
    '  "estimated_minutes": 15 }] }', "",
    "Rules:",
    "- Each task completable by one agent in 10-30 minutes",
    "- Use depends_on to reference other task IDs",
    "- Priority: p0=core/blocking, p1=important, p2=nice-to-have",
    "- Keep tasks focused: one module, one feature, one concern",
    "- Include test task per implementation task",
    "- Maximum 15 tasks",
  ].join("\n");
}

// ─── Tool Definitions ─────────────────────────────────────────

const TOOLS = [
  {
    name: "forge_plan",
    description: "Create a plan from a project description. Calls Claude to decompose work into tasks and creates GitHub Issues.",
    inputSchema: {
      type: "object" as const,
      properties: {
        description: { type: "string", description: "Description of the work to plan" },
        projectRoot: { type: "string", description: "Absolute path to the target project directory (optional — defaults to cwd or plan's stored root)" },
      },
      required: ["description"],
    },
  },
  {
    name: "forge_approve",
    description: "Approve the current plan, allowing agents to be spawned.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "forge_build",
    description: "Spawn worker agents for all ready tasks in the approved plan.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "forge_status",
    description: "Get the current project status including task and agent states.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "forge_stop",
    description: "Stop all running agents and return their tasks to the queue.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "forge_review",
    description: "Run the review pipeline (security, quality, waste, tests, performance).",
    inputSchema: {
      type: "object" as const,
      properties: { branch: { type: "string", description: "Branch to review (default: main)" } },
    },
  },
  {
    name: "forge_checklist",
    description: "Generate a review checklist from the most recent review findings.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "forge_restart",
    description: "Restart a stalled agent by killing it, returning the task to the queue, and spawning ready tasks.",
    inputSchema: {
      type: "object" as const,
      properties: { agentId: { type: "string", description: "The agent ID to restart" } },
      required: ["agentId"],
    },
  },
];

// ─── Tool Handlers ────────────────────────────────────────────

async function handlePlan(description: string, targetRoot?: string): Promise<string> {
  const { config, state, github, projectRoot } = createServices(targetRoot);
  const repoFullName = github.getRepoFullName() ?? `${config.github.org}/unknown`;
  const planPrompt = buildPlanPrompt(description);

  const result = spawnSync("claude", [
    "--model", config.agents.boss_model,
    "--max-turns", "5",
    "-p", "-",
  ], {
    input: planPrompt,
    encoding: "utf-8",
    cwd: projectRoot,
    timeout: 300_000,
  });
  if (result.error) throw result.error;
  const rawOutput = result.stdout;
  if (!rawOutput) throw new Error(result.stderr || `claude exited with code ${result.status}`);

  let content = rawOutput;
  try {
    const envelope = JSON.parse(rawOutput) as { result?: string };
    if (typeof envelope.result === "string") content = envelope.result;
  } catch { /* raw text, use as-is */ }
  content = content.replace(/```json\s*/g, "").replace(/```\s*/g, "");
  const jsonMatch = content.match(/\{[\s\S]*"tasks"[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Could not find tasks JSON in Claude output. Got: ${content.substring(0, 200)}`);

  const tasksData = JSON.parse(jsonMatch[0]) as {
    tasks: Array<{
      id: string; title: string; description: string;
      acceptance_criteria: string[]; depends_on: string[];
      priority: "p0" | "p1" | "p2"; estimated_minutes: number;
    }>;
  };

  const tasks: Task[] = [];
  for (const raw of tasksData.tasks) {
    const task: Task = {
      id: raw.id, title: raw.title, description: raw.description,
      acceptance_criteria: raw.acceptance_criteria, depends_on: raw.depends_on,
      conflicts_with: [], priority: raw.priority,
      estimated_minutes: raw.estimated_minutes, status: "todo",
    };
    try { task.issue_number = github.createIssue(repoFullName, task); }
    catch { /* issue creation may fail if gh is not configured */ }
    tasks.push(task);
  }

  const plan: Plan = {
    project: repoFullName.split("/").pop() || "unknown",
    projectRoot,
    repo: repoFullName,
    description, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    status: "draft", tasks, review_findings: [],
  };
  state.savePlan(plan);
  state.generateProjectState();

  const summary = tasks.map((t) => `  ${t.id} [${t.priority}] ${t.title}`).join("\n");
  return `Plan created with ${tasks.length} tasks:\n${summary}\n\nRun forge_approve to approve.`;
}

async function handleApprove(): Promise<string> {
  const { state } = createServices();
  const plan = state.loadPlan();
  if (!plan) return "Error: No plan found. Run forge_plan first.";
  plan.status = "approved";
  plan.updated_at = new Date().toISOString();
  state.savePlan(plan);
  state.generateProjectState();
  return `Plan approved (${plan.tasks.length} tasks). Run forge_build to spawn agents.`;
}

async function handleBuild(): Promise<string> {
  const { scheduler } = createServices();
  const count = await scheduler.build();
  return count > 0
    ? `Spawned ${count} agent(s). Run forge_status to monitor progress.`
    : "No tasks ready to spawn (all blocked or already in-progress).";
}

async function handleStatus(): Promise<string> {
  return createServices().scheduler.getStatus();
}

async function handleStop(): Promise<string> {
  await createServices().scheduler.stopAll();
  return "All agents stopped. Tasks returned to queue.";
}

async function handleReview(branch: string): Promise<string> {
  const { config, state, github } = createServices();
  const plan = state.loadPlan();
  if (!plan) return "Error: No plan found. Nothing to review.";
  const repoFullName = github.getRepoFullName() ?? plan.repo;
  const pipeline = new ReviewPipeline();
  const findings = await pipeline.runReviews({
    projectRoot: plan.projectRoot, repoFullName, branch,
    model: config.agents.review_model, reviewTypes: config.review.agents,
    confidenceThreshold: config.review.confidence_threshold, forgeDir: state.forgeDir,
  });
  plan.review_findings = findings;
  plan.status = "reviewing";
  plan.updated_at = new Date().toISOString();
  state.savePlan(plan);
  state.generateProjectState();
  return `Review complete: ${findings.length} findings. Run forge_checklist to generate the checklist.`;
}

async function handleChecklist(): Promise<string> {
  const { state } = createServices();
  const plan = state.loadPlan();
  if (!plan) return "Error: No plan found.";
  if (!plan.review_findings || plan.review_findings.length === 0) {
    return "No review findings. Run forge_review first.";
  }
  const pipeline = new ReviewPipeline();
  const checklist = pipeline.generateChecklist(plan.review_findings);
  const path = pipeline.saveChecklist(state.forgeDir, checklist);
  return `${checklist}\n\nSaved to ${path}`;
}

async function handleRestart(agentId: string): Promise<string> {
  const { state, engine, scheduler } = createServices();
  const agent = state.loadAgent(agentId);
  if (!agent) return `Error: Agent ${agentId} not found.`;
  await engine.kill({
    id: agent.id, engineType: agent.engine_type ?? "local",
    pid: agent.pid, host: agent.host, worktreePath: agent.worktree_path,
    outputPath: agent.output_path, startedAt: agent.started_at,
  });
  state.saveAgent({ ...agent, status: "killed", finished_at: new Date().toISOString() });
  state.updateTask(agent.task_id, { status: "todo", assigned_to: undefined });
  const spawned = await scheduler.spawnReadyTasks();
  return `Agent ${agentId} killed, task ${agent.task_id} returned to queue. Spawned ${spawned} new agent(s).`;
}

// ─── MCP Server ───────────────────────────────────────────────

const server = new Server(
  { name: "forge", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    let result: string;
    switch (name) {
      case "forge_plan":
        const planArgs = args as { description: string; projectRoot?: string };
            result = await handlePlan(planArgs.description, planArgs.projectRoot); break;
      case "forge_approve": result = await handleApprove(); break;
      case "forge_build": result = await handleBuild(); break;
      case "forge_status": result = await handleStatus(); break;
      case "forge_stop": result = await handleStop(); break;
      case "forge_review":
        result = await handleReview((args as { branch?: string }).branch ?? "main"); break;
      case "forge_checklist": result = await handleChecklist(); break;
      case "forge_restart":
        result = await handleRestart((args as { agentId: string }).agentId); break;
      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
    return { content: [{ type: "text", text: result }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
});

// ─── Start ────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Forge MCP server failed to start:", err);
  process.exit(1);
});
