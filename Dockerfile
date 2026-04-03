FROM node:20-slim

# Install system dependencies + VPN + SMB
RUN apt-get update && apt-get install -y --no-install-recommends \
    git tmux curl ca-certificates gnupg openssh-client \
    strongswan xl2tpd ppp cifs-utils sshfs lftp \
    && rm -rf /var/lib/apt/lists/*

# Install gh CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code
RUN npm install -g @anthropic-ai/claude-code

# Create app directory
WORKDIR /app

# Copy package files and install production deps
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copy compiled dist
COPY dist/ ./dist/

# Create directories for state and repos
RUN mkdir -p /repos /app/.forge/agents /app/.forge/outputs /app/.forge/prompts /app/.forge/worktrees

# Git config for worktree operations
RUN git config --global user.name "Forge Worker" \
    && git config --global user.email "forge@bozits.com" \
    && git config --global init.defaultBranch main

EXPOSE 8787

CMD ["node", "dist/server/worker-api.js"]
