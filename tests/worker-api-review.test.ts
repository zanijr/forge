import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer } from "node:http";
import http from "node:http";

// ─── Mocks (must come before worker-api import) ─────────────────

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => ({
    pid: 12345,
    unref: vi.fn(),
  })),
  execSync: vi.fn((cmd: string) => {
    if (cmd.startsWith("which claude") || cmd.startsWith("where claude")) return "claude\n";
    if (cmd.startsWith("git")) return "";
    return "";
  }),
}));

vi.mock("node:fs", () => ({
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(() => '{"result":"[]"}'),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  openSync: vi.fn(() => 3),
}));

vi.mock("../src/execution/platform.js", () => ({
  isProcessAlive: vi.fn(() => true),
  killProcess: vi.fn(),
}));

// ─── Import after mocks ──────────────────────────────────────────

process.env.NODE_ENV = "test";
process.env.FORGE_API_TOKEN = "test-token";
process.env.FORGE_MAX_AGENTS = "2";
process.env.FORGE_DIR = "/tmp/forge-test";

const { server, reviewers, workers } = await import("../src/server/worker-api.js");

// ─── Test Helpers ────────────────────────────────────────────────

function startTestServer(): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
}

function request(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          "Content-Type": "application/json",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload).toString() } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: data });
          }
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function authHeaders(): Record<string, string> {
  return { Authorization: "Bearer test-token" };
}

// ─── Tests ───────────────────────────────────────────────────────

describe("Worker API — /review endpoints", () => {
  let port: number;

  beforeAll(async () => {
    port = await startTestServer();
  });

  afterAll(() => {
    server.close();
  });

  beforeEach(() => {
    reviewers.clear();
    workers.clear();
  });

  // ── POST /review ─────────────────────────────────────────────────

  describe("POST /review", () => {
    it("returns 201 with reviewer IDs for each requested type", async () => {
      const res = await request(port, "POST", "/review", {
        reviewTypes: ["security", "logic"],
        branch: "main",
        repoFullName: "org/repo",
      }, authHeaders());

      expect(res.status).toBe(201);
      const body = res.body as { reviewers: Array<{ id: string; type: string; status: string }> };
      expect(body.reviewers).toHaveLength(2);
      expect(body.reviewers[0].type).toBe("security");
      expect(body.reviewers[1].type).toBe("logic");
      expect(body.reviewers[0].status).toBe("running");
      expect(body.reviewers[0].id).toMatch(/^reviewer-security-/);
      expect(body.reviewers[1].id).toMatch(/^reviewer-logic-/);
    });

    it("stores reviewer records in the reviewers map", async () => {
      const res = await request(port, "POST", "/review", {
        reviewTypes: ["style"],
        branch: "feat/test",
        repoFullName: "org/repo",
      }, authHeaders());

      expect(res.status).toBe(201);
      const body = res.body as { reviewers: Array<{ id: string }> };
      expect(reviewers.size).toBe(1);
      expect(reviewers.has(body.reviewers[0].id)).toBe(true);
    });

    it("returns 400 when reviewTypes is missing or empty", async () => {
      const res1 = await request(port, "POST", "/review", {
        branch: "main",
      }, authHeaders());
      expect(res1.status).toBe(400);

      const res2 = await request(port, "POST", "/review", {
        reviewTypes: [],
        branch: "main",
      }, authHeaders());
      expect(res2.status).toBe(400);
    });

    it("returns 401 when no auth token is provided", async () => {
      const res = await request(port, "POST", "/review", {
        reviewTypes: ["security"],
        branch: "main",
      });
      expect(res.status).toBe(401);
      expect((res.body as { error: string }).error).toBe("Unauthorized");
    });

    it("returns 401 when wrong auth token is provided", async () => {
      const res = await request(port, "POST", "/review", {
        reviewTypes: ["security"],
        branch: "main",
      }, { Authorization: "Bearer wrong-token" });
      expect(res.status).toBe(401);
    });

    it("returns 429 when at capacity", async () => {
      // Fill capacity (MAX_AGENTS=2) with running workers
      const { isProcessAlive } = await import("../src/execution/platform.js");
      vi.mocked(isProcessAlive).mockReturnValue(true);

      // Seed reviewers map directly with running records
      reviewers.set("reviewer-a", {
        id: "reviewer-a", type: "a", pid: 100, status: "running",
        outputPath: "/tmp/a.json", startedAt: new Date().toISOString(),
      });
      reviewers.set("reviewer-b", {
        id: "reviewer-b", type: "b", pid: 101, status: "running",
        outputPath: "/tmp/b.json", startedAt: new Date().toISOString(),
      });

      const res = await request(port, "POST", "/review", {
        reviewTypes: ["security"],
        branch: "main",
      }, authHeaders());

      expect(res.status).toBe(429);
      expect((res.body as { error: string }).error).toBe("At capacity");
    });
  });

  // ── GET /review/:id ───────────────────────────────────────────────

  describe("GET /review/:id", () => {
    it("returns 200 with reviewer status and output for a known ID", async () => {
      const id = "reviewer-security-12345";
      reviewers.set(id, {
        id, type: "security", pid: 999, status: "running",
        outputPath: "/tmp/forge-test/outputs/reviewer-security.json",
        startedAt: "2026-01-01T00:00:00.000Z",
      });

      const res = await request(port, "GET", `/review/${id}`, undefined, authHeaders());

      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body.id).toBe(id);
      expect(body.type).toBe("security");
      expect(body.pid).toBe(999);
      expect(body.startedAt).toBe("2026-01-01T00:00:00.000Z");
    });

    it("shows completed status and output when process has exited", async () => {
      const { isProcessAlive } = await import("../src/execution/platform.js");
      const { existsSync, readFileSync } = await import("node:fs");
      vi.mocked(isProcessAlive).mockReturnValue(false);
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('[{"severity":"high","title":"XSS"}]');

      const id = "reviewer-logic-99999";
      reviewers.set(id, {
        id, type: "logic", pid: 888, status: "running",
        outputPath: "/tmp/forge-test/outputs/reviewer-logic.json",
        startedAt: "2026-01-01T00:00:00.000Z",
      });

      const res = await request(port, "GET", `/review/${id}`, undefined, authHeaders());

      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body.status).toBe("completed");
      expect(body.output).toBeTruthy();
      expect(body.finishedAt).toBeTruthy();
    });

    it("returns 401 when no auth token is provided", async () => {
      const res = await request(port, "GET", "/review/some-id");
      expect(res.status).toBe(401);
    });

    it("returns 404 for an unknown reviewer ID", async () => {
      const res = await request(port, "GET", "/review/nonexistent-id", undefined, authHeaders());
      expect(res.status).toBe(404);
      expect((res.body as { error: string }).error).toBe("Reviewer not found");
    });
  });
});
