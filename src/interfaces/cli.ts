#!/usr/bin/env node
import "dotenv/config";

import { Command } from "commander";
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import chalk from "chalk";
import ora from "ora";
import { loadConfig } from "../config.js";
import { StateManager } from "../core/state-manager.js";
import { Scheduler } from "../core/scheduler.js";
import { Notifier } from "../core/notifier.js";
import { LocalEngine } from "../execution/local-engine.js";
import { RemoteEngine } from "../execution/remote-engine.js";
import { HttpEngine } from "../execution/http-engine.js";
import type { ExecutionEngine } from "../execution/engine.js";
import { GitHubManager } from "../github/manager.js";
import { ReviewPipeline } from "../review/pipeline.js";
import { log } from "../utils/logger.js";
import type { ForgeConfig, Plan, Task } from "../types.js";

// ─── Service Factory ──────────────────────────────────────────

interface ForgeServices {
  config: ForgeConfig;
  state: StateManager;
  github: GitHubManager;
  engine: ExecutionEngine;
  notifier: Notifier;
  scheduler: Scheduler;
}

function resolveProjectRoot(explicitRoot?: string): string {
  if (explicitRoot) return explicitRoot;
  // Try to load an existing plan to get the stored projectRoot
  const cwd = process.cwd();
  const state = new StateManager(cwd);
  const plan = state.loadPlan();
  if (plan?.projectRoot) return plan.projectRoot;
  return cwd;
}

function createServices(config: ForgeConfig, projectRoot?: string): ForgeServices {
  const root = resolveProjectRoot(projectRoot);
  const state = new StateManager(root);
  const github = new GitHubManager(config.github);
  github.setCwd(root);
  // Pick engine based on host config
  const firstHost = Object.values(config.hosts)[0];
  const engine: ExecutionEngine = firstHost?.type === "http"
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
    projectRoot: root,
  });
  return { config, state, github, engine, notifier, scheduler };
}

// ─── Plan Prompt Template ─────────────────────────────────────

function buildPlanPrompt(description: string): string {
  return [
    "You are a project planner. Break this project description into discrete implementation tasks.",
    "",
    `Project: ${description}`,
    "",
    "Output ONLY a JSON object with this exact structure (no other text):",
    '{ "tasks": [{ "id": "task-1", "title": "Short task title", "description": "Detailed description",',
    '  "acceptance_criteria": ["Criterion 1", "Criterion 2"], "depends_on": [], "priority": "p0",',
    '  "estimated_minutes": 15 }] }',
    "",
    "Rules:",
    "- Each task completable by one agent in 10-30 minutes",
    "- Use depends_on to reference other task IDs",
    "- Priority: p0=core/blocking, p1=important, p2=nice-to-have",
    "- Keep tasks focused: one module, one feature, one concern",
    "- Include test task per implementation task",
    "- Maximum 15 tasks",
  ].join("\n");
}

// ─── Shared: Parse Claude plan output into Task[] ─────────────

interface RawTaskData {
  id: string;
  title: string;
  description: string;
  acceptance_criteria: string[];
  depends_on: string[];
  priority: "p0" | "p1" | "p2";
  estimated_minutes: number;
}

function parsePlanOutput(rawOutput: string): RawTaskData[] {
  let parsed: { result?: string } & Record<string, unknown>;
  try {
    parsed = JSON.parse(rawOutput);
  } catch {
    throw new Error("Claude returned invalid JSON");
  }
  const content = typeof parsed.result === "string" ? parsed.result : rawOutput;
  const jsonMatch = content.match(/\{[\s\S]*"tasks"[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Could not find tasks JSON in Claude output");
  const tasksData = JSON.parse(jsonMatch[0]) as { tasks: RawTaskData[] };
  return tasksData.tasks;
}

function buildTasksFromRaw(rawTasks: RawTaskData[], github: GitHubManager, repo: string): Task[] {
  const tasks: Task[] = [];
  for (const raw of rawTasks) {
    const task: Task = {
      id: raw.id, title: raw.title, description: raw.description,
      acceptance_criteria: raw.acceptance_criteria, depends_on: raw.depends_on,
      conflicts_with: [], priority: raw.priority,
      estimated_minutes: raw.estimated_minutes, status: "todo",
    };
    try { task.issue_number = github.createIssue(repo, task); }
    catch (err) { log.warn(`Could not create issue for ${task.id}: ${err}`); }
    tasks.push(task);
  }
  return tasks;
}

function buildAgentHandle(agent: import("../types.js").Agent) {
  return {
    id: agent.id,
    engineType: agent.engine_type ?? "local" as "local" | "ssh" | "http",
    pid: agent.pid, host: agent.host,
    worktreePath: agent.worktree_path,
    outputPath: agent.output_path,
    startedAt: agent.started_at,
  };
}

// ─── CLI Definition ───────────────────────────────────────────

const program = new Command();
program.name("forge").description("Multi-agent Claude Code orchestrator").version("1.0.0");

// forge new
program.command("new").argument("<name>", "Project name")
  .option("-d, --description <desc>", "Project description", "")
  .option("-v, --visibility <vis>", "Repo visibility (public/private)", "private")
  .action(async (name: string, opts: { description: string; visibility: string }) => {
    const config = loadConfig();
    const github = new GitHubManager(config.github);
    const spinner = ora(`Creating project ${name}...`).start();
    try {
      const desc = opts.description || `${name} — managed by Forge`;
      const localDir = github.bootstrapProject(name, desc);
      spinner.succeed(`Project created: ${config.github.org}/${name}`);
      console.log(chalk.bold("\nNext steps:"));
      console.log(`  cd ${localDir}\n  forge plan "Description"\n  forge approve\n  forge build`);
    } catch (err) {
      spinner.fail("Failed to create project");
      log.error(String(err)); process.exit(1);
    }
  });

// forge init
program.command("init").argument("[repo]", "Repository (owner/repo) to clone and initialize")
  .action(async (repo?: string) => {
    const config = loadConfig();
    const github = new GitHubManager(config.github);
    const spinner = ora("Initializing Forge...").start();
    try {
      const targetRepo = repo ?? github.getRepoFullName();
      if (!targetRepo) { spinner.fail("Not in a git repo and no repo argument provided"); process.exit(1); }
      github.bootstrapLabels(targetRepo);
      const state = new StateManager(process.cwd());
      spinner.succeed(`Forge initialized for ${targetRepo}`);
      console.log(`  Labels created. State dir: ${state.forgeDir}`);
    } catch (err) {
      spinner.fail("Initialization failed");
      log.error(String(err)); process.exit(1);
    }
  });

// forge plan
program.command("plan").argument("<description>", "Description of work to plan")
  .action(async (description: string) => {
    const config = loadConfig();
    const github = new GitHubManager(config.github);
    github.setCwd(process.cwd());

    // Smart repo detection — find or create
    let repoFullName = github.getRepoFullName();

    if (!repoFullName) {
      // No git repo here — ask and create one
      console.log(chalk.yellow("\nNo git repo detected in this directory."));
      const dirName = process.cwd().split(/[/\\]/).pop() || "project";

      const { default: inquirer } = await import("inquirer");
      const { account } = await inquirer.prompt([{
        type: "list",
        name: "account",
        message: "Which GitHub account should own this repo?",
        choices: [
          { name: "zanijr (personal)", value: "zanijr" },
          { name: "ZbOscar (company)", value: "ZbOscar" },
        ],
      }]);

      const { repoName } = await inquirer.prompt([{
        type: "input",
        name: "repoName",
        message: "Repo name:",
        default: dirName,
      }]);

      const { visibility } = await inquirer.prompt([{
        type: "list",
        name: "visibility",
        message: "Visibility:",
        choices: ["private", "public"],
        default: "private",
      }]);

      const spinner0 = ora(`Creating ${account}/${repoName}...`).start();
      try {
        // Init git if needed
        try { execSync("git rev-parse --git-dir", { stdio: "pipe", cwd: process.cwd() }); }
        catch { execSync("git init", { stdio: "pipe", cwd: process.cwd() }); }

        // Create initial commit if empty
        try { execSync("git log -1", { stdio: "pipe", cwd: process.cwd() }); }
        catch {
          execSync('git add -A && git commit --allow-empty -m "Initial commit"', {
            stdio: "pipe", cwd: process.cwd(),
          });
        }

        // Create remote repo and push
        const visFlag = visibility === "public" ? "--public" : "--private";
        execSync(`gh repo create ${account}/${repoName} ${visFlag} --source . --push`, {
          stdio: "pipe", cwd: process.cwd(), encoding: "utf-8",
        });

        repoFullName = `${account}/${repoName}`;
        github.setCwd(process.cwd());

        // Set up forge labels
        github.bootstrapLabels(repoFullName);
        spinner0.succeed(`Created ${repoFullName}`);
      } catch (err) {
        spinner0.fail("Failed to create repo");
        log.error(String(err));
        process.exit(1);
      }
    } else {
      // Repo exists — ensure forge labels
      try { github.bootstrapLabels(repoFullName); } catch { /* labels may exist */ }
    }

    const { state } = createServices(config);
    const spinner = ora("Planning tasks with Claude...").start();
    try {
      const planPrompt = buildPlanPrompt(description);
      const tmpFile = join(tmpdir(), `forge-plan-${Date.now()}.md`);
      writeFileSync(tmpFile, planPrompt);
      let rawOutput: string;
      try {
        rawOutput = execSync(
          `cat "${tmpFile}" | claude --model ${config.agents.boss_model} --max-turns 3 --output-format json -p -`,
          { encoding: "utf-8", cwd: process.cwd(), shell: "/bin/bash" },
        );
      } finally {
        try { unlinkSync(tmpFile); } catch { /* cleanup best-effort */ }
      }
      const rawTasks = parsePlanOutput(rawOutput);
      spinner.text = "Creating GitHub Issues...";
      const tasks = buildTasksFromRaw(rawTasks, github, repoFullName);
      const plan: Plan = {
        project: repoFullName.split("/").pop() || "unknown",
        projectRoot: process.cwd(),
        repo: repoFullName,
        description, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        status: "draft", tasks, review_findings: [],
      };
      state.savePlan(plan);
      state.generateProjectState();
      spinner.succeed(`Plan created: ${tasks.length} tasks`);
      console.log();
      for (const t of tasks) {
        const issue = t.issue_number ? ` (#${t.issue_number})` : "";
        const deps = t.depends_on.length > 0 ? chalk.gray(` <- ${t.depends_on.join(", ")}`) : "";
        console.log(`  ${chalk.bold(t.id)} [${t.priority}] ${t.title}${issue}${deps}`);
      }
      console.log(`\nRun ${chalk.cyan("forge approve")} to approve this plan.`);
    } catch (err) {
      spinner.fail("Planning failed");
      log.error(String(err)); process.exit(1);
    }
  });

// forge approve
program.command("approve").description("Approve the current plan")
  .action(async () => {
    const config = loadConfig();
    const { state } = createServices(config);
    const plan = state.loadPlan();
    if (!plan) { log.error("No plan found. Run 'forge plan' first."); process.exit(1); }
    if (plan.status !== "draft") log.warn(`Plan status is already '${plan.status}', not 'draft'.`);
    plan.status = "approved";
    plan.updated_at = new Date().toISOString();
    state.savePlan(plan);
    state.generateProjectState();
    console.log(chalk.green("Plan approved."));
    console.log(`Run ${chalk.cyan("forge build")} to spawn agents.`);
  });

// forge build
program.command("build").description("Spawn worker agents for ready tasks")
  .action(async () => {
    const config = loadConfig();
    const { scheduler } = createServices(config);
    const spinner = ora("Spawning agents...").start();
    try {
      const count = await scheduler.build();
      if (count > 0) { spinner.succeed(`Spawned ${count} agent(s)`); console.log(`Run ${chalk.cyan("forge status")} to monitor.`); }
      else spinner.info("No tasks ready to spawn (all blocked or in-progress)");
    } catch (err) {
      spinner.fail("Build failed");
      log.error(String(err)); process.exit(1);
    }
  });

// forge status
program.command("status").description("Show current project status")
  .action(async () => {
    const { scheduler } = createServices(loadConfig());
    console.log(scheduler.getStatus());
  });

// forge stop
program.command("stop").description("Stop all running agents")
  .action(async () => {
    const { scheduler } = createServices(loadConfig());
    const spinner = ora("Stopping agents...").start();
    try { await scheduler.stopAll(); spinner.succeed("All agents stopped"); }
    catch (err) { spinner.fail("Failed to stop agents"); log.error(String(err)); process.exit(1); }
  });

// forge review
program.command("review").description("Run the review pipeline")
  .option("-b, --branch <branch>", "Branch to review", "main")
  .action(async (opts: { branch: string }) => {
    const config = loadConfig();
    const { state, github } = createServices(config);
    const spinner = ora("Running review pipeline...").start();
    try {
      const plan = state.loadPlan();
      if (!plan) { spinner.fail("No plan found. Nothing to review."); process.exit(1); }
      const repoFullName = github.getRepoFullName() ?? plan.repo;
      const pipeline = new ReviewPipeline();
      const findings = await pipeline.runReviews({
        projectRoot: plan.projectRoot, repoFullName, branch: opts.branch,
        model: config.agents.review_model, reviewTypes: config.review.agents,
        confidenceThreshold: config.review.confidence_threshold, forgeDir: state.forgeDir,
      });
      plan.review_findings = findings;
      plan.status = "reviewing";
      plan.updated_at = new Date().toISOString();
      state.savePlan(plan);
      state.generateProjectState();
      spinner.succeed(`Review complete: ${findings.length} findings`);
      console.log(`Run ${chalk.cyan("forge checklist")} to generate the review checklist.`);
    } catch (err) {
      spinner.fail("Review failed");
      log.error(String(err)); process.exit(1);
    }
  });

// forge checklist
program.command("checklist").description("Generate review checklist")
  .action(async () => {
    const { state } = createServices(loadConfig());
    const plan = state.loadPlan();
    if (!plan) { log.error("No plan found."); process.exit(1); }
    if (!plan.review_findings || plan.review_findings.length === 0) {
      log.warn("No review findings. Run 'forge review' first."); process.exit(1);
    }
    const pipeline = new ReviewPipeline();
    const checklist = pipeline.generateChecklist(plan.review_findings);
    const path = pipeline.saveChecklist(state.forgeDir, checklist);
    console.log(checklist);
    console.log(chalk.gray(`\nSaved to ${path}`));
  });

// forge restart
program.command("restart").argument("<agent-id>", "Agent ID to restart")
  .description("Restart a stalled agent")
  .action(async (agentId: string) => {
    const config = loadConfig();
    const { state, engine, scheduler } = createServices(config);
    const spinner = ora(`Restarting ${agentId}...`).start();
    try {
      const agent = state.loadAgent(agentId);
      if (!agent) { spinner.fail(`Agent ${agentId} not found`); process.exit(1); }
      await engine.kill(buildAgentHandle(agent));
      state.saveAgent({ ...agent, status: "killed", finished_at: new Date().toISOString() });
      state.updateTask(agent.task_id, { status: "todo", assigned_to: undefined });
      const spawned = await scheduler.spawnReadyTasks();
      spinner.succeed(`Agent ${agentId} killed, task returned to queue. Spawned ${spawned} new agent(s).`);
    } catch (err) {
      spinner.fail(`Restart failed for ${agentId}`);
      log.error(String(err)); process.exit(1);
    }
  });

// forge notify
program.command("notify").argument("<action>", "Notification action (test)")
  .description("Test notification channels")
  .action(async (action: string) => {
    if (action !== "test") { log.error(`Unknown notify action: ${action}. Use 'test'.`); process.exit(1); }
    const config = loadConfig();
    await new Notifier(config.notifications, config.telegram).test();
  });

program.parse();
