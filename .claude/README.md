# `.claude/` — Claude Code project configuration

Project-level configuration consumed by [Claude Code](https://claude.com/claude-code) when working in this repo.

## Layout

```
.claude/
  settings.json          # checked-in project settings (permissions, hooks)
  settings.local.json    # gitignored — per-user overrides
  README.md              # this file
  skills/                # project-specific skills (slash commands)
    <skill-name>/
      SKILL.md           # frontmatter + instructions
      ...                # optional helper scripts/templates
```

## settings.json

Project-wide defaults committed to the repo. Currently scopes:

- **`permissions.allow`** — pre-approved tool calls so Claude doesn't prompt for every familiar dev command (pnpm, forge, anchor, cargo, git read commands, bash wrappers under `sh/`).
- **`permissions.deny`** — explicit blocks on destructive commands (`rm -rf`, force pushes, hard resets). Override per-task only if you mean it.

For per-user settings (different defaults, machine-specific env), create `.claude/settings.local.json` — already gitignored by convention. Both files merge; `local` wins on conflicts.

## skills/

Project-scoped skills extend Claude with task recipes specific to this repo. Each skill is a directory containing a `SKILL.md`:

```
skills/
  <skill-name>/
    SKILL.md           # frontmatter + instructions for Claude
```

`SKILL.md` frontmatter shape:

```markdown
---
name: skill-name
description: When + how to use this skill
---

# Instructions for Claude when this skill is invoked
```

Claude auto-discovers skills here when the working directory is this repo. Invoke a skill via `/<skill-name>` in the Claude Code prompt, or rely on the model to use it when the description matches the task.

## Related docs

- [migrations/README.md](../migrations/README.md) — migration model, runner, conventions
- [CLAUDE.md](../CLAUDE.md) — repo-level project context loaded automatically on session start
