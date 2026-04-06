import "dotenv/config";
import { createServer } from "node:http";
import { spawn as cpSpawn, execSync } from "node:child_process";
import {
  writeFileSync, readFileSync, existsSync, mkdirSync, openSync,
} from "node:fs";
import { join } from "node:path";
import { isProcessAlive, killProcess } from "../execution/platform.js";
import { buildWorkerPrompt } from "../workers/prompts.js";
import type { SpawnOptions } from "../execution/engine.js";
import type { Task } from "../types.js";

// ─── State ───────────────────────────────────────────────────────

interface WorkerRecord {
  id: string;
  pid?: number;
  status: "running" | "completed" | "failed" | "killed";
  worktreePath: string;
  outputPath: string;
  startedAt: string;
  finishedAt?: string;
}

const workers = new Map<string, WorkerRecord>();
const FORGE_DIR = process.env.FORGE_DIR || "/app/.forge";
const REPOS_DIR = process.env.REPOS_DIR || "/repos";
const MAX_AGENTS = parseInt(process.env.FORGE_MAX_AGENTS || "10", 10);
const API_TOKEN = process.env.FORGE_API_TOKEN || "";

// ─── Helpers ─────────────────────────────────────────────────────

function json(res: import("node:http").ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function parseBody(req: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      try { resolve(JSON.parse(body)); }
      catch { reject(new Error("Invalid JSON body")); }
    });
  });
}

function auth(req: import("node:http").IncomingMessage): boolean {
  if (!API_TOKEN) return true; // no token configured = open
  const header = req.headers.authorization || "";
  return header === `Bearer ${API_TOKEN}`;
}

function resolveClaudePath(): string {
  try { return execSync("which claude", { encoding: "utf-8" }).trim(); }
  catch { return "claude"; }
}

function ensureRepo(repoUrl: string): string {
  const repoName = repoUrl.split("/").pop()?.replace(/\.git$/, "") || "repo";
  const repoPath = join(REPOS_DIR, repoName);
  if (existsSync(join(repoPath, ".git"))) {
    execSync("git fetch origin", { cwd: repoPath, stdio: "pipe" });
  } else {
    mkdirSync(REPOS_DIR, { recursive: true });
    execSync(`git clone ${repoUrl} ${repoPath}`, { stdio: "pipe" });
  }
  return repoPath;
}

// ─── Refresh worker statuses ─────────────────────────────────────

function refreshWorker(w: WorkerRecord): void {
  if (w.status !== "running") return;
  if (!w.pid || !isProcessAlive(w.pid)) {
    // Process finished — check output
    let output: string | null = null;
    try {
      if (existsSync(w.outputPath)) {
        output = readFileSync(w.outputPath, "utf-8").trim() || null;
      }
    } catch { /* ignore */ }
    if (output) {
      try { JSON.parse(output); w.status = "completed"; }
      catch { w.status = "failed"; }
    } else {
      w.status = "failed";
    }
    w.finishedAt = new Date().toISOString();
  }
}

// ─── Route Handlers ──────────────────────────────────────────────

async function handleSpawn(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
): Promise<void> {
  const body = await parseBody(req);
  const { task, repoUrl, model, maxTurns, repoFullName, allowedTools } = body as {
    task: Task; repoUrl: string; model: string;
    maxTurns: number; repoFullName: string; allowedTools: string[];
  };

  // Check capacity
  let running = 0;
  for (const w of workers.values()) { refreshWorker(w); if (w.status === "running") running++; }
  if (running >= MAX_AGENTS) {
    json(res, 429, { error: "At capacity", running, max: MAX_AGENTS });
    return;
  }

  const repoPath = ensureRepo(repoUrl);
  const agentId = `worker-${task.id}`;
  const branchName = `forge/task-${task.issue_number ?? task.id}`;
  const worktreePath = join(FORGE_DIR, "worktrees", agentId);
  const outputPath = join(FORGE_DIR, "outputs", `${agentId}.json`);
  const promptPath = join(FORGE_DIR, "prompts", `${agentId}.md`);

  for (const dir of ["worktrees", "outputs", "prompts"]) {
    mkdirSync(join(FORGE_DIR, dir), { recursive: true });
  }

  // Build worker prompt
  const opts: SpawnOptions = {
    task, repoFullName: repoFullName || "", projectRoot: repoPath,
    model: model || "sonnet", maxTurns: maxTurns || 25, allowedTools: allowedTools || [],
  };
  const prompt = buildWorkerPrompt(opts);
  writeFileSync(promptPath, prompt);

  // Create worktree
  try {
    execSync(`git worktree add -b "${branchName}" "${worktreePath}" HEAD`, { cwd: repoPath, stdio: "pipe" });
  } catch {
    try { execSync(`git worktree add "${worktreePath}" "${branchName}"`, { cwd: repoPath, stdio: "pipe" }); }
    catch { /* may already exist */ }
  }

  // Spawn claude
  const outFd = openSync(outputPath, "w");
  const errPath = join(FORGE_DIR, "outputs", `${agentId}.err`);
  const errFd = openSync(errPath, "w");
  const claudePath = resolveClaudePath();

  const child = cpSpawn(claudePath, [
    "-p", readFileSync(promptPath, "utf-8"),
    "--model", model || "sonnet",
    "--max-turns", String(maxTurns || 25),
    "--output-format", "json",
    "--permission-mode", "bypassPermissions",
  ], {
    cwd: worktreePath,
    detached: true,
    stdio: ["ignore", outFd, errFd],
  });
  child.unref();

  const record: WorkerRecord = {
    id: agentId, pid: child.pid, status: "running",
    worktreePath, outputPath, startedAt: new Date().toISOString(),
  };
  workers.set(agentId, record);

  json(res, 201, { id: agentId, status: "running", pid: child.pid });
}

function handleGetWorker(
  res: import("node:http").ServerResponse,
  id: string,
): void {
  const w = workers.get(id);
  if (!w) { json(res, 404, { error: "Worker not found" }); return; }
  refreshWorker(w);

  let output: string | null = null;
  if (w.status !== "running") {
    try {
      if (existsSync(w.outputPath)) output = readFileSync(w.outputPath, "utf-8").trim() || null;
    } catch { /* ignore */ }
  }

  json(res, 200, {
    id: w.id, status: w.status, pid: w.pid,
    startedAt: w.startedAt, finishedAt: w.finishedAt,
    output: output,
    exitCode: w.status === "completed" ? 0 : w.status === "failed" ? 1 : null,
  });
}

function handleKillWorker(
  res: import("node:http").ServerResponse,
  id: string,
): void {
  const w = workers.get(id);
  if (!w) { json(res, 404, { error: "Worker not found" }); return; }
  if (w.pid && isProcessAlive(w.pid)) killProcess(w.pid);
  w.status = "killed";
  w.finishedAt = new Date().toISOString();
  // Cleanup worktree
  try { execSync(`git worktree remove "${w.worktreePath}" --force`, { stdio: "pipe" }); } catch { /* ok */ }
  json(res, 200, { id: w.id, status: "killed" });
}

function handleHealth(res: import("node:http").ServerResponse): void {
  let running = 0;
  for (const w of workers.values()) { refreshWorker(w); if (w.status === "running") running++; }
  json(res, 200, { ok: true, running, capacity: MAX_AGENTS, total: workers.size });
}

async function handleExec(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
): Promise<void> {
  const body = await parseBody(req);
  const { command, timeout } = body as { command: string; timeout?: number };

  if (!command || typeof command !== "string") {
    json(res, 400, { error: "Missing 'command' field" });
    return;
  }

  const timeoutMs = Math.min(timeout ?? 30_000, 300_000); // max 5 min

  try {
    const output = execSync(command, {
      encoding: "utf-8",
      timeout: timeoutMs,
      stdio: ["pipe", "pipe", "pipe"],
    });
    json(res, 200, { ok: true, output: output.trim() });
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string; message?: string };
    json(res, 200, {
      ok: false,
      exitCode: e.status ?? 1,
      stdout: (e.stdout ?? "").trim(),
      stderr: (e.stderr ?? "").trim(),
      error: e.message ?? String(err),
    });
  }
}

// ─── HTTP Server ─────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  // CORS for browser-based tools
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // Auth check (skip for health)
  const url = req.url || "";
  if (url !== "/health" && !auth(req)) {
    json(res, 401, { error: "Unauthorized" });
    return;
  }

  try {
    if (url === "/health" && req.method === "GET") {
      handleHealth(res);
    } else if (url === "/exec" && req.method === "POST") {
      await handleExec(req, res);
    } else if (url === "/workers" && req.method === "POST") {
      await handleSpawn(req, res);
    } else if (url.startsWith("/workers/") && req.method === "GET") {
      handleGetWorker(res, url.split("/")[2]);
    } else if (url.startsWith("/workers/") && req.method === "DELETE") {
      handleKillWorker(res, url.split("/")[2]);
    } else {
      json(res, 404, { error: "Not found" });
    }
  } catch (err) {
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

const PORT = parseInt(process.env.PORT || "8787", 10);
server.listen(PORT, () => {
  console.log(`Forge Worker API listening on :${PORT}`);
  console.log(`  Max agents: ${MAX_AGENTS}`);
  console.log(`  Auth: ${API_TOKEN ? "enabled" : "disabled (no FORGE_API_TOKEN)"}`);
});
