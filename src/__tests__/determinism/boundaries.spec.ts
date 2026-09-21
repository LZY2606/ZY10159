import { describe, it, expect } from "vitest"
import {
  dayStart,
  dayEnd,
  hourStart,
  hourEnd,
  minuteStart,
  minuteEnd,
  weekStart,
  weekEnd,
  monthStart,
  monthEnd,
  yearStart,
  yearEnd,
} from "../../index"
import { HOST_TZ, findTransitions } from "./helpers"

/**
 * BOUNDARIES.
 * Tempo models end-of-X inclusively at ...:59.999, i.e. the half-open
 * interval [start, end + 1ms). We assert the half-open relation exactly
 * (not an inclusive "end == next start"), and we do it separately from the
 * inclusive last-instant predicate.
 */
const HOST = HOST_TZ
const MS = 1

function local(y: number, mo: number, d: number, h = 12, mi = 30, s = 30, ms = 123) {
  return new Date(y, mo - 1, d, h, mi, s, ms)
}

describe("fixed-length units: end + 1ms equals the next start", () => {
  it("minute", () => {
    const d = local(2024, 6, 15)
    expect(+minuteEnd(d) + MS).toBe(+minuteStart(new Date(+d + 60_000)))
  })
  it("hour", () => {
    const d = local(2024, 6, 15)
    expect(+hourEnd(d) + MS).toBe(+hourStart(new Date(+d + 3_600_000)))
  })
  it("day (holds even across DST because boundaries share the same day)", () => {
    const d = local(2024, 6, 15)
    expect(+dayEnd(d) + MS).toBe(+dayStart(new Date(+d + 86_400_000)))
  })
})

describe("day boundaries around DST (host zone)", () => {
  it("start is 00:00:00.000 and end is 23:59:59.999 of the same wall day", () => {
    const samples =
      HOST === "America/New_York"
        ? [
            [2024, 3, 10], // gap day
            [2024, 11, 3], // overlap day
          ]
        : HOST === "Europe/Berlin"
          ? [
              [2024, 3, 31],
              [2024, 10, 27],
            ]
          : HOST === "Australia/Lord_Howe"
            ? [
                [2024, 10, 6],
                [2024, 4, 7],
              ]
            : [
                [2024, 3, 10],
                [2024, 11, 3],
              ]

    for (const [y, mo, d] of samples as number[][]) {
      const start = dayStart(local(y, mo, d))
      const end = dayEnd(local(y, mo, d))
      expect([start.getFullYear(), start.getMonth() + 1, start.getDate()]).toEqual([
        y,
        mo,
        d,
      ])
      expect([
        start.getHours(),
        start.getMinutes(),
        start.getSeconds(),
        start.getMilliseconds(),
      ]).toEqual([0, 0, 0, 0])
      expect([
        end.getHours(),
        end.getMinutes(),
        end.getSeconds(),
        end.getMilliseconds(),
      ]).toEqual([23, 59, 59, 999])
      // Half-open adjacency: end + 1ms is the following wall midnight.
      const next = new Date(+end + 1)
      expect([
        next.getHours(),
        next.getMinutes(),
        next.getSeconds(),
        next.getMilliseconds(),
      ]).toEqual([0, 0, 0, 0])
      expect(next.getDate() - d === 1 || next.getDate() === 1).toBe(true)
    }
  })

  it("the contained interval length is 23h/25h on transition days (paired)", () => {
    const t = findTransitions(HOST, 2024)
    if (t.length === 0) {
      // no-DST zones: interval is exactly 86_399_999 ms.
      const start = dayStart(local(2024, 3, 10))
      const end = dayEnd(local(2024, 3, 10))
      expect(+end - +start).toBe(86_399_999)
      return
    }
    for (const tr of t) {
      // Locate the transition's local wall day via the "after" instant.
      const day = new Date(tr.after)
      const start = dayStart(day)
      const end = dayEnd(day)
      const spanMs = +end - +start
      const expected = tr.isGap
        ? 86_399_999 - Math.abs(tr.deltaMin) * 60_000
        : 86_399_999 + Math.abs(tr.deltaMin) * 60_000
      expect(spanMs).toBe(expected)
    }
  })
})

describe("week boundaries are 6 days apart as wall dates", () => {
  it("weekStart (Sunday default) then +6 wall days = weekEnd date", () => {
    const d = local(2024, 3, 13) // a Wednesday
    const s = weekStart(d)
    const e = weekEnd(d)
    expect(s.getDay()).toBe(0)
    expect(e.getDay()).toBe(6)
    // Wall-date distance is exactly 6 days even across a DST week; compare
    // wall fields, not raw milliseconds (a DST week is not 7*24h).
    const endMidnight = dayStart(e)
    expect(diffWallDays(s, endMidnight)).toBe(6)
    // Both are at their day boundaries: start 00:00:00.000, end ...59.999.
    expect([s.getHours(), s.getMinutes(), s.getSeconds(), s.getMilliseconds()]).toEqual([
      0, 0, 0, 0,
    ])
    expect([e.getHours(), e.getMinutes(), e.getSeconds(), e.getMilliseconds()]).toEqual([
      23, 59, 59, 999,
    ])
  })

  it("honors an explicit first weekday", () => {
    const d = local(2024, 3, 13) // Wednesday
    expect(weekStart(d, 1).getDay()).toBe(1) // Monday
    expect(weekEnd(d, 1).getDay()).toBe(0)
  })
})

describe("month/year boundaries and the inclusive end semantic", () => {
  it("monthStart is day 1 at midnight; monthEnd keeps the wall time, is last day", () => {
    const d = local(2024, 2, 15, 8, 9, 10, 11)
    const s = monthStart(d)
    const e = monthEnd(d)
    expect([s.getMonth() + 1, s.getDate(), s.getHours(), s.getMinutes()]).toEqual([
      2, 1, 0, 0,
    ])
    // monthEnd intentionally preserves wall time (documented behavior).
    expect([
      e.getMonth() + 1,
      e.getDate(),
      e.getHours(),
      e.getMinutes(),
      e.getSeconds(),
      e.getMilliseconds(),
    ]).toEqual([2, 29, 8, 9, 10, 11])
  })

  it("monthEnd(day 1) ... next monthStart relation via a normalized midnight end", () => {
    const d = local(2024, 2, 15)
    const e = monthEnd(d)
    const endOfDay = new Date(e)
    endOfDay.setHours(23, 59, 59, 999)
    const nextStart = monthStart(new Date(+endOfDay + 1))
    expect([
      nextStart.getFullYear(),
      nextStart.getMonth() + 1,
      nextStart.getDate(),
    ]).toEqual([2024, 3, 1])
  })

  it("yearStart/yearEnd bracket the full year half-open", () => {
    const s = yearStart(local(2024, 6, 1))
    const e = yearEnd(local(2024, 6, 1))
    expect(+s).toBe(+new Date(2024, 0, 1, 0, 0, 0, 0))
    expect(+e).toBe(+new Date(2024, 11, 31, 23, 59, 59, 999))
    expect(+e + 1).toBe(+yearStart(local(2025, 1, 1)))
  })
})

/** Whole calendar days between two local midnights (DST-safe). */
function diffWallDays(from: Date, to: Date): number {
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate())
  const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate())
  return Math.round((b - a) / 86_400_000)
}
