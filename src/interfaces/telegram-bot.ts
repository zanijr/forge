#!/usr/bin/env node
import TelegramBot from "node-telegram-bot-api";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { loadConfig } from "../config.js";
import { StateManager } from "../core/state-manager.js";
import { Scheduler } from "../core/scheduler.js";
import { Notifier } from "../core/notifier.js";
import { execSync } from "node:child_process";
import { LocalEngine } from "../execution/local-engine.js";
import { GitHubManager } from "../github/manager.js";
import { ReviewPipeline } from "../review/pipeline.js";
import { log } from "../utils/logger.js";

// ─── Configuration ───────────────────────────────────────────────

const config = loadConfig();

const token = process.env[config.telegram?.bot_token_env || "FORGE_TELEGRAM_TOKEN"];
const authorizedChat = process.env[config.telegram?.chat_id_env || "FORGE_TELEGRAM_CHAT"];

if (!token) {
  console.error(`Set ${config.telegram?.bot_token_env || "FORGE_TELEGRAM_TOKEN"} env var`);
  process.exit(1);
}

// ─── Multi-Project Target System ─────────────────────────────────

/**
 * The bot can manage multiple projects. The "active target" determines
 * which project's .forge/ state all commands operate on.
 *
 * Projects are discovered from FORGE_PROJECTS_DIR (a directory where
 * each subdirectory is a git repo with a .forge/ folder), or registered
 * individually via FORGE_PROJECTS (comma-separated absolute paths).
 *
 * Example env:
 *   FORGE_PROJECTS_DIR=/home/zbonham/projects
 *   FORGE_PROJECTS=/home/zbonham/my-api,/home/zbonham/my-app
 */

interface ProjectTarget {
  name: string;
  path: string;
}

function discoverProjects(): ProjectTarget[] {
  const targets: ProjectTarget[] = [];

  // 1. Explicit project paths from env
  const explicit = process.env.FORGE_PROJECTS;
  if (explicit) {
    for (const p of explicit.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (existsSync(join(p, ".forge"))) {
        targets.push({ name: basename(p), path: p });
      }
    }
  }

  // 2. Scan a projects directory
  const projectsDir = process.env.FORGE_PROJECTS_DIR;
  if (projectsDir && existsSync(projectsDir)) {
    for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const fullPath = join(projectsDir, entry.name);
      // Include if it has a .forge dir or a .git dir (potential forge project)
      if (existsSync(join(fullPath, ".forge")) || existsSync(join(fullPath, ".git"))) {
        // Avoid duplicates from explicit list
        if (!targets.some((t) => t.path === fullPath)) {
          targets.push({ name: entry.name, path: fullPath });
        }
      }
    }
  }

  // 3. Fallback to cwd if nothing else found
  if (targets.length === 0) {
    const cwd = process.cwd();
    targets.push({ name: basename(cwd), path: cwd });
  }

  return targets;
}

// Per-chat active project target
const chatTargets = new Map<number, ProjectTarget>();

function getActiveTarget(chatId: number): ProjectTarget {
  const existing = chatTargets.get(chatId);
  if (existing) return existing;
  // Default to first discovered project
  const projects = discoverProjects();
  const defaultTarget = projects[0];
  chatTargets.set(chatId, defaultTarget);
  return defaultTarget;
}

// ─── Service Factory ─────────────────────────────────────────────

const bot = new TelegramBot(token, { polling: true });
log.info("Forge Telegram bot started. Waiting for commands...");

function isAuthorized(chatId: number): boolean {
  if (!authorizedChat) return true;
  return String(chatId) === authorizedChat;
}

function createServices(chatId: number) {
  const target = getActiveTarget(chatId);
  const projectRoot = target.path;
  const forgeDir = join(projectRoot, config.state.dir);

  const state = new StateManager(projectRoot);
  const engine = new LocalEngine(forgeDir);
  const github = new GitHubManager(config.github);
  github.setCwd(projectRoot);
  const notifier = new Notifier(config.notifications, config.telegram);
  const repoFullName = state.loadPlan()?.repo ?? github.getRepoFullName() ?? "";
  const maxAgents = Object.values(config.hosts).reduce((sum, h) => sum + h.max_agents, 0);
  const scheduler = new Scheduler(state, engine, github, notifier, {
    staggerSeconds: config.agents.stagger_seconds,
    heartbeatInterval: config.state.heartbeat_interval,
    maxAgents,
    model: config.agents.model,
    maxTurns: config.agents.max_turns,
    allowedTools: config.agents.allowed_tools,
    timeoutMinutes: config.agents.timeout_minutes,
    repoFullName,
    projectRoot,
  });
  const review = new ReviewPipeline();
  return { state, scheduler, review, github, projectRoot, forgeDir };
}

// ─── Commands ────────────────────────────────────────────────────

bot.onText(/\/start/, (msg) => {
  if (!isAuthorized(msg.chat.id)) return;
  const target = getActiveTarget(msg.chat.id);
  bot.sendMessage(msg.chat.id,
    "*Forge Multi-Agent Orchestrator*\n\n" +
    `Active project: \`${target.name}\` (${target.path})\n\n` +
    "Commands:\n" +
    "/status — Agent and task status\n" +
    "/approve — Approve pending plan\n" +
    "/build — Start building\n" +
    "/stop — Emergency stop\n" +
    "/review — Run code review\n" +
    "/checklist — Show review findings\n" +
    "/agents — List running agents\n" +
    "/projects — List available projects\n" +
    "/target <name> — Switch active project\n" +
    "/deploy — Deploy to Windows PC / mapped drives\n" +
    "/help — This message",
    { parse_mode: "Markdown" },
  );
});

bot.onText(/\/help/, (msg) => {
  if (!isAuthorized(msg.chat.id)) return;
  const target = getActiveTarget(msg.chat.id);
  bot.sendMessage(msg.chat.id,
    `Active: \`${target.name}\`\n\n` +
    "/status — Current status\n" +
    "/approve — Approve plan\n" +
    "/build — Spawn agents\n" +
    "/stop — Stop all agents\n" +
    "/review — Run reviewers\n" +
    "/checklist — Review findings\n" +
    "/agents — Running agents\n" +
    "/projects — List projects\n" +
    "/target <name> — Switch project\n" +
    "/deploy — Deploy to Windows PC",
    { parse_mode: "Markdown" },
  );
});

// ─── Project Management Commands ─────────────────────────────────

bot.onText(/\/projects/, (msg) => {
  if (!isAuthorized(msg.chat.id)) return;
  const projects = discoverProjects();
  const active = getActiveTarget(msg.chat.id);

  if (projects.length === 0) {
    bot.sendMessage(msg.chat.id, "No projects found. Set FORGE_PROJECTS_DIR or FORGE_PROJECTS env vars.");
    return;
  }

  let text = "*Available Projects:*\n\n";
  for (const p of projects) {
    const marker = p.path === active.path ? " (active)" : "";
    const hasForge = existsSync(join(p.path, ".forge", "plan.json")) ? " [has plan]" : "";
    text += `\`${p.name}\`${marker}${hasForge}\n  ${p.path}\n\n`;
  }
  text += "Use /target <name> to switch.";
  bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
});

bot.onText(/\/target(?:\s+(.+))?/, (msg, match) => {
  if (!isAuthorized(msg.chat.id)) return;
  const name = match?.[1]?.trim();

  if (!name) {
    const active = getActiveTarget(msg.chat.id);
    bot.sendMessage(msg.chat.id,
      `Active project: \`${active.name}\` (${active.path})\n\nUse /target <name> to switch.`,
      { parse_mode: "Markdown" },
    );
    return;
  }

  const projects = discoverProjects();
  const found = projects.find((p) => p.name === name || p.name.toLowerCase() === name.toLowerCase());

  if (!found) {
    const available = projects.map((p) => `\`${p.name}\``).join(", ");
    bot.sendMessage(msg.chat.id,
      `Project "${name}" not found.\n\nAvailable: ${available}`,
      { parse_mode: "Markdown" },
    );
    return;
  }

  chatTargets.set(msg.chat.id, found);
  bot.sendMessage(msg.chat.id,
    `Switched to \`${found.name}\` (${found.path})`,
    { parse_mode: "Markdown" },
  );
});

// ─── Forge Operation Commands ────────────────────────────────────

bot.onText(/\/status/, async (msg) => {
  if (!isAuthorized(msg.chat.id)) return;
  try {
    const { scheduler } = createServices(msg.chat.id);
    const target = getActiveTarget(msg.chat.id);
    const status = scheduler.getStatus();
    const header = `Project: \`${target.name}\`\n\n`;
    const full = header + status;
    const text = full.length > 4000 ? full.slice(0, 4000) + "\n..." : full;
    await bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `Error: ${e}`);
  }
});

bot.onText(/\/approve/, async (msg) => {
  if (!isAuthorized(msg.chat.id)) return;
  try {
    const { state } = createServices(msg.chat.id);
    const plan = state.loadPlan();
    if (!plan) {
      await bot.sendMessage(msg.chat.id, "No plan found.");
      return;
    }
    plan.status = "approved";
    plan.updated_at = new Date().toISOString();
    state.savePlan(plan);
    state.generateProjectState();
    await bot.sendMessage(msg.chat.id, `Plan approved (${plan.tasks.length} tasks). Run /build to start.`);
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `Error: ${e}`);
  }
});

bot.onText(/\/build/, async (msg) => {
  if (!isAuthorized(msg.chat.id)) return;
  try {
    const { scheduler } = createServices(msg.chat.id);
    const target = getActiveTarget(msg.chat.id);
    await bot.sendMessage(msg.chat.id, `Spawning agents for \`${target.name}\`...`, { parse_mode: "Markdown" });
    const spawned = await scheduler.build();
    await bot.sendMessage(msg.chat.id, `Spawned ${spawned} agent(s). Use /status to monitor.`);
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `Error: ${e}`);
  }
});

bot.onText(/\/stop/, async (msg) => {
  if (!isAuthorized(msg.chat.id)) return;
  try {
    const { scheduler } = createServices(msg.chat.id);
    await scheduler.stopAll();
    await bot.sendMessage(msg.chat.id, "All agents stopped.");
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `Error: ${e}`);
  }
});

bot.onText(/\/review/, async (msg) => {
  if (!isAuthorized(msg.chat.id)) return;
  try {
    const { state, review, projectRoot, forgeDir } = createServices(msg.chat.id);
    const plan = state.loadPlan();
    if (!plan) { await bot.sendMessage(msg.chat.id, "No plan found."); return; }

    await bot.sendMessage(msg.chat.id, "Starting review pipeline (5 reviewers)...");

    const findings = await review.runReviews({
      projectRoot,
      repoFullName: plan.repo,
      branch: "main",
      model: config.agents.review_model,
      reviewTypes: config.review.agents,
      confidenceThreshold: config.review.confidence_threshold,
      forgeDir,
    });

    plan.review_findings = findings;
    plan.status = "reviewing";
    plan.updated_at = new Date().toISOString();
    state.savePlan(plan);
    state.generateProjectState();

    await bot.sendMessage(msg.chat.id, `Review complete: ${findings.length} findings. Use /checklist to see.`);
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `Error: ${e}`);
  }
});

bot.onText(/\/checklist/, async (msg) => {
  if (!isAuthorized(msg.chat.id)) return;
  try {
    const { state, review } = createServices(msg.chat.id);
    const plan = state.loadPlan();
    if (!plan) { await bot.sendMessage(msg.chat.id, "No plan found."); return; }

    const checklist = review.generateChecklist(plan.review_findings);
    const text = checklist.length > 4000 ? checklist.slice(0, 4000) + "\n..." : checklist;
    await bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `Error: ${e}`);
  }
});

bot.onText(/\/agents/, async (msg) => {
  if (!isAuthorized(msg.chat.id)) return;
  try {
    const { state } = createServices(msg.chat.id);
    const target = getActiveTarget(msg.chat.id);
    const agents = state.listAgents();
    if (agents.length === 0) {
      await bot.sendMessage(msg.chat.id, `No agents in \`${target.name}\`.`, { parse_mode: "Markdown" });
      return;
    }
    let text = `*Agents — ${target.name}:*\n`;
    for (const a of agents) {
      const runtime = Math.round((Date.now() - new Date(a.started_at).getTime()) / 60000);
      text += `- ${a.id} [${a.status}] ${runtime}m (PID ${a.pid})\n`;
    }
    await bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `Error: ${e}`);
  }
});

// ─── Deploy Commands ─────────────────────────────────────────────

/**
 * Execute a command on the Windows PC via the reverse SSH tunnel.
 * The tunnel runs on port 2222 on localhost (from the server's perspective).
 */
function execOnPC(command: string, timeoutMs = 120_000): string {
  const deployConfig = (config as Record<string, unknown>).deploy as Record<string, { ssh_host: string; ssh_port: number; ssh_user: string }> | undefined;
  const pc = deployConfig?.pc;
  const host = pc?.ssh_host ?? "localhost";
  const port = pc?.ssh_port ?? 2222;
  const user = pc?.ssh_user ?? "zbonham";

  return execSync(
    `ssh -p ${port} -o ConnectTimeout=10 -o StrictHostKeyChecking=no ${user}@${host} ${JSON.stringify(command)}`,
    { encoding: "utf-8", timeout: timeoutMs },
  ).trim();
}

bot.onText(/\/deploy(?:\s+(.+))?/, async (msg, match) => {
  if (!isAuthorized(msg.chat.id)) return;
  const subcommand = match?.[1]?.trim();

  if (!subcommand || subcommand === "help") {
    await bot.sendMessage(msg.chat.id,
      "*Deploy Commands:*\n\n" +
      "/deploy ping — Check if Windows PC is reachable\n" +
      "/deploy pull <repo> — Git pull a repo on the PC\n" +
      "/deploy drives — Show mapped drive status\n" +
      "/deploy copy <src> <drive:path> — Copy from PC repo to mapped drive\n" +
      "/deploy run <command> — Run a command on the PC\n" +
      "/deploy test <repo> — Run tests on the PC",
      { parse_mode: "Markdown" },
    );
    return;
  }

  try {
    // /deploy ping
    if (subcommand === "ping") {
      const result = execOnPC("echo connected", 15_000);
      await bot.sendMessage(msg.chat.id, `Windows PC is reachable: ${result}`);
      return;
    }

    // /deploy drives
    if (subcommand === "drives") {
      const result = execOnPC("net use", 15_000);
      const text = result.length > 3900 ? result.slice(0, 3900) + "\n..." : result;
      await bot.sendMessage(msg.chat.id, `\`\`\`\n${text}\n\`\`\``, { parse_mode: "Markdown" });
      return;
    }

    // /deploy pull <repo>
    const pullMatch = subcommand.match(/^pull\s+(.+)/);
    if (pullMatch) {
      const repo = pullMatch[1];
      await bot.sendMessage(msg.chat.id, `Pulling \`${repo}\` on Windows PC...`, { parse_mode: "Markdown" });
      const deployConfig = (config as Record<string, unknown>).deploy as Record<string, { projects_dir?: string }> | undefined;
      const projectsDir = deployConfig?.pc?.projects_dir ?? "C:\\\\Users\\\\zbonham\\\\source\\\\repos";
      const result = execOnPC(`cd "${projectsDir}\\\\${repo}" && git pull`, 60_000);
      await bot.sendMessage(msg.chat.id, `Pull complete:\n\`\`\`\n${result}\n\`\`\``, { parse_mode: "Markdown" });
      return;
    }

    // /deploy copy <src-repo> <drive:dest-path>
    const copyMatch = subcommand.match(/^copy\s+(\S+)\s+([A-Z]:\\?.+)/i);
    if (copyMatch) {
      const srcRepo = copyMatch[1];
      const destPath = copyMatch[2];
      await bot.sendMessage(msg.chat.id, `Copying \`${srcRepo}\` to \`${destPath}\`...`, { parse_mode: "Markdown" });
      const deployConfig = (config as Record<string, unknown>).deploy as Record<string, { projects_dir?: string }> | undefined;
      const projectsDir = deployConfig?.pc?.projects_dir ?? "C:\\\\Users\\\\zbonham\\\\source\\\\repos";
      const result = execOnPC(
        `robocopy "${projectsDir}\\\\${srcRepo}" "${destPath}" /MIR /XD .git node_modules /NFL /NDL /NJH /NJS`,
        300_000,
      );
      await bot.sendMessage(msg.chat.id, `Copy complete:\n\`\`\`\n${result}\n\`\`\``, { parse_mode: "Markdown" });
      return;
    }

    // /deploy test <repo>
    const testMatch = subcommand.match(/^test\s+(.+)/);
    if (testMatch) {
      const repo = testMatch[1];
      await bot.sendMessage(msg.chat.id, `Running tests for \`${repo}\` on Windows PC...`, { parse_mode: "Markdown" });
      const deployConfig = (config as Record<string, unknown>).deploy as Record<string, { projects_dir?: string }> | undefined;
      const projectsDir = deployConfig?.pc?.projects_dir ?? "C:\\\\Users\\\\zbonham\\\\source\\\\repos";
      const result = execOnPC(`cd "${projectsDir}\\\\${repo}" && npm test 2>&1`, 300_000);
      const text = result.length > 3900 ? result.slice(0, 3900) + "\n..." : result;
      await bot.sendMessage(msg.chat.id, `Test results:\n\`\`\`\n${text}\n\`\`\``, { parse_mode: "Markdown" });
      return;
    }

    // /deploy run <command>
    const runMatch = subcommand.match(/^run\s+(.+)/);
    if (runMatch) {
      const command = runMatch[1];
      await bot.sendMessage(msg.chat.id, `Running on PC: \`${command}\``, { parse_mode: "Markdown" });
      const result = execOnPC(command, 120_000);
      const text = result.length > 3900 ? result.slice(0, 3900) + "\n..." : result;
      await bot.sendMessage(msg.chat.id, `\`\`\`\n${text}\n\`\`\``, { parse_mode: "Markdown" });
      return;
    }

    await bot.sendMessage(msg.chat.id, "Unknown deploy command. Use /deploy help.");
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    const short = errMsg.length > 1000 ? errMsg.slice(0, 1000) + "..." : errMsg;
    await bot.sendMessage(msg.chat.id, `Deploy error: ${short}`);
  }
});

// Handle unknown commands
bot.on("message", (msg) => {
  if (!isAuthorized(msg.chat.id)) return;
  if (msg.text && msg.text.startsWith("/") && !msg.text.match(/^\/(start|help|status|approve|build|stop|review|checklist|agents|projects|target|deploy)/)) {
    bot.sendMessage(msg.chat.id, "Unknown command. Use /help to see available commands.");
  }
});
