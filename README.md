# openception

Claudeception for OpenCode — self-improving AI agent configuration with automatic skill extraction.

## Quick Install

```bash
git clone https://github.com/bhodgens/openception.git ~/git/openception
cd ~/git/openception
./install.sh
```

Restart opencode after install.

## What this does

1. **opencode-brain plugin** (patched) — persistent memory across sessions via `.claude/mind.mv2`
2. **Automatic skill detection** — at session end, analyzes observations for skill-worthy patterns (problem→solution pairs, error→fix sequences, deep investigations)
3. **Skill extraction prompt** — on next session start, injects detected candidates into the system prompt so the agent extracts them as reusable SKILL.md files
4. **OMO agent configs** — model mappings for all OMO agents/categories

## Structure

```
plugin/           # Patched opencode-brain plugin source (build + install via install.sh)
configs/          # Snapshots of working OMO configs
notes/            # Session notes documenting changes, bugs, and fixes
install.sh        # One-command installer
```

## Patches over upstream opencode-brain

- **Export fix**: Entry point exports only `default` — required for opencode's Bun plugin loader
- **Skill detection**: New `src/hooks/skill-detector.ts` analyzes session observations for extractable knowledge
- **Skill staging**: New `src/utils/skill-staging.ts` persists candidates to `.claude/mind-skills-pending.json`
- **Auto-injection**: Modified `src/plugin.ts` injects pending candidates into system prompt on next session start
