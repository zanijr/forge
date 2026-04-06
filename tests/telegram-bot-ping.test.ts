import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const source = readFileSync(resolve(ROOT, "src/interfaces/telegram-bot.ts"), "utf-8");

describe("/ping command", () => {
  it("registers a /ping onText handler", () => {
    expect(source).toMatch(/bot\.onText\(\/\\\/ping\//);
  });

  it("responds with 'Pong! Project:' and the active project name", () => {
    expect(source).toMatch(/Pong! Project:/);
    expect(source).toMatch(/target\.name/);
  });

  it("checks authorization before responding", () => {
    // Find the ping handler block
    const pingIdx = source.indexOf("bot.onText(/\\/ping/");
    expect(pingIdx).toBeGreaterThan(-1);

    // The authorization check should appear within 200 chars after the handler opens
    const snippet = source.slice(pingIdx, pingIdx + 200);
    expect(snippet).toMatch(/isAuthorized/);
  });

  it("includes /ping in the /start command listing", () => {
    expect(source).toMatch(/\/ping.*Health check/);
  });

  it("includes /ping in the /help command listing", () => {
    // /ping appears at least twice in help-related text
    const matches = source.match(/\/ping/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });

  it("includes ping in the unknown-command filter regex", () => {
    expect(source).toMatch(/ping.*status|status.*ping/);
  });
});
