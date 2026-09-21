/**
 * Layer 3 — CALENDAR UNITS.
 *
 * Months and years are civil units: arithmetic is defined on year/month/day
 * fields, with an explicit overflow policy at month ends. Days/weeks are
 * calendar units too (date/weekdate fields), as opposed to the fixed-duration
 * "elapsed" view in instant.spec.ts.
 *
 * Assertions:
 *  - target wall fields (year/month/day) match hand-rolled Gregorian math;
 *  - overflow "clamp" (Tempo default) vs "forward" are declared separately;
 *  - leap-day and month-end samples come in PAIRS (2024 leap vs 2023 non-leap;
 *    31-day-source-month vs 30-day-source-month);
 *  - add/diff inverse relations are stated PER UNIT and PER overflow mode —
 *    clamping makes them non-invertible in one direction by design;
 *  - startOf/endOf adjacency respects Tempo's closed-interval end precision
 *    (end = 23:59:59.999), so two adjacent boundaries are 1ms apart.
 */
import { describe, it, expect } from "vitest"
import {
  add,
  addDay,
  addMonth,
  addYear,
  diffMonths,
  diffYears,
  diffDays,
  diffWeeks,
  diffMilliseconds,
  dayStart,
  dayEnd,
  monthStart,
  monthEnd,
  yearStart,
  yearEnd,
  weekStart,
  weekEnd,
  monthDays,
} from "../../index"
import { hostZone, useFixedNow } from "./helpers"
import {
  isLeapYear,
  daysInMonth,
  calendarAddMonths,

  calendarWeekday,
  zonedParts,
} from "./oracle"

useFixedNow()

function localWall(y: number, mo: number, d: number, h = 12, mi = 0, s = 0, ms = 0) {
  return new Date(y, mo - 1, d, h, mi, s, ms)
}

describe("month-end overflow policy: clamp (default) vs forward", () => {
  // Pairs: leap February vs non-leap February; 31-day month vs 30-day month.
  const cases: Array<{ from: [number, number, number]; amount: number }> = [
    { from: [2024, 1, 31], amount: 1 }, // Jan 31 -> Feb
    { from: [2023, 1, 31], amount: 1 }, // Jan 31 -> Feb (non-leap)
    { from: [2024, 2, 29], amount: 12 }, // leap day -> Feb next year
    { from: [2024, 2, 29], amount: 1 }, // leap day -> March
    { from: [2023, 2, 28], amount: 12 }, // non-leap Feb 28 -> Feb 28
    { from: [2024, 3, 31], amount: 1 }, // Mar 31 -> Apr
    { from: [2024, 4, 30], amount: 1 }, // Apr 30 -> May (no clamp)
    { from: [2024, 12, 31], amount: 2 }, // Dec 31 + 2m -> Feb
    { from: [2024, 1, 31], amount: -1 }, // Jan 31 -> previous Dec (no clamp)
    { from: [2024, 3, 31], amount: -1 }, // Mar 31 -> Feb (clamp)
  ]

  it("clamp: day never exceeds the target month length (independent Gregorian oracle)", () => {
    for (const { from, amount } of cases) {
      const [y, m, d] = from
      const start = localWall(y, m, d, 10, 30, 45, 250)
      const result = addMonth(start, amount, false)
      const expected = calendarAddMonths(y, m, d, amount, "clamp")
      const p = zonedParts(result.getTime(), hostZone())
      expect([p.year, p.month, p.day]).toEqual([expected.year, expected.month, expected.day])
      // time of day is preserved through month arithmetic
      expect([p.hour, p.minute, p.second, p.millisecond]).toEqual([10, 30, 45, 250])
    }
  })

  it("forward: day-of-month is kept and excess rolls into later days/months", () => {
    const forwardCases: Array<{ from: [number, number, number]; amount: number; to: [number, number, number] }> = [
      { from: [2024, 1, 31], amount: 1, to: [2024, 3, 2] }, // Jan 31 + 1m = Mar 2
      { from: [2023, 1, 31], amount: 1, to: [2023, 3, 3] }, // Jan 31 -> Feb 28 -> Mar 3
      { from: [2024, 2, 29], amount: 12, to: [2025, 3, 1] }, // Feb 29 2024 + 1y = Mar 1 2025
      { from: [2024, 3, 31], amount: 1, to: [2024, 5, 1] }, // Mar 31 -> Apr 31 = May 1
      { from: [2024, 12, 31], amount: 2, to: [2025, 3, 3] },
    ]
    for (const { from, amount, to } of forwardCases) {
      const [y, m, d] = from
      const result = addMonth(localWall(y, m, d), amount, true)
      const p = zonedParts(result.getTime(), hostZone())
      expect([p.year, p.month, p.day]).toEqual(to)
    }
  })

  it("addMonth default (no argument) is clamp — API default is part of the contract", () => {
    const result = addMonth(localWall(2024, 1, 31), 1)
    expect([zonedParts(result.getTime(), hostZone()).day]).toEqual([29])
  })
})

describe("year arithmetic carries the month-end rule", () => {
  it("Feb 29 leap -> Feb 28 under clamp, Mar 1 under forward (paired)", () => {
    const leap = localWall(2024, 2, 29)
    const clamped = addYear(leap, 1, false)
    const forwarded = addYear(leap, 1, true)
    const p1 = zonedParts(clamped.getTime(), hostZone())
    const p2 = zonedParts(forwarded.getTime(), hostZone())
    expect([p1.year, p1.month, p1.day]).toEqual([2025, 2, 28])
    expect([p2.year, p2.month, p2.day]).toEqual([2025, 3, 1])
  })

  it("Feb 28 non-leap -> Feb 28 under both modes (paired control)", () => {
    const nonLeap = localWall(2023, 2, 28)
    for (const overflow of [false, true]) {
      const p = zonedParts(addYear(nonLeap, 1, overflow).getTime(), hostZone())
      expect([p.year, p.month, p.day]).toEqual([2024, 2, 28])
    }
  })

  it("four-year round trip from a leap day clamps twice and stays consistent", () => {
    const d = localWall(2024, 2, 29, 6, 0)
    const back = addYear(addYear(d, 4, false), -4, false)
    const p = zonedParts(back.getTime(), hostZone())
    expect([p.year, p.month, p.day, p.hour]).toEqual([2024, 2, 29, 6])
  })
})

describe("leap year and month-length oracle primitives", () => {
  it("2000 is a leap year, 1900 is not, 2024 is, 2023 is not", () => {
    expect(isLeapYear(2000)).toBe(true)
    expect(isLeapYear(1900)).toBe(false)
    expect(isLeapYear(2024)).toBe(true)
    expect(isLeapYear(2023)).toBe(false)
    expect(daysInMonth(2024, 2)).toBe(29)
    expect(daysInMonth(2023, 2)).toBe(28)
    expect(monthDays(localWall(2024, 2, 15))).toBe(29)
    expect(monthDays(localWall(2023, 2, 15))).toBe(28)
  })
})

describe("weeks are 7 calendar days anchored on the weekday", () => {
  it("weekStart/weekEnd agree with the independent weekday oracle for every week-start day", () => {
    const d = localWall(2024, 2, 14, 15, 45, 30, 500) // Wednesday
    for (let anchor = 0; anchor <= 6; anchor++) {
      const s = weekStart(d, anchor)
      const e = weekEnd(d, anchor)
      const ps = zonedParts(s.getTime(), hostZone())
      const pe = zonedParts(e.getTime(), hostZone())
      expect(ps.weekday).toBe(anchor)
      expect(pe.weekday).toBe((anchor + 6) % 7)
      expect([ps.hour, ps.minute, ps.second, ps.millisecond]).toEqual([0, 0, 0, 0])
      expect([pe.hour, pe.minute, pe.second, pe.millisecond]).toEqual([23, 59, 59, 999])
      // Oracle calendar math: exactly 6 days between start and end dates.
      const ordinal = (p: { year: number; month: number; day: number }) =>
        Date.UTC(p.year, p.month - 1, p.day)
      expect(ordinal(pe) - ordinal(ps)).toBe(6 * 86_400_000)
    }
  })

  it("calendarWeekday oracle matches Date.UTC weekday for boundary dates", () => {
    expect(calendarWeekday(2024, 1, 1)).toBe(1) // Monday
    expect(calendarWeekday(2024, 12, 31)).toBe(2) // Tuesday
    expect(calendarWeekday(2000, 2, 29)).toBe(2) // Tuesday
  })
})

describe("startOf / endOf adjacency uses Tempo's closed-interval precision", () => {
  // Tempo boundaries are a CLOSED wall interval [start 00:00:00.000,
  // end 23:59:59.999]. Consequences, asserted as pairs:
  //  - end is strictly before next start, with a 1ms open gap;
  //  - end + 1ms lands exactly on the next boundary start;
  //  - monthEnd preserves the input time-of-day (documented), so its last-ms
  //    adjacency to monthStart is checked by forcing end of day.
  it("day: dayEnd + 1ms === following dayStart", () => {
    const d = localWall(2024, 2, 29, 18, 0)
    const end = dayEnd(d)
    const nextStart = dayStart(addDay(d, 1))
    expect(nextStart.getTime() - end.getTime()).toBe(1)
    expect(new Date(end.getTime() + 1).getTime()).toBe(nextStart.getTime())
  })

  it("day boundary fields are midnight vs 23:59:59.999 (closed interval pair)", () => {
    const d = localWall(2024, 2, 29, 7, 7, 7, 7)
    const ps = zonedParts(dayStart(d).getTime(), hostZone())
    const pe = zonedParts(dayEnd(d).getTime(), hostZone())
    expect([ps.hour, ps.minute, ps.second, ps.millisecond]).toEqual([0, 0, 0, 0])
    expect([pe.hour, pe.minute, pe.second, pe.millisecond]).toEqual([23, 59, 59, 999])
  })

  it("month: end-of-day on the last day + 1ms === next month start", () => {
    for (const [y, m] of [[2024, 2], [2023, 2], [2024, 12]] as const) {
      const end = dayEnd(monthEnd(localWall(y, m, 10, 12, 0)))
      const nextStart = monthStart(addMonth(localWall(y, m, 10), 1, true))
      expect(nextStart.getTime() - end.getTime()).toBe(1)
      const pe = zonedParts(monthEnd(localWall(y, m, 10)).getTime(), hostZone())
      expect(pe.day).toBe(daysInMonth(y, m)) // monthEnd keeps time-of-day
    }
  })

  it("year: yearEnd + 1ms === next year start", () => {
    const d = localWall(2024, 6, 1)
    expect(yearStart(addYear(d, 1)).getTime() - yearEnd(d).getTime()).toBe(1)
  })

  it("week: end-of-day Saturday + 1ms === next week's anchored start", () => {
    const d = localWall(2024, 2, 14) // Wednesday
    const end = dayEnd(weekEnd(d, 1)) // Monday-anchored week
    const nextStart = weekStart(addDay(d, 7), 1)
    expect(nextStart.getTime() - end.getTime()).toBe(1)
  })
})

describe("add / diff inverse relations, declared per unit and overflow mode", () => {
  // FIXED DURATION units invert exactly; CALENDAR units invert only where
  // clamping never triggers; the composite add() runs calendar units before
  // fixed units for negative durations, after for positive ones.
  it("day/week units are invertible on non-transition days", () => {
    const d = localWall(2024, 6, 15, 9, 30)
    expect(addDay(addDay(d, 10), -10).getTime()).toBe(d.getTime())
    expect(diffDays(addDay(d, 7), d)).toBe(7)
    expect(diffWeeks(addDay(d, 14), d)).toBe(2)
  })

  it("month addition is invertible under FORWARD when starting on day 1..28", () => {
    const d = localWall(2023, 6, 15)
    expect(addMonth(addMonth(d, 8, true), -8, true).getTime()).toBe(d.getTime())
    expect(diffMonths(addMonth(d, 8, true), d)).toBe(8)
  })

  it("clamp is lossy at month ends: add then diff does not always return the amount", () => {
    // Jan 31 +1m (clamp) = Feb 29; diffMonths(Feb 29, Jan 31) must be handled
    // by the documented last-day rule — assert the committed behavior, and the
    // FORWARD counterpart separately.
    const d = localWall(2024, 1, 31)
    const clamped = addMonth(d, 1, false)
    expect(diffMonths(clamped, d)).toBe(1) // last-day rule: a full month passed
    const forwarded = addMonth(d, 1, true)
    expect(diffMonths(forwarded, d)).toBe(1) // Mar 2 vs Jan 31
  })

  it("diffMonths uses the last-day rule (Tempo's documented calendar semantics)", () => {
    expect(diffMonths(localWall(2024, 2, 29), localWall(2024, 1, 31))).toBe(1)
    expect(diffMonths(localWall(2024, 2, 28), localWall(2024, 1, 31))).toBe(0)
    expect(diffMonths(localWall(2024, 4, 30), localWall(2024, 3, 31))).toBe(1)
    expect(diffMonths(localWall(2024, 2, 27), localWall(2024, 1, 31))).toBe(0)
  })

  it("diffYears is trunc(diffMonths / 12) — never its own calendar guess", () => {
    expect(diffYears(localWall(2026, 2, 28), localWall(2024, 2, 29))).toBe(2) // last-day rule
    expect(diffYears(localWall(2035, 2, 28), localWall(2024, 2, 29))).toBe(11)
    expect(diffYears(localWall(2026, 2, 27), localWall(2024, 2, 29))).toBe(1) // 23 full months -> 1
  })

  it("composite add: negative calendar parts apply before fixed parts, positive after", () => {
    // Order matters across DST/overflow; the two equivalent formulations below
    // are pinned against independent oracle math on a safe (June) date.
    const d = localWall(2024, 6, 15, 12, 0)
    const plus = add(d, { months: 1, hours: 2 })
    const pp = zonedParts(plus.getTime(), hostZone())
    expect([pp.month, pp.day, pp.hour]).toEqual([7, 15, 14])
    const minus = add(d, { months: -1, hours: -2 })
    const pm = zonedParts(minus.getTime(), hostZone())
    expect([pm.month, pm.day, pm.hour]).toEqual([5, 15, 10])
  })

  it("composite add honors overflow flag for month/year parts (forward vs clamp pair)", () => {
    const d = localWall(2024, 1, 31, 12, 0)
    const clamp = zonedParts(add(d, { months: 1 }, false).getTime(), hostZone())
    const forward = zonedParts(add(d, { months: 1 }, true).getTime(), hostZone())
    expect([clamp.month, clamp.day]).toEqual([2, 29])
    expect([forward.month, forward.day]).toEqual([3, 2])
  })

  it("diff then add reconstructs the target with calendar units on safe dates", () => {
    const a = localWall(2024, 6, 15, 12, 0)
    const b = localWall(2025, 8, 20, 16, 30)
    const months = diffMonths(b, a)
    const afterMonths = addMonth(a, months, true)
    const restDays = diffDays(b, afterMonths)
    const rebuiltDay = addDay(afterMonths, restDays)
    // Remaining elapsed milliseconds complete the reconstruction exactly.
    const finalDate = new Date(rebuiltDay.getTime() + diffMilliseconds(b, rebuiltDay))
    expect(finalDate.getTime()).toBe(b.getTime())
  })
})
