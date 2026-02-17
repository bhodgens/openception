import { existsSync, statSync, renameSync, unlinkSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { readFile, writeFile, mkdir, open } from 'fs/promises';
import { randomBytes, createHash } from 'crypto';
import lockfile from 'proper-lockfile';
import { tool } from '@opencode-ai/plugin';

// src/plugin.ts

// src/types.ts
var DEFAULT_CONFIG = {
  memoryPath: ".claude/mind.mv2",
  maxContextObservations: 20,
  maxContextTokens: 2e3,
  autoCompress: true,
  minConfidence: 0.6,
  debug: false
};
function generateId() {
  return randomBytes(8).toString("hex");
}
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}
function formatTimestamp(ts) {
  if (!ts || ts <= 0) return "unknown";
  const normalized = ts > 0 && ts < 4102444800 ? ts * 1e3 : ts;
  const now = Date.now();
  const diff = now - normalized;
  if (diff < 6e4) return "just now";
  if (diff < 36e5) return `${Math.floor(diff / 6e4)}m ago`;
  if (diff < 864e5) return `${Math.floor(diff / 36e5)}h ago`;
  if (diff < 6048e5) return `${Math.floor(diff / 864e5)}d ago`;
  return new Date(normalized).toLocaleDateString();
}
function classifyObservationType(toolName, output) {
  const lower = output.toLowerCase();
  if (lower.includes("error") || lower.includes("failed") || lower.includes("exception")) {
    return "problem";
  }
  if (lower.includes("success") || lower.includes("passed") || lower.includes("completed")) {
    return "success";
  }
  if (lower.includes("warning") || lower.includes("deprecated")) {
    return "warning";
  }
  const tool2 = toolName.toLowerCase();
  if (tool2 === "read" || tool2 === "glob" || tool2 === "grep") {
    return "discovery";
  }
  if (tool2 === "edit" || tool2 === "update") {
    if (lower.includes("fix") || lower.includes("bug")) {
      return "bugfix";
    }
    return "refactor";
  }
  if (tool2 === "write") {
    return "feature";
  }
  return "discovery";
}
function normalizeTimestamp(ts) {
  if (ts > 0 && ts < 4102444800) {
    return ts * 1e3;
  }
  return ts;
}
function debug(message) {
  if (process.env.OPENCODE_BRAIN_DEBUG === "1") {
    console.error(`[opencode-brain] ${message}`);
  }
}
var LOCK_OPTIONS = {
  stale: 3e4,
  retries: {
    retries: 1e3,
    minTimeout: 5,
    maxTimeout: 50
  }
};
async function withMindLock(memoryPath, fn) {
  const lockPath = `${memoryPath}.lock`;
  await mkdir(dirname(lockPath), { recursive: true });
  const handle = await open(lockPath, "a");
  await handle.close();
  const release = await lockfile.lock(lockPath, LOCK_OPTIONS);
  try {
    return await fn();
  } finally {
    await release();
  }
}

// src/core/mind.ts
var sdkLoaded = false;
var use;
var create;
async function loadSDK() {
  if (sdkLoaded) return;
  const sdk = await import('@memvid/sdk');
  use = sdk.use;
  create = sdk.create;
  sdkLoaded = true;
}
var CORRUPTION_PATTERNS = [
  "Deserialization",
  "UnexpectedVariant",
  "Invalid",
  "corrupt",
  "validation failed",
  "unable to recover",
  "table of contents",
  "version mismatch"
];
var MAX_FILE_SIZE_MB = 100;
function pruneBackups(memoryPath, keepCount) {
  try {
    const dir = dirname(memoryPath);
    const baseName = memoryPath.split("/").pop() || "mind.mv2";
    const backupPattern = new RegExp(`^${baseName.replace(".", "\\.")}\\.backup-\\d+$`);
    const files = readdirSync(dir);
    const backups = files.filter((f) => backupPattern.test(f)).map((f) => ({
      name: f,
      path: resolve(dir, f),
      time: parseInt(f.split("-").pop() || "0", 10)
    })).sort((a, b) => b.time - a.time);
    for (let i = keepCount; i < backups.length; i++) {
      try {
        unlinkSync(backups[i].path);
        debug(`Pruned old backup: ${backups[i].name}`);
      } catch {
      }
    }
  } catch {
  }
}
var Mind = class _Mind {
  memvid;
  config;
  sessionId;
  directory;
  initialized = false;
  sessionStartTime;
  constructor(memvid, config, directory) {
    this.memvid = memvid;
    this.config = config;
    this.directory = directory;
    this.sessionId = generateId();
    this.sessionStartTime = Date.now();
  }
  /**
   * Open or create a Mind instance
   */
  static async open(directory, configOverrides = {}) {
    await loadSDK();
    const config = { ...DEFAULT_CONFIG, ...configOverrides };
    const memoryPath = resolve(directory, config.memoryPath);
    const memoryDir = dirname(memoryPath);
    await mkdir(memoryDir, { recursive: true });
    let memvid;
    await withMindLock(memoryPath, async () => {
      if (!existsSync(memoryPath)) {
        debug(`Creating new memory file: ${memoryPath}`);
        memvid = await create(memoryPath, "basic");
        return;
      }
      const fileSize = statSync(memoryPath).size;
      const fileSizeMB = fileSize / (1024 * 1024);
      if (fileSizeMB > MAX_FILE_SIZE_MB) {
        debug(`Memory file too large (${fileSizeMB.toFixed(1)}MB), creating fresh memory`);
        const backupPath = `${memoryPath}.backup-${Date.now()}`;
        try {
          renameSync(memoryPath, backupPath);
        } catch {
        }
        memvid = await create(memoryPath, "basic");
        return;
      }
      try {
        memvid = await use("basic", memoryPath);
        debug(`Opened existing memory: ${memoryPath}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (CORRUPTION_PATTERNS.some((p) => msg.includes(p))) {
          debug(`Memory file corrupted, creating fresh memory`);
          const backupPath = `${memoryPath}.backup-${Date.now()}`;
          try {
            renameSync(memoryPath, backupPath);
          } catch {
            try {
              unlinkSync(memoryPath);
            } catch {
            }
          }
          memvid = await create(memoryPath, "basic");
          return;
        }
        throw err;
      }
    });
    const mind = new _Mind(memvid, config, directory);
    mind.initialized = true;
    pruneBackups(memoryPath, 3);
    return mind;
  }
  /**
   * Execute with lock
   */
  async withLock(fn) {
    const memoryPath = resolve(this.directory, this.config.memoryPath);
    return withMindLock(memoryPath, fn);
  }
  /**
   * Set session ID (for external session tracking)
   */
  setSessionId(sessionId) {
    this.sessionId = sessionId;
  }
  /**
   * Remember an observation
   * 
   * IMPORTANT: Re-opens memvid inside the lock to prevent stale SDK state
   * when multiple processes write concurrently.
   */
  async remember(input) {
    const effectiveSessionId = input.metadata?.sessionId || this.sessionId;
    const VALID_SOURCES = ["opencode", "claude-code"];
    const rawSource = input.metadata?.source;
    const effectiveSource = rawSource && VALID_SOURCES.includes(rawSource) ? rawSource : "opencode";
    const observation = {
      id: generateId(),
      timestamp: Date.now(),
      type: input.type,
      tool: input.tool,
      summary: input.summary,
      content: input.content,
      metadata: {
        ...input.metadata,
        sessionId: effectiveSessionId,
        source: effectiveSource
      }
    };
    const frameId = await this.withLock(async () => {
      await loadSDK();
      const memoryPath = this.getMemoryPath();
      const freshMemvid = await use("basic", memoryPath);
      return freshMemvid.put({
        title: `[${observation.type}] ${observation.summary}`,
        label: observation.type,
        text: observation.content,
        metadata: {
          observationId: observation.id,
          timestamp: observation.timestamp,
          tool: observation.tool,
          sessionId: effectiveSessionId,
          source: effectiveSource,
          ...observation.metadata
        },
        tags: [observation.type, observation.tool].filter(Boolean)
      });
    });
    debug(`Remembered: ${observation.summary}`);
    return frameId;
  }
  /**
   * Search memories by query
   */
  async search(query, limit = 10) {
    return this.withLock(async () => {
      return this.searchUnlocked(query, limit);
    });
  }
  async searchUnlocked(query, limit) {
    const results = await this.memvid.find(query, { k: limit, mode: "lex" });
    return (results.frames || []).map((frame) => ({
      observation: {
        id: frame.metadata?.observationId || frame.frame_id,
        timestamp: normalizeTimestamp(frame.metadata?.timestamp || 0),
        type: frame.label,
        tool: frame.metadata?.tool,
        summary: frame.title?.replace(/^\[.*?\]\s*/, "") || "",
        content: frame.text || "",
        metadata: frame.metadata
      },
      score: frame.score || 0,
      snippet: frame.snippet || frame.text?.slice(0, 200) || ""
    }));
  }
  /**
   * Ask the memory a question
   */
  async ask(question) {
    return this.withLock(async () => {
      const result = await this.memvid.ask(question, { k: 5, mode: "lex" });
      return result.answer || "No relevant memories found.";
    });
  }
  /**
   * Get context for session
   */
  async getContext(query) {
    return this.withLock(async () => {
      const timeline = await this.memvid.timeline({
        limit: this.config.maxContextObservations,
        reverse: true
      });
      const frames = Array.isArray(timeline) ? timeline : timeline.frames || [];
      const recentObservations = frames.map((frame) => {
        const ts = normalizeTimestamp(frame.metadata?.timestamp || frame.timestamp || 0);
        return {
          id: frame.metadata?.observationId || frame.frame_id,
          timestamp: ts,
          type: frame.label || frame.metadata?.type || "observation",
          tool: frame.metadata?.tool,
          summary: frame.title?.replace(/^\[.*?\]\s*/, "") || frame.preview?.slice(0, 100) || "",
          content: frame.text || frame.preview || "",
          metadata: frame.metadata
        };
      });
      let relevantMemories = [];
      if (query) {
        const searchResults = await this.searchUnlocked(query, 10);
        relevantMemories = searchResults.map((r) => r.observation);
      }
      let tokenCount = 0;
      for (const obs of recentObservations) {
        const text = `[${obs.type}] ${obs.summary}`;
        const tokens = estimateTokens(text);
        if (tokenCount + tokens > this.config.maxContextTokens) break;
        tokenCount += tokens;
      }
      return {
        recentObservations,
        relevantMemories,
        sessionSummaries: [],
        tokenCount
      };
    });
  }
  /**
   * Save a session summary
   * 
   * IMPORTANT: Re-opens memvid inside the lock to prevent stale SDK state.
   */
  async saveSessionSummary(summary) {
    const context = await this.getContext();
    const sessionObs = context.recentObservations.filter(
      (obs) => obs.metadata?.sessionId === this.sessionId
    );
    const sessionSummary = {
      id: this.sessionId,
      startTime: this.sessionStartTime,
      endTime: Date.now(),
      observationCount: sessionObs.length,
      keyDecisions: summary.keyDecisions,
      filesModified: summary.filesModified,
      summary: summary.summary
    };
    return this.withLock(async () => {
      await loadSDK();
      const memoryPath = this.getMemoryPath();
      const freshMemvid = await use("basic", memoryPath);
      return freshMemvid.put({
        title: `Session Summary: ${(/* @__PURE__ */ new Date()).toISOString().split("T")[0]}`,
        label: "session",
        text: JSON.stringify(sessionSummary, null, 2),
        metadata: {
          ...sessionSummary,
          source: "opencode"
        },
        tags: ["session", "summary"]
      });
    });
  }
  /**
   * Get memory statistics
   */
  async stats() {
    return this.withLock(async () => {
      const stats = await this.memvid.stats();
      const allTimeline = await this.memvid.timeline({ limit: 1e3, reverse: true });
      const allFrames = Array.isArray(allTimeline) ? allTimeline : allTimeline.frames || [];
      const timeline = await this.memvid.timeline({ limit: 1, reverse: false });
      const recentTimeline = await this.memvid.timeline({ limit: 1, reverse: true });
      const oldestFrames = Array.isArray(timeline) ? timeline : timeline.frames || [];
      const newestFrames = Array.isArray(recentTimeline) ? recentTimeline : recentTimeline.frames || [];
      const oldest = oldestFrames[0];
      const newest = newestFrames[0];
      let totalSessions = 0;
      const topTypes = {};
      const validTypes = /* @__PURE__ */ new Set([
        "discovery",
        "decision",
        "problem",
        "solution",
        "pattern",
        "warning",
        "success",
        "refactor",
        "bugfix",
        "feature"
      ]);
      for (const frame of allFrames) {
        const label = frame.label;
        if (label === "session") {
          totalSessions++;
          continue;
        }
        if (label && validTypes.has(label)) {
          const type = label;
          topTypes[type] = (topTypes[type] || 0) + 1;
        }
      }
      return {
        totalObservations: stats.frame_count || 0,
        totalSessions,
        oldestMemory: normalizeTimestamp(oldest?.metadata?.timestamp || oldest?.timestamp || 0),
        newestMemory: normalizeTimestamp(newest?.metadata?.timestamp || newest?.timestamp || 0),
        fileSize: stats.size_bytes || 0,
        topTypes
      };
    });
  }
  getSessionId() {
    return this.sessionId;
  }
  getMemoryPath() {
    return resolve(this.directory, this.config.memoryPath);
  }
  getConfig() {
    return this.config;
  }
  isInitialized() {
    return this.initialized;
  }
};
var mindInstance = null;
async function getMind(directory, config) {
  if (!mindInstance) {
    mindInstance = await Mind.open(directory, config);
  }
  return mindInstance;
}
function resetMind() {
  mindInstance = null;
}

// src/utils/compression.ts
var TARGET_COMPRESSED_SIZE = 2e3;
var COMPRESSION_THRESHOLD = 3e3;
function compressToolOutput(toolName, toolInput, output, autoCompress = true) {
  const originalSize = output.length;
  if (!autoCompress || originalSize < COMPRESSION_THRESHOLD) {
    return { compressed: output, wasCompressed: false, originalSize };
  }
  let compressed;
  const tool2 = toolName.toLowerCase();
  switch (tool2) {
    case "read":
      compressed = compressFileRead(toolInput, output);
      break;
    case "bash":
      compressed = compressBashOutput(toolInput, output);
      break;
    case "grep":
      compressed = compressGrepOutput(toolInput, output);
      break;
    case "glob":
      compressed = compressGlobOutput(toolInput, output);
      break;
    case "edit":
    case "write":
    case "update":
      compressed = compressEditOutput(toolInput, output);
      break;
    default:
      compressed = compressGeneric(output);
  }
  return {
    compressed: truncateToTarget(compressed),
    wasCompressed: true,
    originalSize
  };
}
function compressFileRead(toolInput, output) {
  const lines = output.split("\n");
  const parts = [];
  const filePath = toolInput?.file_path || toolInput?.filePath;
  if (filePath) {
    parts.push(`File: ${filePath}`);
  }
  const imports = extractImports(output);
  if (imports.length > 0) {
    parts.push(`
Imports:
${imports.slice(0, 10).join("\n")}`);
  }
  const exports$1 = extractExports(output);
  if (exports$1.length > 0) {
    parts.push(`
Exports:
${exports$1.slice(0, 10).join("\n")}`);
  }
  const functions = extractFunctionSignatures(output);
  if (functions.length > 0) {
    parts.push(`
Functions:
${functions.slice(0, 15).join("\n")}`);
  }
  const classes = extractClassNames(output);
  if (classes.length > 0) {
    parts.push(`
Classes: ${classes.join(", ")}`);
  }
  const errors = extractErrorPatterns(output);
  if (errors.length > 0) {
    parts.push(`
Notes:
${errors.slice(0, 5).join("\n")}`);
  }
  if (lines.length > 15) {
    parts.push(`
First 10 lines:
${lines.slice(0, 10).join("\n")}`);
    parts.push(`
Last 5 lines:
${lines.slice(-5).join("\n")}`);
  }
  return parts.join("\n");
}
function compressBashOutput(toolInput, output) {
  const lines = output.split("\n");
  const parts = [];
  const command = toolInput?.command;
  if (command) {
    parts.push(`Command: ${command.split("\n")[0].slice(0, 100)}`);
  }
  const errorLines = lines.filter(
    (l) => /error|failed|exception|warning/i.test(l)
  );
  if (errorLines.length > 0) {
    parts.push(`
Errors/Warnings:
${errorLines.slice(0, 10).join("\n")}`);
  }
  const successLines = lines.filter(
    (l) => /success|passed|completed|done/i.test(l)
  );
  if (successLines.length > 0) {
    parts.push(`
Success:
${successLines.slice(0, 5).join("\n")}`);
  }
  if (lines.length > 20) {
    parts.push(`
Output (${lines.length} lines):`);
    parts.push(lines.slice(0, 10).join("\n"));
    parts.push("...");
    parts.push(lines.slice(-5).join("\n"));
  } else {
    parts.push(`
Output:
${output}`);
  }
  return parts.join("\n");
}
function compressGrepOutput(toolInput, output) {
  const lines = output.split("\n").filter(Boolean);
  const parts = [];
  const pattern = toolInput?.pattern;
  if (pattern) {
    parts.push(`Pattern: ${pattern}`);
  }
  const files = new Set(lines.map((l) => l.split(":")[0]).filter(Boolean));
  parts.push(`Found ${lines.length} matches in ${files.size} files`);
  parts.push(`
Top matches:
${lines.slice(0, 10).join("\n")}`);
  if (lines.length > 10) {
    parts.push(`
... and ${lines.length - 10} more matches`);
  }
  return parts.join("\n");
}
function compressGlobOutput(toolInput, output) {
  const lines = output.split("\n").filter(Boolean);
  const parts = [];
  const pattern = toolInput?.pattern;
  if (pattern) {
    parts.push(`Pattern: ${pattern}`);
  }
  parts.push(`Found ${lines.length} files`);
  const dirs = {};
  for (const line of lines) {
    const dir = line.split("/").slice(0, -1).join("/") || ".";
    if (!dirs[dir]) dirs[dir] = [];
    dirs[dir].push(line.split("/").pop() || line);
  }
  const sortedDirs = Object.entries(dirs).sort((a, b) => b[1].length - a[1].length).slice(0, 5);
  for (const [dir, files] of sortedDirs) {
    parts.push(`
${dir}/ (${files.length} files)`);
    parts.push(files.slice(0, 5).map((f) => `  ${f}`).join("\n"));
    if (files.length > 5) {
      parts.push(`  ... and ${files.length - 5} more`);
    }
  }
  return parts.join("\n");
}
function compressEditOutput(toolInput, output) {
  const filePath = toolInput?.file_path || toolInput?.filePath;
  const fileName = filePath?.split("/").pop() || "file";
  return `File: ${fileName}
Path: ${filePath || "unknown"}
Changes applied.

${output.slice(0, 500)}`;
}
function compressGeneric(output) {
  const lines = output.split("\n");
  if (lines.length <= 30) {
    return output;
  }
  return [
    ...lines.slice(0, 15),
    `
... (${lines.length - 25} lines omitted) ...
`,
    ...lines.slice(-10)
  ].join("\n");
}
function extractImports(code) {
  const patterns = [
    /^import\s+.+$/gm,
    /^const\s+\w+\s*=\s*require\(.+\)$/gm,
    /^use\s+.+;$/gm
  ];
  const imports = [];
  for (const pattern of patterns) {
    const matches = code.match(pattern) || [];
    imports.push(...matches);
  }
  return imports;
}
function extractExports(code) {
  const patterns = [
    /^export\s+(default\s+)?(function|class|const|let|var|interface|type)\s+\w+/gm,
    /^pub\s+(fn|struct|enum|trait)\s+\w+/gm,
    /^module\.exports\s*=/gm
  ];
  const exports$1 = [];
  for (const pattern of patterns) {
    const matches = code.match(pattern) || [];
    exports$1.push(...matches);
  }
  return exports$1;
}
function extractFunctionSignatures(code) {
  const patterns = [
    /^(export\s+)?(async\s+)?function\s+\w+\s*\([^)]*\)/gm,
    /^\s*(public|private|protected)?\s*(async\s+)?\w+\s*\([^)]*\)\s*[:{]/gm,
    /^(pub\s+)?fn\s+\w+\s*[<(]/gm,
    /^def\s+\w+\s*\(/gm
  ];
  const functions = [];
  for (const pattern of patterns) {
    const matches = code.match(pattern) || [];
    functions.push(...matches.map((m) => m.trim()));
  }
  return [...new Set(functions)];
}
function extractClassNames(code) {
  const pattern = /^(export\s+)?(abstract\s+)?class\s+(\w+)/gm;
  const classes = [];
  let match;
  while ((match = pattern.exec(code)) !== null) {
    classes.push(match[3]);
  }
  return classes;
}
function extractErrorPatterns(code) {
  const pattern = /^.*\b(TODO|FIXME|HACK|XXX|BUG|NOTE)\b.*$/gm;
  const matches = code.match(pattern) || [];
  return matches.map((m) => m.trim());
}
function truncateToTarget(text) {
  if (text.length <= TARGET_COMPRESSED_SIZE) return text;
  return text.slice(0, TARGET_COMPRESSED_SIZE) + "\n... (truncated)";
}
var DEDUP_WINDOW_MS = 6e4;
function getDedupPath(directory) {
  return `${directory}/.claude/mind-dedup.log`;
}
async function isDuplicateAcrossProcesses(directory, source, toolName, toolInput) {
  const hash = createHash("md5").update(`${source}:${toolName}:${JSON.stringify(toolInput).slice(0, 200)}`).digest("hex");
  const dedupPath = getDedupPath(directory);
  const lockPath = `${dedupPath}.lock`;
  await mkdir(dirname(dedupPath), { recursive: true });
  return withMindLock(lockPath, async () => {
    const content = await readFile(dedupPath, "utf8").catch(() => "");
    const now = Date.now();
    const entries = content.trim().split("\n").filter(Boolean).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter((e) => e !== null && now - e.timestamp < DEDUP_WINDOW_MS);
    if (entries.some((e) => e.hash === hash)) {
      return true;
    }
    entries.push({ timestamp: now, hash, source });
    await writeFile(
      dedupPath,
      entries.map((e) => JSON.stringify(e)).join("\n")
    );
    return false;
  });
}
function getSessionPath(directory, source) {
  return `${directory}/.claude/mind-session-${source}.json`;
}
function detectSource() {
  if (process.env.OPENCODE_SESSION_ID) return "opencode";
  if (process.env.OPENCODE_DIR) return "opencode";
  if (process.env.CLAUDE_PROJECT_DIR && !process.env.OPENCODE_SESSION_ID) return "claude-code";
  return "opencode";
}
async function writeSessionInfo(directory, sessionId, source) {
  const sessionPath = getSessionPath(directory, source);
  const lockPath = `${sessionPath}.lock`;
  await mkdir(dirname(sessionPath), { recursive: true });
  await withMindLock(lockPath, async () => {
    const info = {
      sessionId,
      source,
      startTime: Date.now()
    };
    await writeFile(sessionPath, JSON.stringify(info));
  });
}
async function readSessionInfo(directory, source) {
  const sessionPath = getSessionPath(directory, source);
  try {
    const content = await readFile(sessionPath, "utf8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}
async function getSessionId(directory, fallbackId) {
  const source = detectSource();
  const info = await readSessionInfo(directory, source);
  if (info?.sessionId) {
    return info.sessionId;
  }
  return fallbackId || `${source}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// src/hooks/tool-capture.ts
var OBSERVED_TOOLS = /* @__PURE__ */ new Set([
  "read",
  "edit",
  "write",
  "bash",
  "grep",
  "glob",
  "webfetch",
  "websearch",
  "task",
  "codesearch",
  "notebookedit",
  "update"
]);
var ALWAYS_CAPTURE_TOOLS = /* @__PURE__ */ new Set([
  "edit",
  "write",
  "update",
  "notebookedit"
]);
var MIN_OUTPUT_LENGTH = 50;
var MAX_OUTPUT_LENGTH = 2500;
var SKIP_PATTERNS = [
  "<system-reminder>",
  "<memvid-mind-context>",
  "<opencode-mind-context>"
];
async function handleToolCapture(input, output, getMind2, directory) {
  const toolName = input.tool.toLowerCase();
  if (!OBSERVED_TOOLS.has(toolName)) {
    return;
  }
  const dir = directory || process.env.OPENCODE_DIR || process.cwd();
  const source = detectSource();
  const toolInput = output.metadata || {};
  if (await isDuplicateAcrossProcesses(dir, source, toolName, toolInput)) {
    debug(`Skipping duplicate (cross-process): ${toolName}`);
    return;
  }
  const toolOutput = output.output || "";
  if (!ALWAYS_CAPTURE_TOOLS.has(toolName) && toolOutput.length < MIN_OUTPUT_LENGTH) {
    return;
  }
  if (SKIP_PATTERNS.some((p) => toolOutput.includes(p))) {
    return;
  }
  let effectiveOutput = toolOutput;
  if (ALWAYS_CAPTURE_TOOLS.has(toolName) && effectiveOutput.length < MIN_OUTPUT_LENGTH) {
    const filePath = output.metadata?.filePath || output.metadata?.file_path || "unknown";
    const fileName = filePath.split("/").pop() || "file";
    effectiveOutput = `File modified: ${fileName}
Path: ${filePath}
Tool: ${toolName}`;
  }
  const mind = await getMind2();
  const sessionId = await getSessionId(dir, input.sessionID);
  const { compressed, wasCompressed, originalSize } = compressToolOutput(
    toolName,
    output.metadata,
    effectiveOutput,
    mind.getConfig().autoCompress
  );
  const type = classifyObservationType(toolName, compressed);
  await mind.remember({
    type,
    summary: output.title || `${toolName} completed`,
    content: compressed.slice(0, MAX_OUTPUT_LENGTH),
    tool: toolName,
    metadata: {
      ...output.metadata || {},
      compressed: wasCompressed,
      originalSize: wasCompressed ? originalSize : void 0,
      sessionId,
      source
    }
  });
  debug(`Captured: [${type}] ${output.title || toolName}${wasCompressed ? " (compressed)" : ""}`);
}

// src/hooks/skill-detector.ts
var ERROR_SIGNALS = [
  "error",
  "failed",
  "exception",
  "crash",
  "broken",
  "typeerror",
  "referenceerror",
  "syntaxerror",
  "enoent",
  "eacces",
  "timeout",
  "rejected"
];
var FIX_SIGNALS = [
  "fix",
  "fixed",
  "resolved",
  "workaround",
  "solved",
  "the issue was",
  "root cause",
  "the problem was",
  "changed to",
  "switched to",
  "replaced with"
];
var NON_OBVIOUS_SIGNALS = [
  "actually",
  "turns out",
  "not obvious",
  "misleading",
  "the real",
  "root cause",
  "unexpected",
  "surprisingly",
  "counterintuitively",
  "despite",
  "even though",
  "the trick",
  "key insight",
  "important to note"
];
function classify(observations) {
  const win = {
    problems: [],
    solutions: [],
    errors: [],
    fixes: [],
    discoveries: [],
    decisions: [],
    patterns: [],
    warnings: []
  };
  for (const obs of observations) {
    const lower = (obs.summary + " " + obs.content).toLowerCase();
    if (obs.type === "problem" || ERROR_SIGNALS.some((s) => lower.includes(s))) {
      win.problems.push(obs);
      if (ERROR_SIGNALS.some((s) => lower.includes(s))) win.errors.push(obs);
    }
    if (obs.type === "solution" || obs.type === "bugfix" || obs.type === "success") {
      win.solutions.push(obs);
      if (FIX_SIGNALS.some((s) => lower.includes(s))) win.fixes.push(obs);
    }
    if (obs.type === "discovery") win.discoveries.push(obs);
    if (obs.type === "decision") win.decisions.push(obs);
    if (obs.type === "pattern") win.patterns.push(obs);
    if (obs.type === "warning") win.warnings.push(obs);
  }
  return win;
}
function hasNonObviousSignals(obs) {
  const lower = (obs.summary + " " + obs.content).toLowerCase();
  return NON_OBVIOUS_SIGNALS.some((s) => lower.includes(s));
}
function extractTitle(problem, solution) {
  const probSummary = problem.summary.replace(/^\[.*?\]\s*/, "").slice(0, 60);
  const solSummary = solution.summary.replace(/^\[.*?\]\s*/, "").slice(0, 60);
  if (solSummary.toLowerCase().startsWith("fix")) return solSummary;
  if (probSummary.length > 10) return `Fix: ${probSummary}`;
  return solSummary || probSummary || "Unnamed skill candidate";
}
function relatedByFile(a, b) {
  const filesA = a.metadata?.files;
  const filesB = b.metadata?.files;
  if (!filesA?.length || !filesB?.length) return false;
  return filesA.some((f) => filesB.includes(f));
}
function relatedByContent(a, b) {
  const textA = (a.summary + " " + a.content).toLowerCase();
  const textB = (b.summary + " " + b.content).toLowerCase();
  const wordsA = new Set(textA.split(/\s+/).filter((w) => w.length > 4));
  const wordsB = new Set(textB.split(/\s+/).filter((w) => w.length > 4));
  let overlap = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap++;
  }
  return overlap >= 3;
}
function toEvidence(obs) {
  return {
    type: obs.type,
    summary: obs.summary.slice(0, 200),
    content: obs.content.slice(0, 500)
  };
}
function detectSkillCandidates(observations, sessionId) {
  if (observations.length < 3) return [];
  const win = classify(observations);
  const candidates = [];
  const now = Date.now();
  let idCounter = 0;
  const nextId = () => `sc_${sessionId.slice(0, 8)}_${idCounter++}`;
  for (const problem of win.problems) {
    for (const solution of win.solutions) {
      if ((solution.timestamp ?? 0) <= (problem.timestamp ?? 0)) continue;
      if (!relatedByFile(problem, solution) && !relatedByContent(problem, solution)) continue;
      const isNonObvious = hasNonObviousSignals(solution) || hasNonObviousSignals(problem);
      candidates.push({
        id: nextId(),
        title: extractTitle(problem, solution),
        reason: isNonObvious ? "Non-obvious problem\u2192solution pair with investigation" : "Problem\u2192solution pair detected",
        confidence: isNonObvious ? "high" : "medium",
        evidence: [toEvidence(problem), toEvidence(solution)],
        detectedAt: now,
        sessionId
      });
      break;
    }
  }
  for (const err of win.errors) {
    for (const fix of win.fixes) {
      if ((fix.timestamp ?? 0) <= (err.timestamp ?? 0)) continue;
      if (candidates.some(
        (c) => c.evidence.some((e) => e.summary === err.summary.slice(0, 200)) && c.evidence.some((e) => e.summary === fix.summary.slice(0, 200))
      )) continue;
      candidates.push({
        id: nextId(),
        title: extractTitle(err, fix),
        reason: "Error with specific fix found",
        confidence: "high",
        evidence: [toEvidence(err), toEvidence(fix)],
        detectedAt: now,
        sessionId
      });
      break;
    }
  }
  const fileGroups = /* @__PURE__ */ new Map();
  for (const obs of observations) {
    const files = obs.metadata?.files;
    if (!files) continue;
    for (const f of files) {
      const group = fileGroups.get(f) ?? [];
      group.push(obs);
      fileGroups.set(f, group);
    }
  }
  for (const [file, group] of fileGroups) {
    if (group.length < 5) continue;
    const hasProblems = group.some((o) => o.type === "problem");
    const hasFixes = group.some((o) => o.type === "solution" || o.type === "bugfix");
    if (!hasProblems || !hasFixes) continue;
    const fileName = file.split("/").pop() ?? file;
    candidates.push({
      id: nextId(),
      title: `Investigation: ${fileName}`,
      reason: `Deep investigation \u2014 ${group.length} observations on ${fileName}`,
      confidence: "medium",
      evidence: group.slice(0, 4).map(toEvidence),
      detectedAt: now,
      sessionId
    });
  }
  const nonObvious = [...win.discoveries, ...win.warnings, ...win.patterns].filter(hasNonObviousSignals);
  if (nonObvious.length >= 2) {
    candidates.push({
      id: nextId(),
      title: nonObvious[0].summary.replace(/^\[.*?\]\s*/, "").slice(0, 80),
      reason: `${nonObvious.length} non-obvious discoveries/warnings in session`,
      confidence: "medium",
      evidence: nonObvious.slice(0, 4).map(toEvidence),
      detectedAt: now,
      sessionId
    });
  }
  const seen = /* @__PURE__ */ new Set();
  const deduped = candidates.filter((c) => {
    const key = c.title.toLowerCase().replace(/\s+/g, " ").trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  deduped.sort((a, b) => {
    if (a.confidence !== b.confidence) return a.confidence === "high" ? -1 : 1;
    return b.evidence.length - a.evidence.length;
  });
  debug(`Skill detector: ${deduped.length} candidate(s) from ${observations.length} observations`);
  return deduped.slice(0, 5);
}
var STAGING_FILE = ".claude/mind-skills-pending.json";
function stagingPath(directory) {
  return resolve(directory, STAGING_FILE);
}
async function loadPendingCandidates(directory) {
  const path = stagingPath(directory);
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw);
  } catch {
    debug("Failed to read skill staging file");
    return null;
  }
}
async function savePendingCandidates(directory, candidates) {
  const path = stagingPath(directory);
  await mkdir(dirname(path), { recursive: true });
  const existing = await loadPendingCandidates(directory);
  const merged = mergeWithExisting(existing, candidates);
  const staged = { candidates: merged };
  await writeFile(path, JSON.stringify(staged, null, 2));
  debug(`Staged ${candidates.length} skill candidate(s) (${merged.length} total pending)`);
}
async function markInjected(directory) {
  const path = stagingPath(directory);
  const staged = await loadPendingCandidates(directory);
  if (!staged) return;
  staged.injectedAt = Date.now();
  await writeFile(path, JSON.stringify(staged, null, 2));
}
async function clearPendingCandidates(directory) {
  const path = stagingPath(directory);
  if (!existsSync(path)) return;
  try {
    const { unlink } = await import('fs/promises');
    await unlink(path);
    debug("Cleared skill staging file");
  } catch {
    debug("Failed to clear skill staging file");
  }
}
function mergeWithExisting(existing, incoming) {
  if (!existing?.candidates?.length) return incoming;
  const uninjected = existing.injectedAt ? [] : existing.candidates;
  const combined = [...uninjected, ...incoming];
  const seen = /* @__PURE__ */ new Set();
  return combined.filter((c) => {
    const key = c.title.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 10);
}

// src/hooks/session-end.ts
var MIN_OBSERVATIONS_FOR_SUMMARY = 3;
var FILE_EXTENSIONS = [
  "*.ts",
  "*.tsx",
  "*.js",
  "*.jsx",
  "*.md",
  "*.json",
  "*.py",
  "*.rs",
  "*.go",
  "*.java",
  "*.c",
  "*.cpp"
];
var IMPORTANT_FILE_PATTERN = /^(README|CHANGELOG|package\.json|Cargo\.toml|\.env)/i;
async function handleSessionEnd(directory, getMind2, $) {
  const mind = await getMind2();
  await captureFileChanges(mind, directory, $);
  const context = await mind.getContext();
  const sessionObs = context.recentObservations.filter(
    (obs) => obs.metadata?.sessionId === mind.getSessionId()
  );
  if (sessionObs.length >= MIN_OBSERVATIONS_FOR_SUMMARY) {
    const summary = generateSessionSummary(sessionObs);
    await mind.saveSessionSummary(summary);
    debug(`Session summary saved: ${summary.keyDecisions.length} decisions, ${summary.filesModified.length} files`);
  }
  const candidates = detectSkillCandidates(sessionObs, mind.getSessionId());
  if (candidates.length > 0) {
    await savePendingCandidates(directory, candidates);
  }
}
async function captureFileChanges(mind, directory, $) {
  try {
    const allFiles = [];
    let gitDiffContent = "";
    try {
      const diff = await $`git diff --name-only HEAD 2>/dev/null || echo ''`.cwd(directory).text();
      allFiles.push(...diff.trim().split("\n").filter(Boolean));
    } catch {
    }
    try {
      const staged = await $`git diff --cached --name-only 2>/dev/null || echo ''`.cwd(directory).text();
      allFiles.push(...staged.trim().split("\n").filter(Boolean));
    } catch {
    }
    if (allFiles.length > 0) {
      try {
        gitDiffContent = await $`git diff HEAD --stat 2>/dev/null | head -30`.cwd(directory).text();
      } catch {
      }
    }
    try {
      const extPattern = FILE_EXTENSIONS.map((e) => `-name "${e}"`).join(" -o ");
      const recent = await $`find . -maxdepth 4 -type f \( ${extPattern} \) -mmin -30 ! -path "*/node_modules/*" ! -path "*/.git/*" ! -path "*/dist/*" ! -path "*/build/*" ! -path "*/.next/*" ! -path "*/target/*" 2>/dev/null | head -30`.cwd(directory).text();
      const recentFiles = recent.trim().split("\n").filter(Boolean).map((f) => f.replace(/^\.\//, ""));
      for (const file of recentFiles) {
        if (!allFiles.includes(file)) {
          allFiles.push(file);
        }
      }
    } catch {
    }
    const uniqueFiles = [...new Set(allFiles)];
    if (uniqueFiles.length === 0) {
      debug("No file changes detected");
      return;
    }
    debug(`Capturing ${uniqueFiles.length} changed files`);
    const contentParts = [
      `## Files Modified This Session

${uniqueFiles.map((f) => `- ${f}`).join("\n")}`
    ];
    if (gitDiffContent) {
      contentParts.push(`
## Git Changes Summary
\`\`\`
${gitDiffContent.trim()}
\`\`\``);
    }
    await mind.remember({
      type: "refactor",
      summary: `Session edits: ${uniqueFiles.length} file(s) modified`,
      content: contentParts.join("\n"),
      tool: "FileChanges",
      metadata: {
        files: uniqueFiles,
        fileCount: uniqueFiles.length,
        captureMethod: "git-diff-plus-recent",
        source: "opencode"
      }
    });
    for (const file of uniqueFiles) {
      const fileName = file.split("/").pop() || file;
      if (IMPORTANT_FILE_PATTERN.test(fileName)) {
        await mind.remember({
          type: "refactor",
          summary: `Modified ${fileName}`,
          content: `File edited: ${file}
This file was modified during the session.`,
          tool: "FileEdit",
          metadata: {
            files: [file],
            fileName,
            source: "opencode"
          }
        });
        debug(`Stored individual edit: ${fileName}`);
      }
    }
    debug(`Stored file changes: ${uniqueFiles.length} files`);
  } catch (err) {
    debug(`Failed to capture file changes: ${err}`);
  }
}
function generateSessionSummary(observations) {
  const keyDecisions = [];
  const filesModified = /* @__PURE__ */ new Set();
  const typeCounts = {};
  for (const obs of observations) {
    if (obs.type === "decision" || obs.summary.toLowerCase().includes("chose") || obs.summary.toLowerCase().includes("decided")) {
      keyDecisions.push(obs.summary);
    }
    const files = obs.metadata?.files;
    if (files) {
      files.forEach((f) => filesModified.add(f));
    }
    typeCounts[obs.type] = (typeCounts[obs.type] || 0) + 1;
  }
  const parts = [];
  if (typeCounts.feature) parts.push(`Added ${typeCounts.feature} feature(s)`);
  if (typeCounts.bugfix) parts.push(`Fixed ${typeCounts.bugfix} bug(s)`);
  if (typeCounts.refactor) parts.push(`Refactored ${typeCounts.refactor} item(s)`);
  if (typeCounts.discovery) parts.push(`Made ${typeCounts.discovery} discovery(ies)`);
  if (typeCounts.problem) parts.push(`Encountered ${typeCounts.problem} problem(s)`);
  if (typeCounts.solution) parts.push(`Found ${typeCounts.solution} solution(s)`);
  const summary = parts.length > 0 ? parts.join(". ") + "." : `Session with ${observations.length} observations.`;
  return {
    keyDecisions: keyDecisions.slice(0, 10),
    filesModified: Array.from(filesModified).slice(0, 20),
    summary
  };
}
function createSearchTool(getMind2) {
  return tool({
    description: "Search through stored memories and observations (shared with Claude Code)",
    args: {
      query: tool.schema.string().describe("Search query"),
      limit: tool.schema.number().optional().describe("Max results (default: 10)")
    },
    async execute(args, ctx) {
      if (ctx.abort.aborted) return "Operation cancelled";
      try {
        ctx.metadata({ title: "Searching memories..." });
        const mind = await getMind2();
        const results = await mind.search(args.query, args.limit ?? 10);
        if (results.length === 0) return "No memories found.";
        ctx.metadata({ title: `Found ${results.length} memories` });
        return results.map((r, i) => {
          const source = r.observation.metadata?.source || "unknown";
          return `${i + 1}. [${r.observation.type}] ${r.observation.summary}
   Score: ${r.score.toFixed(2)} | ${formatTimestamp(r.observation.timestamp)} | via ${source}
   ${r.snippet}`;
        }).join("\n\n");
      } catch (err) {
        return `Failed to search memories: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  });
}
function createAskTool(getMind2) {
  return tool({
    description: "Ask questions about past work and get context-aware answers (includes Claude Code memories)",
    args: {
      question: tool.schema.string().describe("Question to ask")
    },
    async execute(args, ctx) {
      if (ctx.abort.aborted) return "Operation cancelled";
      try {
        ctx.metadata({ title: "Querying memories..." });
        const mind = await getMind2();
        const answer = await mind.ask(args.question);
        ctx.metadata({ title: "Query complete" });
        return answer;
      } catch (err) {
        return `Failed to ask question: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  });
}
function createStatsTool(getMind2) {
  return tool({
    description: "Show memory statistics (combined OpenCode + Claude Code)",
    args: {},
    async execute(_args, ctx) {
      if (ctx.abort.aborted) return "Operation cancelled";
      try {
        ctx.metadata({ title: "Loading statistics..." });
        const mind = await getMind2();
        const stats = await mind.stats();
        ctx.metadata({ title: "Statistics loaded" });
        const lines = [
          `Memory: .claude/mind.mv2 (shared with Claude Code)`,
          `Total Observations: ${stats.totalObservations}`,
          `File Size: ${(stats.fileSize / 1024).toFixed(1)} KB`,
          `Oldest Memory: ${formatTimestamp(stats.oldestMemory)}`,
          `Newest Memory: ${formatTimestamp(stats.newestMemory)}`
        ];
        const types = Object.entries(stats.topTypes);
        if (types.length > 0) {
          lines.push(`Top Types: ${types.map(([k, v]) => `${k}:${v}`).join(", ")}`);
        }
        return lines.join("\n");
      } catch (err) {
        return `Failed to load statistics: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  });
}
function createTimelineTool(getMind2) {
  return tool({
    description: "Show recent memories timeline (from both OpenCode and Claude Code)",
    args: {
      count: tool.schema.number().optional().describe("Number of entries (default: 10)")
    },
    async execute(args, ctx) {
      if (ctx.abort.aborted) return "Operation cancelled";
      try {
        ctx.metadata({ title: "Loading timeline..." });
        const mind = await getMind2();
        const context = await mind.getContext();
        const obs = context.recentObservations.slice(0, args.count ?? 10);
        ctx.metadata({ title: `Loaded ${obs.length} memories` });
        if (obs.length === 0) return "No memories found.";
        return obs.map((o, i) => {
          const source = o.metadata?.source || "unknown";
          return `${i + 1}. [${o.type}] ${o.summary}
   ${formatTimestamp(o.timestamp)} | ${o.tool || "N/A"} | via ${source}`;
        }).join("\n\n");
      } catch (err) {
        return `Failed to load timeline: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  });
}

// src/plugin.ts
function formatContextForSystem(context) {
  const lines = ["<opencode-mind-context>"];
  lines.push("# Memory Context");
  lines.push("");
  lines.push(`Recent observations (${context.recentObservations.length}):`);
  for (const obs of context.recentObservations.slice(0, 10)) {
    const source = obs.metadata?.source || "unknown";
    lines.push(`- [${obs.type}] ${obs.summary} (via ${source})`);
  }
  lines.push("");
  lines.push("Use mind_search or mind_ask to query memories.");
  lines.push("</opencode-mind-context>");
  return lines.join("\n");
}
function formatSkillCandidatesForSystem(candidates) {
  const lines = ["<openception-skill-extraction>"];
  lines.push("Your previous session produced knowledge worth extracting as reusable skills.");
  lines.push("");
  lines.push(`${candidates.length} candidate(s) detected:`);
  lines.push("");
  for (const c of candidates) {
    lines.push(`### ${c.title} [${c.confidence}]`);
    lines.push(`Reason: ${c.reason}`);
    lines.push("Evidence:");
    for (const e of c.evidence) {
      lines.push(`  - [${e.type}] ${e.summary}`);
    }
    lines.push("");
  }
  lines.push("ACTION REQUIRED: Evaluate these candidates for skill extraction.");
  lines.push("If the claudeception skill is loaded, use it. Otherwise:");
  lines.push("1. For each high-confidence candidate, create a SKILL.md at ~/.claude/skills/[name]/SKILL.md");
  lines.push("2. For medium-confidence, mention them to the user and ask if extraction is wanted");
  lines.push("3. Skip candidates whose knowledge is trivial or already exists as a skill");
  lines.push("After extraction (or dismissal), tell the user what was extracted and why.");
  lines.push("</openception-skill-extraction>");
  return lines.join("\n");
}
var OpenCodeBrain = async (ctx) => {
  const { directory, $ } = ctx;
  let sessionSummaryGenerated = false;
  let skillCandidatesInjected = false;
  let mind = null;
  const ensureMind = async () => {
    if (!mind) mind = await getMind(directory);
    return mind;
  };
  return {
    // Register custom tools
    tool: {
      mind_search: createSearchTool(ensureMind),
      mind_ask: createAskTool(ensureMind),
      mind_stats: createStatsTool(ensureMind),
      mind_timeline: createTimelineTool(ensureMind)
    },
    // Subscribe to events
    event: async ({ event }) => {
      if (event.type === "session.created") {
        sessionSummaryGenerated = false;
        const memoryPath = resolve(directory, ".claude/mind.mv2");
        const source = detectSource();
        const sessionId = `${source}-${generateId()}`;
        try {
          await writeSessionInfo(directory, sessionId, source);
          debug(`Session started: ${sessionId}`);
        } catch (err) {
          debug(`Failed to write session info: ${err}`);
        }
        if (existsSync(memoryPath)) {
          try {
            const stats = statSync(memoryPath);
            debug(`Memory loaded: ${(stats.size / 1024).toFixed(1)} KB`);
          } catch {
          }
        } else {
          debug("Memory will be created on first observation");
        }
      }
      if (event.type === "session.idle" && !sessionSummaryGenerated) {
        try {
          if (skillCandidatesInjected) {
            await clearPendingCandidates(directory);
          }
          await handleSessionEnd(directory, ensureMind, $);
          sessionSummaryGenerated = true;
          resetMind();
        } catch (err) {
          debug(`Failed to generate session summary: ${err}`);
        }
      }
    },
    // Capture tool outputs
    "tool.execute.after": async (input, output) => {
      try {
        await handleToolCapture(input, output, ensureMind, directory);
      } catch (err) {
        debug(`Failed to capture tool output for ${input.tool}: ${err}`);
      }
    },
    "experimental.chat.system.transform": async (_input, output) => {
      try {
        const memoryPath = resolve(directory, ".claude/mind.mv2");
        if (!existsSync(memoryPath)) return;
        const mind2 = await ensureMind();
        const context = await mind2.getContext();
        if (context.recentObservations.length > 0) {
          output.system.push(formatContextForSystem(context));
        }
        if (!skillCandidatesInjected) {
          skillCandidatesInjected = true;
          const staged = await loadPendingCandidates(directory);
          if (staged?.candidates?.length && !staged.injectedAt) {
            output.system.push(formatSkillCandidatesForSystem(staged.candidates));
            await markInjected(directory);
            debug(`Injected ${staged.candidates.length} skill candidate(s) into system prompt`);
          }
        }
      } catch {
      }
    },
    // Add context during compaction
    "experimental.session.compacting": async (_input, output) => {
      try {
        const mind2 = await ensureMind();
        const context = await mind2.getContext();
        const keyObs = context.recentObservations.filter(
          (o) => o.type === "decision" || o.type === "pattern" || o.type === "problem"
        ).slice(0, 10);
        if (keyObs.length > 0) {
          output.context.push(`
## Memory Context (from .claude/mind.mv2)

Key observations from this session:
${keyObs.map((o) => `- [${o.type}] ${o.summary}`).join("\n")}
`);
        }
      } catch {
      }
    }
  };
};
var plugin_default = OpenCodeBrain;

export { plugin_default as default };
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map