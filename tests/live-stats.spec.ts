// The last day of Tickets on the live view.
import { expect, it } from 'vitest'
import type { Ticket } from '../src/core/index.ts'
import { dayStats } from '../src/app/views/live.ts'

const NOW = Date.parse('2026-11-18T12:00:00Z')
const at = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()
const ticket = (opened: number, wait: number, work?: number, state = 'ready'): Ticket => ({ createdAt: at(opened),
  assignments: [{ id: 'a', state: 'ended', createdAt: at(opened), startedAt: at(opened - wait),
    ...work === undefined ? {} : { report: { state, summary: '', at: at(opened - wait - work) } } }] }) as unknown as Ticket

it('measures the slot wait and the time to the first Report that is not progress, and counts Tickets by hour', () => {
  const tickets = [ticket(30, 0.1, 4), ticket(35, 3, 6), ticket(200, 0.2, 2), ticket(201, 0.5, 9, 'progress'),
    // Opened before the day, or never started, it adds to no wait.
    ticket(25 * 60, 0, 1), { createdAt: at(10), assignments: [{ id: 'a', state: 'pending', createdAt: at(10) }] } as unknown as Ticket]
  const day = dayStats(tickets, NOW)
  expect(day.wait).toEqual({ count: 4, p50: 30_000, p95: 180_000, waited: 1 })
  expect(day.work).toEqual({ count: 3, p50: 240_000, p95: 360_000 })
  expect(day.hours).toHaveLength(24)
  expect(day.hours.reduce((sum, hour) => sum + hour.opened, 0)).toBe(5)
  expect(day.hours.at(-1)).toMatchObject({ opened: 3, waited: 1 })
  expect(day.hours.at(-4)).toMatchObject({ opened: 2, waited: 0 })
  expect(dayStats([], NOW).wait).toEqual({ count: 0, p50: 0, p95: 0, waited: 0 })
})
