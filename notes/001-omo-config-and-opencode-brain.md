# Session 001: OMO Agent Config + opencode-brain Plugin

Date: 2026-02-17

## What was done

### 1. OMO Agent/Model Configuration

Configured `oh-my-opencode.json` to map all OMO agents and categories to the user's available models, avoiding Anthropic defaults.

**Agent -> Model mapping:**

| Agent | Model |
|-------|-------|
| sisyphus, oracle, prometheus | opencode/big-pickle |
| explore, fixer, atlas | opencode/kimi-k2.5-free |
| librarian, hephaestus, momus | opencode/minimax-m2.5-free |
| designer, metis | google/antigravity-gemini-3-pro |
| multimodal-looker | google/antigravity-gemini-3-flash |

**Category -> Model mapping:**

| Category | Model |
|----------|-------|
| visual-engineering, artistry | google/antigravity-gemini-3-pro |
| ultrabrain, deep, unspecified-low | opencode/minimax-m2.5-free |
| quick | opencode/kimi-k2.5-free |
| unspecified-high | opencode/big-pickle |
| writing | google/antigravity-gemini-3-flash |

### 2. Critical Bug Fix: `skills` Schema Validation

**Bug:** Oracle agent had `"skills": "*"` (string) instead of `"skills": ["*"]` (array).

**Impact:** The Zod schema (`AgentOverrideConfigSchema`) expects `skills` to be `array(string())`. This caused the entire `agents` block validation to fail silently, making `parseConfigPartially` skip all agent overrides and fall back to hardcoded `AGENT_MODEL_REQUIREMENTS` defaults (Anthropic claude-opus-4-6).

**Fix:** Changed to `"skills": ["*"]` in both `.json` and `.jsonc`.

**Discovery method:** Traced through OMO plugin source at `~/.cache/opencode/node_modules/oh-my-opencode/dist/index.js` — key functions: `detectConfigFile()` (line 16409), `AgentOverrideConfigSchema` (line 70035), `parseConfigPartially` (line ~70388).

### 3. opencode-brain Plugin Installation

Installed from local clone at `~/git/opencode-brain`.

**Bug found during install:** `npm install /path/to/repo` creates a `file:` URI reference in `package.json`, which opencode's plugin version resolver rejects with `Error: Invalid SemVer: file:../../git/opencode-brain`.

**Workaround:** After `npm install`, manually edited `~/.cache/opencode/package.json` to replace `file:` URI with `"1.1.0"`.

### 4. opencode-brain Export Fix

**Bug:** Plugin failed to load with `TypeError: fn3 is not a function. (In 'fn3(input)', 'fn3' is an instance of Object)` at `src/plugin/index.ts:90:28` in opencode core.

**Root cause:** opencode-brain's `src/index.ts` exported the default plugin function alongside 12+ named exports. The working OMO plugin exports ONLY `{ default }`. Opencode's Bun-based plugin loader couldn't resolve the default export from a module with mixed named+default exports.

**Working pattern (OMO):**
```js
export { src_default as default };
```

**Broken pattern (opencode-brain before fix):**
```js
export { DEFAULT_CONFIG, Mind, OpenCodeBrain, ..., plugin_default as default, ... };
```

**Fix:** Changed `src/index.ts` to only re-export default:
```ts
export { default } from "./plugin.js"
```

Committed as `e8e2ba5` in `~/git/opencode-brain`: `fix: export only default for opencode plugin loader compatibility`

## Files modified

- `~/.config/opencode/oh-my-opencode.json` — OMO agent/category config + skills fix
- `~/.config/opencode/oh-my-opencode.jsonc` — Same (JSONC copy)
- `~/.config/opencode/opencode.jsonc` — Added `opencode-brain@1.1.0` to plugin list
- `~/.cache/opencode/package.json` — Fixed version reference
- `~/git/opencode-brain/src/index.ts` — Export fix

## Pending

- Verify OMO config loads correctly after opencode restart (agents should show configured models, not Anthropic defaults)
- Verify opencode-brain plugin loads without errors
- z.ai model configuration (deferred — models available: `zai-coding-plan/glm-4.7`, `zai-coding-plan/glm-4.7-flash`)
- LM Studio local model provider (deferred — LM Studio not running)
