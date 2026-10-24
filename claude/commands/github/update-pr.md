---
name: Update PR Description
description: Use this skill when the user asks to update, rewrite, or improve a GitHub pull request's title and/or description. This includes requests like "update the PR description", "rewrite the PR title", "fill in the PR template", "improve the PR body", or providing a PR URL/number and asking for description updates. Always use this skill when the user wants to generate or fix PR metadata based on the actual diff.
allowed-tools:
  [
    Bash(gh pr view*),
    Bash(gh pr diff*),
    Bash(find * -path "*pull_request_template*" -o -path "*PULL_REQUEST_TEMPLATE*"),
    Bash(find * -path "*PULL_REQUEST_TEMPLATE*" -o -path "*pull_request_template*"),
    Read,
  ]
---

# Update PR Title & Description

Rewrite a GitHub PR's title and description based on the actual diff, following the repository's PR template.

## Core Principle

Generate the PR title and description from the **diff itself** — not just commit messages. The description should accurately reflect what changed in the code and why.

## Workflow

### 1. Gather PR Information

```bash
# Get current PR metadata (title, body, commits, branch info)
gh pr view <PR_NUMBER_OR_URL> --json title,body,commits,headRefName,baseRefName,files

# Get the full diff (this is the primary source of truth)
gh pr diff <PR_NUMBER_OR_URL>
```

### 2. Find the PR Template

```bash
find . -path "*pull_request_template*" -o -path "*PULL_REQUEST_TEMPLATE*"
```

Read the template file to understand the expected format. If no template exists, use a sensible default structure:

- Summary
- Changes
- Type of Change
- Testing

### 3. Analyze the Diff

Read the diff carefully and categorize changes:

- **What files changed**: Group by area (e.g., API, UI, CI, config, tests)
- **What the changes do**: Summarize the functional impact
- **Why** (inferred from context): What problem is being solved or what feature is being added
- **Security implications**: Note any dependency upgrades that fix CVEs
- **Breaking changes**: Flag anything that could break existing behavior

### 4. Write the Title

- Keep under 72 characters
- Format: `TICKET-ID: Brief imperative description` (if ticket ID is in the branch name)
- Should capture the primary purpose, not list every change
- Use imperative mood ("Add", "Fix", "Migrate", not "Added", "Fixes", "Migrated")

### 5. Write the Description

Follow the repository's PR template format. Fill in all applicable sections with details derived from the diff:

- **Description**: 2-3 sentences explaining the overall purpose and motivation
- **Detailed changes**: Grouped by area/file with bullet points explaining what changed
- **Type of change**: Check the appropriate boxes
- **Checklist**: Mark items that are clearly satisfied based on the diff
- **Additional notes**: Mention anything a reviewer should be aware of (e.g., "no app code changes", "yarn.lock regenerated")

### 6. Update the PR

```bash
# Update title
gh pr edit <PR_NUMBER> --title "NEW TITLE"

# Update body (always use HEREDOC for proper formatting)
gh pr edit <PR_NUMBER> --body "$(cat <<'EOF'
PR body content here...
EOF
)"
```

### 7. Verify

```bash
gh pr view <PR_NUMBER> --json title --jq '.title'
```

## Guidelines

- **Diff over commits**: Commit messages are often terse or auto-generated (e.g., Renovate bot). Always derive the description from the actual code diff.
- **Be specific**: Instead of "updated dependencies", say "upgraded lodash from 4.17.21 to 4.18.1 (fixes CVE-2026-2950: prototype pollution)".
- **Group logically**: If a PR touches multiple areas (e.g., Docker + CI + deps), organize the description by area with clear headings or sub-sections.
- **Infer ticket ID**: Look at the branch name (e.g., `pr/ENG-999973/...`) to extract the Jira ticket reference.
- **Don't invent information**: Only describe what you can observe in the diff. Don't guess at motivations unless they're obvious from context.
- **Preserve existing content**: If the user has already filled in parts of the template (e.g., screenshots), preserve those sections and only update what's empty or clearly wrong.
