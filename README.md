# pi-setup

Pi extensions and prompt templates by [Cornelius Tantius](https://github.com/CorneliusTantius).

Install as a Pi package:

```bash
pi install git:github.com/CorneliusTantius/pi-setup
```

Restart Pi or run `/reload` after installing. Use `pi config` to enable/disable individual extensions.

## Extensions

| Extension | Path | What it does |
|-----------|------|-------------|
| **Swarm** | `extensions/pi-swarm.ts` | `spawn_swarm` tool — runs agents (scout, worker, tester, reviewer) as isolated `pi --mode json` subprocesses. Single or parallel (up to 6) tasks. | |
| **System prompt** | `extensions/pi-sys-prompt.ts` | Overrides the system prompt with YAGNI/KISS/DRY principles + coding discipline. |

## Prompt templates

When enabled, the package provides:

- `/grinding` — full-cycle: clarify → plan-n-breakdown → implement-it → open-pr
- `/implement-it` — implement from `tasks.md` or prompt with test/lint validation
- `/plan-n-breakdown` — analyze requirement, write `plan.md` and `tasks.md`
- `/open-pr` — open a draft PR with conventional commit format

## Selectively enable extensions

In `~/.pi/agent/settings.json`, use the `extensions` filter:

```json
{
  "packages": [
    {
      "source": "git:github.com/CorneliusTantius/pi-setup",
      "extensions": ["extensions/pi-sys-prompt.ts", "extensions/pi-swarm.ts"],
      "prompts": ["prompts/*.md"]
    }
  ]
}
```

## Layout

```text
extensions/
  pi-swarm.ts
  pi-sys-prompt.ts
prompts/
  grinding.md
  implement-it.md
  open-pr.md
  plan-n-breakdown.md
```