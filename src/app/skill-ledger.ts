/**
 * Append-only usage ledger for worker skills.
 *
 * Promotion needs evidence from the workers that actually used a skill, and DSH keeps no skill counters of its own. Every
 * `skill` tool call therefore appends one JSON line here; the promoter reads the file and counts per (worker, skill).
 */
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** One recorded use: who loaded which skill, from which session/ticket. */
export interface SkillUse {
  /** ISO timestamp. */
  ts: string
  /** Skill name as the model asked for it. */
  skill: string
  /** Worker identity: the private skill directory's name, e.g. a ticket id. */
  worker: string
  /** Session that made the call. */
  session: string
  /** Ticket the session works on, when it is an executor. */
  ticket?: string
}

/** Library root holding the shared skills and the workers' private trees. */
export function skillLibraryRoot(): string {
  return (process.env.SKILL_LIBRARY_ROOT ?? '/media/joe/E2/superagent/library').replace(/\/+$/, '')
}

/** The usage ledger path (JSON lines). */
export function skillLedgerPath(): string {
  return process.env.SKILL_LEDGER_PATH ?? join(skillLibraryRoot(), '.skill-usage.jsonl')
}

/** A worker's private skill tree: drafts live here, only that worker sees them. */
export function workerSkillDir(worker: string): string {
  return join(skillLibraryRoot(), 'skills', 'workers', worker)
}

/**
 * Returns a recorder that serialises appends so concurrent calls cannot interleave a line.
 * Recording never throws: a broken ledger must not break a tool call.
 */
export function createSkillRecorder(log: (message: string) => void = () => {}): (use: SkillUse) => void {
  const path = skillLedgerPath()
  let chain: Promise<void> = Promise.resolve()
  return (use: SkillUse): void => {
    chain = chain
      .then(async () => {
        await mkdir(dirname(path), { recursive: true })
        await appendFile(path, `${JSON.stringify(use)}\n`, 'utf8')
      })
      .catch((error: unknown) => { log(`skill ledger write failed: ${String(error)}`) })
  }
}

/** Reads the `skill` tool's argument as a skill name, whatever shape the model chose. */
export function skillNameOf(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const record = input as Record<string, unknown>
  for (const key of ['name', 'skill', 'skill_name', 'id']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

/**
 * The name of a worker slot's private skill tree: slot 0 is `slot-1`, so the trees of the slots stay where earlier versions
 * wrote them and the promoter attributes their drafts and loads to the same worker.
 */
export function workerSlotName(slot: number): string {
  return `slot-${Math.trunc(slot) + 1}`
}

/**
 * The lowest slot no other open ticket holds. While at most `maxWorkers` tickets are open that is one of 0..maxWorkers-1;
 * tickets that wait on a person stay open and keep theirs, so with more open tickets the next number is given rather than
 * a slot another open ticket holds, and two open tickets never share a private tree.
 * @param held - The slots the other open tickets hold.
 */
export function freeSlot(held: Iterable<number>): number {
  const taken = new Set(held)
  let slot = 0
  while (taken.has(slot)) slot++
  return slot
}

/** One skill found in a private tree. */
export interface PrivateSkill {
  name: string
  description: string
  content: string
  path: string
}

/** Parses `name:` and `description:` from a SKILL.md frontmatter block without pulling in a YAML parser. */
function frontmatterField(text: string, field: string): string | undefined {
  const match = new RegExp(`^${field}\\s*:\\s*(.+)$`, 'm').exec(text.slice(0, 2000))
  const value = match?.[1]
  if (!value) return undefined
  return value.trim().replace(/^["']|["']$/g, '')
}

/**
 * Lists the skills under one worker's private tree. Registration is by name, so a private skill with a name the shared
 * catalog already uses shadows it for that worker alone — its own draft wins, which is the point of a private tree.
 */
export async function readPrivateSkills(directory: string): Promise<PrivateSkill[]> {
  const { readdir, readFile } = await import('node:fs/promises')
  const found: PrivateSkill[] = []
  const walk = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) { await walk(path); continue }
      if (entry.name !== 'SKILL.md') continue
      let content: string
      try {
        content = await readFile(path, 'utf8')
      } catch {
        continue
      }
      const dirName = dir.split('/').filter(Boolean).at(-1) ?? ''
      const name: string = frontmatterField(content, 'name') ?? dirName
      if (!name) continue
      found.push({ name, description: frontmatterField(content, 'description') ?? 'Worker draft skill.', content, path })
    }
  }
  await walk(directory)
  return found
}

