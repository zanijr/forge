#!/bin/bash
# Forge statusline for Claude Code
# Reads .forge/ state from the current working directory

FORGE_DIR=".forge"

if [ ! -f "$FORGE_DIR/plan.json" ]; then
  # No forge state in this directory — show nothing
  exit 0
fi

node -e "
const fs = require('fs');
try {
  const plan = JSON.parse(fs.readFileSync('$FORGE_DIR/plan.json', 'utf-8'));
  const tasks = plan.tasks || [];
  const done = tasks.filter(t => t.status === 'done').length;
  const total = tasks.length;

  // Count running agents
  let agents = 0;
  try {
    const agentFiles = fs.readdirSync('$FORGE_DIR/agents/');
    agents = agentFiles.filter(f => {
      try {
        const a = JSON.parse(fs.readFileSync('$FORGE_DIR/agents/' + f, 'utf-8'));
        return a.status === 'running';
      } catch { return false; }
    }).length;
  } catch {}

  const findings = (plan.review_findings || []).length;
  const status = plan.status || 'unknown';

  let line = '\u2692 Forge \u2502 ' + status + ' \u2502 ' + done + '/' + total + ' tasks';
  if (agents > 0) line += ' \u2502 ' + agents + ' agent' + (agents === 1 ? '' : 's');
  if (findings > 0) line += ' \u2502 ' + findings + ' finding' + (findings === 1 ? '' : 's');
  console.log(line);
} catch (e) {
  console.log('\u2692 Forge \u2502 error');
}
" 2>/dev/null || echo "⚒ Forge │ error"
