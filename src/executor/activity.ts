/** What each worker and its subagents did lately, read from their Session events as they happen, for the live view. */

/** The parts of a Session event the record reads; DSH's events carry more. */
export type ActivityEvent =
  | { type: 'tool/call'; time: number; data: { name: string; arguments: string } }
  | { type: 'tool/result'; time: number; data: { message: { isError?: boolean } } }
  | { type: 'assistant/message'; time: number; data: { usage?: { inputTokens: number; outputTokens: number } } }
  | { type: string; time: number; data?: unknown }

export interface Activity {
  /** When the worker or a subagent last called a tool, got its result, or the model answered. */
  lastAt?: string
  /** The last tool called and, for a shell command, its start. */
  lastTool?: { name: string; detail?: string; at: string }
  tools: number
  errors: number
  /** Tokens the model read and wrote across the worker and its subagents. */
  tokens: number
  /** Subagents whose turn runs now. */
  subagents: number
}

/** The start of a shell command shown beside its tool, which is enough to tell what runs. */
const DETAIL_CHARS = 80
const SHELLS = new Set(['bash', 'pwsh'])

/** The command of a shell call or the path of a file tool, from its raw arguments. */
function detail(name: string, raw: string): string | undefined {
  let args: unknown
  try { args = JSON.parse(raw) } catch { return undefined }
  if (!args || typeof args !== 'object') return undefined
  const value = (args as Record<string, unknown>)[SHELLS.has(name) ? 'command' : 'path']
  if (typeof value !== 'string' || !value.trim()) return undefined
  const line = value.trim().split('\n')[0]!
  return line.length > DETAIL_CHARS ? `${line.slice(0, DETAIL_CHARS - 1)}…` : line
}

/** The activity of each open ticket's worker and its subagents, recorded from Session events and agent status as they happen. */
export class Activities {
  private readonly records = new Map<string, Activity & { running: Set<string> }>()
  private entry(ticketId: string) {
    let record = this.records.get(ticketId)
    if (!record) this.records.set(ticketId, record = { tools: 0, errors: 0, tokens: 0, subagents: 0, running: new Set() })
    return record
  }
  private readonly seeded = new Set<string>()
  /**
   * Read the worker's Session once, in place of what was recorded before: the Session holds the worker's own events since the
   * ticket began, which a restart does not lose. Subagents' events reach the record only as they happen.
   */
  read(ticketId: string): boolean { return this.seeded.has(ticketId) }
  seed(ticketId: string, events: () => readonly ActivityEvent[]): void {
    if (this.seeded.has(ticketId)) return
    this.seeded.add(ticketId)
    const running = this.records.get(ticketId)?.running ?? new Set<string>()
    this.records.set(ticketId, { tools: 0, errors: 0, tokens: 0, subagents: running.size, running })
    for (const event of events()) this.record(ticketId, event)
  }
  /** Record one event of the ticket's worker or of one of its subagents. */
  record(ticketId: string, event: ActivityEvent): void {
    if (event.type !== 'tool/call' && event.type !== 'tool/result' && event.type !== 'assistant/message') return
    const record = this.entry(ticketId)
    const at = new Date(event.time).toISOString()
    if (!record.lastAt || at > record.lastAt) record.lastAt = at
    if (event.type === 'tool/call') {
      const { name, arguments: raw } = (event as Extract<ActivityEvent, { type: 'tool/call' }>).data
      record.tools++
      const shown = detail(name, raw)
      record.lastTool = { name, at, ...shown ? { detail: shown } : {} }
    } else if (event.type === 'tool/result') {
      if ((event as Extract<ActivityEvent, { type: 'tool/result' }>).data.message.isError) record.errors++
    } else {
      const usage = (event as Extract<ActivityEvent, { type: 'assistant/message' }>).data.usage
      if (usage) record.tokens += usage.inputTokens + usage.outputTokens
    }
  }
  /** A subagent of the ticket's worker started or ended its turn. */
  subagent(ticketId: string, sessionId: string, running: boolean): void {
    const record = this.entry(ticketId)
    if (running) record.running.add(sessionId); else record.running.delete(sessionId)
    record.subagents = record.running.size
  }
  get(ticketId: string): Activity | undefined {
    const record = this.records.get(ticketId)
    if (!record) return undefined
    const { running: _running, ...activity } = record
    return activity
  }
  /** Forget the tickets that are no longer open. */
  keep(open: ReadonlySet<string>): void {
    for (const id of this.records.keys()) if (!open.has(id)) { this.records.delete(id); this.seeded.delete(id) }
  }
}
