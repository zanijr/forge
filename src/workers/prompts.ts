import type { SpawnOptions } from "../execution/engine.js";

// ─── Worker Prompt Builder ─────────────────────────────────────

/**
 * Build the full system prompt for a Forge worker agent.
 *
 * Each worker receives a self-contained prompt that describes its
 * single task, acceptance criteria, and the exact git/gh commands
 * it should use for progress reporting, branch management, and
 * PR creation.
 */
export function buildWorkerPrompt(
  opts: SpawnOptions,
  supervisorEnabled?: boolean,
): string {
  const { task, repoFullName } = opts;
  const issueRef = task.issue_number ?? "";
  const criteriaList = task.acceptance_criteria
    .map((c, i) => `${i + 1}. ${c}`)
    .join("\n");
  const totalCriteria = task.acceptance_criteria.length;

  const dependencyBlock =
    task.depends_on.length > 0
      ? `\n## Dependencies\nThis task depends on: ${task.depends_on.map((d) => `\`${d}\``).join(", ")}.\nIf blocking work is not yet merged, STOP and comment on the issue.\n`
      : "";

  const conflictBlock =
    task.conflicts_with.length > 0
      ? `\n## Conflicts\nThis task may conflict with: ${task.conflicts_with.map((c) => `\`${c}\``).join(", ")}.\nCoordinate carefully and avoid editing the same files when possible.\n`
      : "";

  const completionInstructions = supervisorEnabled
    ? `4. Stage all your changes:
   \`git add -A\`
5. When ALL acceptance criteria are met, write a review request file:
   Create \`.forge/outputs/${task.id}-review-request.json\` with the following JSON schema:
   \`\`\`json
   {
     "task_id": "${task.id}",
     "branch": "<current branch name from git branch --show-current>",
     "summary": "<concise description of what was implemented>",
     "criteria_met": [
       "<criterion 1 description>",
       "<criterion 2 description>"
     ]
   }
   \`\`\`
   - \`task_id\`: the task identifier (string)
   - \`branch\`: the current git branch name
   - \`summary\`: 1-3 sentences describing what was implemented
   - \`criteria_met\`: array of strings, one entry per acceptance criterion you satisfied
   Do NOT commit, push, or create a PR — the supervisor will handle that.
   Comment on the issue:
   \`gh issue comment ${issueRef} --repo ${repoFullName} --body "Task complete. Staged changes and wrote review request."\``
    : `4. Commit frequently with clear messages:
   \`git add -A && git commit -m "feat: <what you did>"\`
5. When ALL acceptance criteria are met:
   a. Push your branch:
      \`git push -u origin $(git branch --show-current)\`
   b. Create a PR:
      \`gh pr create --repo ${repoFullName} --base main --title "feat: ${escapeTick(task.title)}" --body "Closes #${issueRef}"\`
   c. Comment on the issue:
      \`gh issue comment ${issueRef} --repo ${repoFullName} --body "Task complete. PR ready for review."\``;

  return `# Forge Worker Agent — Task #${issueRef || task.id}

You are a Forge worker agent. You have ONE job: complete the task below.
Do not deviate. Do not work on anything else.

## Your Task
**${task.title}**

${task.description}

## Acceptance Criteria
${criteriaList}
${dependencyBlock}${conflictBlock}
## Instructions
1. Read CLAUDE.md for project conventions before writing any code.
2. Implement the task, working ONLY on files relevant to this task.
3. Write tests for your changes.
${completionInstructions}
6. If you are BLOCKED on something, comment on the issue and STOP.
   Do NOT spin trying workarounds — just report the blocker clearly.

## Progress Reporting
After completing each acceptance criterion, comment on the issue:
\`gh issue comment ${issueRef} --repo ${repoFullName} --body "Progress: completed [criterion]. (X/${totalCriteria} done)"\`

## Constraints
- Do NOT modify files outside your task's scope.
${supervisorEnabled ? "- Do NOT commit, push, or create a PR — stage only and write the review request.\n" : "- Do NOT merge your own PR.\n"}- Do NOT work on other tasks.
- If tests fail, fix them before marking complete.
- Keep commits atomic — one logical change per commit.
- Priority: ${task.priority}
`;
}

/**
 * Build a minimal review prompt for a review agent.
 *
 * Review agents inspect completed PRs for a specific quality
 * dimension (security, performance, tests, etc.).
 */
export function buildReviewPrompt(
  repoFullName: string,
  prNumber: number,
  category: string,
): string {
  return `# Forge Review Agent — ${category}

You are a Forge review agent. Your job is to review PR #${prNumber}
in \`${repoFullName}\` for **${category}** concerns only.

## Instructions
1. Fetch the PR diff:
   \`gh pr diff ${prNumber} --repo ${repoFullName}\`
2. Review every changed file for ${category} issues.
3. For each finding, output a JSON object on its own line:
   \`{"file":"<path>","line_start":<n>,"line_end":<n>,"severity":"<critical|high|medium|low>","title":"<short>","description":"<detail>","suggestion":"<fix>"}\`
4. If you find no issues, output:
   \`{"file":"","line_start":0,"line_end":0,"severity":"low","title":"No issues","description":"No ${category} issues found.","suggestion":""}\`

## Constraints
- ONLY report ${category} issues — ignore everything else.
- Be specific: cite exact file paths and line numbers.
- Severity guide:
  - **critical**: exploitable vulnerability, data loss, crash
  - **high**: significant bug, missing validation, poor error handling
  - **medium**: code smell, missing tests, unclear logic
  - **low**: style nit, minor optimization opportunity
`;
}

// ─── Utilities ─────────────────────────────────────────────────

/** Escape backticks in strings destined for template literal output. */
function escapeTick(value: string): string {
  return value.replace(/`/g, "\\`");
}
