import { readFile, writeFile, mkdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { debug } from "./helpers.js"
import type { SkillCandidate } from "../hooks/skill-detector.js"

const STAGING_FILE = ".claude/mind-skills-pending.json"

export interface StagedCandidates {
  candidates: SkillCandidate[]
  injectedAt?: number
}

function stagingPath(directory: string): string {
  return resolve(directory, STAGING_FILE)
}

export async function loadPendingCandidates(directory: string): Promise<StagedCandidates | null> {
  const path = stagingPath(directory)
  if (!existsSync(path)) return null

  try {
    const raw = await readFile(path, "utf8")
    return JSON.parse(raw) as StagedCandidates
  } catch {
    debug("Failed to read skill staging file")
    return null
  }
}

export async function savePendingCandidates(
  directory: string,
  candidates: SkillCandidate[],
): Promise<void> {
  const path = stagingPath(directory)
  await mkdir(dirname(path), { recursive: true })

  const existing = await loadPendingCandidates(directory)
  const merged = mergeWithExisting(existing, candidates)

  const staged: StagedCandidates = { candidates: merged }
  await writeFile(path, JSON.stringify(staged, null, 2))
  debug(`Staged ${candidates.length} skill candidate(s) (${merged.length} total pending)`)
}

export async function markInjected(directory: string): Promise<void> {
  const path = stagingPath(directory)
  const staged = await loadPendingCandidates(directory)
  if (!staged) return

  staged.injectedAt = Date.now()
  await writeFile(path, JSON.stringify(staged, null, 2))
}

export async function clearPendingCandidates(directory: string): Promise<void> {
  const path = stagingPath(directory)
  if (!existsSync(path)) return

  try {
    const { unlink } = await import("node:fs/promises")
    await unlink(path)
    debug("Cleared skill staging file")
  } catch {
    debug("Failed to clear skill staging file")
  }
}

function mergeWithExisting(
  existing: StagedCandidates | null,
  incoming: SkillCandidate[],
): SkillCandidate[] {
  if (!existing?.candidates?.length) return incoming

  // Keep un-injected existing candidates, add new ones, cap at 10
  const uninjected = existing.injectedAt
    ? [] // already injected → start fresh
    : existing.candidates

  const combined = [...uninjected, ...incoming]

  // Deduplicate by title
  const seen = new Set<string>()
  return combined.filter(c => {
    const key = c.title.toLowerCase().trim()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, 10)
}
