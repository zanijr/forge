#!/bin/bash
# Forge Docker entrypoint — fix permissions, set up auth, then run as forge user
set -e

# Fix volume ownership (volumes may have been created by root in older containers)
chown -R forge:forge /repos /app/.forge 2>/dev/null || true

# Set up Claude auth — symlink .claude.json from mounted .claude/ directory
if [ -f /home/forge/.claude/.claude.json ]; then
  ln -sf /home/forge/.claude/.claude.json /home/forge/.claude.json
elif ls /home/forge/.claude/backups/.claude.json.backup.* 1>/dev/null 2>&1; then
  BACKUP=$(ls -t /home/forge/.claude/backups/.claude.json.backup.* | head -1)
  cp "$BACKUP" /home/forge/.claude.json
  chown forge:forge /home/forge/.claude.json
fi

# Ensure credentials are readable by forge user
chmod a+r /home/forge/.claude/.credentials.json 2>/dev/null || true
chmod a+r /home/forge/.claude.json 2>/dev/null || true

# Drop to forge user and exec the actual command
exec gosu forge "$@"
