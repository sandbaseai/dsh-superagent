/** Five-field cron expressions (minute hour day month weekday) evaluated at minute resolution in an IANA time zone. */

const MINUTE = 60_000
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const FIELDS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]] as const

export interface Cron {
  minute: ReadonlySet<number>; hour: ReadonlySet<number>; day: ReadonlySet<number>; month: ReadonlySet<number>
  weekday: ReadonlySet<number>
  /** Whether the day or the weekday field starts with `*`; as in Vixie cron, a day matches either field only when both are restricted. */
  anyDay: boolean; anyWeekday: boolean
}

function field(text: string, min: number, max: number): Set<number> {
  const values = new Set<number>()
  for (const part of text.split(',')) {
    const match = /^(?:(\*)|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part)
    if (!match) throw new Error(`“${part}” is not a cron field`)
    const [, star, first, last, every] = match
    const step = every === undefined ? 1 : Number(every)
    const from = star ? min : Number(first)
    const to = star ? max : last !== undefined ? Number(last) : every !== undefined ? max : from
    if (step < 1 || from < min || to > max || from > to) throw new Error(`“${part}” is outside ${min}–${max}`)
    for (let value = from; value <= to; value += step) values.add(value)
  }
  return values
}

/** @throws Error naming the malformed field when `expression` is not five valid cron fields. */
export function parseCron(expression: string): Cron {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) throw new Error('A cron expression has five fields: minute hour day month weekday')
  const [minute, hour, day, month, weekday] = parts.map((part, index) => field(part, FIELDS[index]![0], FIELDS[index]![1])) as [
    Set<number>, Set<number>, Set<number>, Set<number>, Set<number>]
  if (weekday.delete(7)) weekday.add(0)
  return { minute, hour, day, month, weekday, anyDay: parts[2]!.startsWith('*'), anyWeekday: parts[4]!.startsWith('*') }
}

export function validTimeZone(timeZone: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone }); return true } catch { return false }
}

const formats = new Map<string, Intl.DateTimeFormat>()
function wallClock(at: number, timeZone: string) {
  let format = formats.get(timeZone)
  if (!format) formats.set(timeZone, format = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', month: 'numeric',
    day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' }))
  const parts = Object.fromEntries(format.formatToParts(at).map(part => [part.type, part.value]))
  return { minute: Number(parts.minute), hour: Number(parts.hour), day: Number(parts.day), month: Number(parts.month),
    weekday: WEEKDAYS.indexOf(parts.weekday ?? '') }
}
function dayMatches(cron: Cron, clock: ReturnType<typeof wallClock>): boolean {
  if (!cron.month.has(clock.month)) return false
  const day = cron.day.has(clock.day), weekday = cron.weekday.has(clock.weekday)
  return cron.anyDay || cron.anyWeekday ? day && weekday : day || weekday
}

/** Whether the minute that contains `at` (ms since the epoch) is one of `cron`'s in `timeZone`. */
export function cronMatches(cron: Cron, at: number, timeZone: string): boolean {
  const clock = wallClock(at, timeZone)
  return dayMatches(cron, clock) && cron.hour.has(clock.hour) && cron.minute.has(clock.minute)
}

/** The start of the first minute after `after` that `cron` names in `timeZone`, or undefined when none falls within a year. */
export function nextRun(cron: Cron, after: number, timeZone: string): number | undefined {
  const end = after + 366 * 24 * 60 * MINUTE
  for (let at = Math.floor(after / MINUTE) * MINUTE + MINUTE; at <= end;) {
    const clock = wallClock(at, timeZone)
    // Skip the rest of a local hour whose day or hour does not match.
    if (!dayMatches(cron, clock) || !cron.hour.has(clock.hour)) { at += (60 - clock.minute) * MINUTE; continue }
    if (cron.minute.has(clock.minute)) return at
    at += MINUTE
  }
  return undefined
}
