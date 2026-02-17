import type { Observation } from "../types.js"
import { debug } from "../utils/helpers.js"

export interface SkillCandidate {
  id: string
  title: string
  reason: string
  confidence: "high" | "medium"
  evidence: Array<{ type: string; summary: string; content: string }>
  detectedAt: number
  sessionId: string
}

interface ObsWindow {
  problems: Observation[]
  solutions: Observation[]
  errors: Observation[]
  fixes: Observation[]
  discoveries: Observation[]
  decisions: Observation[]
  patterns: Observation[]
  warnings: Observation[]
}

const ERROR_SIGNALS = [
  "error", "failed", "exception", "crash", "broken",
  "typeerror", "referenceerror", "syntaxerror",
  "enoent", "eacces", "timeout", "rejected",
]

const FIX_SIGNALS = [
  "fix", "fixed", "resolved", "workaround", "solved",
  "the issue was", "root cause", "the problem was",
  "changed to", "switched to", "replaced with",
]

const NON_OBVIOUS_SIGNALS = [
  "actually", "turns out", "not obvious", "misleading",
  "the real", "root cause", "unexpected", "surprisingly",
  "counterintuitively", "despite", "even though",
  "the trick", "key insight", "important to note",
]

function classify(observations: Observation[]): ObsWindow {
  const win: ObsWindow = {
    problems: [], solutions: [], errors: [], fixes: [],
    discoveries: [], decisions: [], patterns: [], warnings: [],
  }

  for (const obs of observations) {
    const lower = (obs.summary + " " + obs.content).toLowerCase()

    if (obs.type === "problem" || ERROR_SIGNALS.some(s => lower.includes(s))) {
      win.problems.push(obs)
      if (ERROR_SIGNALS.some(s => lower.includes(s))) win.errors.push(obs)
    }

    if (obs.type === "solution" || obs.type === "bugfix" || obs.type === "success") {
      win.solutions.push(obs)
      if (FIX_SIGNALS.some(s => lower.includes(s))) win.fixes.push(obs)
    }

    if (obs.type === "discovery") win.discoveries.push(obs)
    if (obs.type === "decision") win.decisions.push(obs)
    if (obs.type === "pattern") win.patterns.push(obs)
    if (obs.type === "warning") win.warnings.push(obs)
  }

  return win
}

function hasNonObviousSignals(obs: Observation): boolean {
  const lower = (obs.summary + " " + obs.content).toLowerCase()
  return NON_OBVIOUS_SIGNALS.some(s => lower.includes(s))
}

function extractTitle(problem: Observation, solution: Observation): string {
  const probSummary = problem.summary.replace(/^\[.*?\]\s*/, "").slice(0, 60)
  const solSummary = solution.summary.replace(/^\[.*?\]\s*/, "").slice(0, 60)

  if (solSummary.toLowerCase().startsWith("fix")) return solSummary
  if (probSummary.length > 10) return `Fix: ${probSummary}`
  return solSummary || probSummary || "Unnamed skill candidate"
}

function relatedByFile(a: Observation, b: Observation): boolean {
  const filesA = a.metadata?.files as string[] | undefined
  const filesB = b.metadata?.files as string[] | undefined
  if (!filesA?.length || !filesB?.length) return false
  return filesA.some(f => filesB.includes(f))
}

function relatedByContent(a: Observation, b: Observation): boolean {
  const textA = (a.summary + " " + a.content).toLowerCase()
  const textB = (b.summary + " " + b.content).toLowerCase()

  const wordsA = new Set(textA.split(/\s+/).filter(w => w.length > 4))
  const wordsB = new Set(textB.split(/\s+/).filter(w => w.length > 4))

  let overlap = 0
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap++
  }

  return overlap >= 3
}

function toEvidence(obs: Observation): { type: string; summary: string; content: string } {
  return {
    type: obs.type,
    summary: obs.summary.slice(0, 200),
    content: obs.content.slice(0, 500),
  }
}

/**
 * Detect skill-worthy patterns in a set of session observations.
 *
 * Returns candidates ordered by confidence.
 */
export function detectSkillCandidates(
  observations: Observation[],
  sessionId: string,
): SkillCandidate[] {
  if (observations.length < 3) return []

  const win = classify(observations)
  const candidates: SkillCandidate[] = []
  const now = Date.now()
  let idCounter = 0

  const nextId = () => `sc_${sessionId.slice(0, 8)}_${idCounter++}`

  // Pattern 1 — Problem → Solution pair (high confidence)
  for (const problem of win.problems) {
    for (const solution of win.solutions) {
      if ((solution.timestamp ?? 0) <= (problem.timestamp ?? 0)) continue
      if (!relatedByFile(problem, solution) && !relatedByContent(problem, solution)) continue

      const isNonObvious = hasNonObviousSignals(solution) || hasNonObviousSignals(problem)
      candidates.push({
        id: nextId(),
        title: extractTitle(problem, solution),
        reason: isNonObvious
          ? "Non-obvious problem→solution pair with investigation"
          : "Problem→solution pair detected",
        confidence: isNonObvious ? "high" : "medium",
        evidence: [toEvidence(problem), toEvidence(solution)],
        detectedAt: now,
        sessionId,
      })
      break // one match per problem is enough
    }
  }

  // Pattern 2 — Error message → Fix (high confidence)
  for (const err of win.errors) {
    for (const fix of win.fixes) {
      if ((fix.timestamp ?? 0) <= (err.timestamp ?? 0)) continue
      // Skip if already captured by pattern 1
      if (candidates.some(c =>
        c.evidence.some(e => e.summary === err.summary.slice(0, 200)) &&
        c.evidence.some(e => e.summary === fix.summary.slice(0, 200))
      )) continue

      candidates.push({
        id: nextId(),
        title: extractTitle(err, fix),
        reason: "Error with specific fix found",
        confidence: "high",
        evidence: [toEvidence(err), toEvidence(fix)],
        detectedAt: now,
        sessionId,
      })
      break
    }
  }

  // Pattern 3 — Deep investigation (5+ observations touching same files)
  const fileGroups = new Map<string, Observation[]>()
  for (const obs of observations) {
    const files = obs.metadata?.files as string[] | undefined
    if (!files) continue
    for (const f of files) {
      const group = fileGroups.get(f) ?? []
      group.push(obs)
      fileGroups.set(f, group)
    }
  }
  for (const [file, group] of fileGroups) {
    if (group.length < 5) continue
    const hasProblems = group.some(o => o.type === "problem")
    const hasFixes = group.some(o => o.type === "solution" || o.type === "bugfix")
    if (!hasProblems || !hasFixes) continue

    const fileName = file.split("/").pop() ?? file
    candidates.push({
      id: nextId(),
      title: `Investigation: ${fileName}`,
      reason: `Deep investigation — ${group.length} observations on ${fileName}`,
      confidence: "medium",
      evidence: group.slice(0, 4).map(toEvidence),
      detectedAt: now,
      sessionId,
    })
  }

  // Pattern 4 — Non-obvious discoveries or warnings
  const nonObvious = [...win.discoveries, ...win.warnings, ...win.patterns]
    .filter(hasNonObviousSignals)
  if (nonObvious.length >= 2) {
    candidates.push({
      id: nextId(),
      title: nonObvious[0].summary.replace(/^\[.*?\]\s*/, "").slice(0, 80),
      reason: `${nonObvious.length} non-obvious discoveries/warnings in session`,
      confidence: "medium",
      evidence: nonObvious.slice(0, 4).map(toEvidence),
      detectedAt: now,
      sessionId,
    })
  }

  // Deduplicate by title similarity
  const seen = new Set<string>()
  const deduped = candidates.filter(c => {
    const key = c.title.toLowerCase().replace(/\s+/g, " ").trim()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  // Sort: high confidence first, then by evidence count
  deduped.sort((a, b) => {
    if (a.confidence !== b.confidence) return a.confidence === "high" ? -1 : 1
    return b.evidence.length - a.evidence.length
  })

  debug(`Skill detector: ${deduped.length} candidate(s) from ${observations.length} observations`)
  return deduped.slice(0, 5) // cap at 5 candidates per session
}
