import { describe, it, expect } from "vitest"
import {
  addDay,
  addMonth,
  addYear,
  addHour,
  addMinute,
  add,
  diffDays,
  diffMonths,
  diffYears,
  diffHours,
  diff,
} from "../../index"
import { HOST_TZ, findTransitions, type Transition } from "./helpers"

/**
 * CALENDAR LAYER.
 * Day/week/month/year units target *wall fields*, not elapsed milliseconds.
 * These ops are host-zone local operations, so DST samples run only when the
 * process zone matches; the multi-TZ subprocess driver executes this file in
 * every covered zone.
 */
const HOST = HOST_TZ

function local(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): Date {
  return new Date(y, mo - 1, d, h, mi, s)
}

describe("calendar day: wall field is preserved, elapsed hours are not 24", () => {
  const transitions = findTransitions(HOST, 2024)
  const runIf = (zone: string) => ({
    transitions,
    skip: HOST !== zone,
  })

  describe("America/New_York", () => {
    const ctx = runIf("America/New_York")
    const [gap, fall] = ctx.transitions

    it("gap pair: +1 day preserves 00:00 wall but spans 23h", () => {
      if (ctx.skip) return
      const start = local(2024, 3, 10, 0) // local midnight of the gap day
      const next = addDay(start, 1)
      expect([next.getMonth() + 1, next.getDate(), next.getHours()]).toEqual([3, 11, 0])
      expect((+next - +start) / 3_600_000).toBe(23)
      // wall nominal and "24 hours added" are the SAME V8 op, both 23h here.
      expect(+addHour(start, 24)).toBe(+next)
    })

    it("fall pair: +1 day preserves 00:00 wall but spans 25h", () => {
      if (ctx.skip) return
      const start = local(2024, 11, 3, 0) // local midnight of the overlap day
      const next = addDay(start, 1)
      expect([next.getMonth() + 1, next.getDate(), next.getHours()]).toEqual([11, 4, 0])
      expect((+next - +start) / 3_600_000).toBe(25)
      expect(+addHour(start, 24)).toBe(+next)
    })

    it("elapsed hours inside the gap day contradict a single 24h rule", () => {
      if (ctx.skip) return
      const start = local(2024, 3, 10, 0)
      const next = addDay(start, 1)
      expect(diffHours(next, start)).toBe(23) // trunc of 23h
      expect(diffDays(next, start, "round")).toBe(1)
      expect(diffDays(next, start)).toBe(0) // default trunc: <24h
    })

    it("autumn overlap gives diffHours = 25 while calendar diffDays rounds to 1", () => {
      if (ctx.skip) return
      const start = local(2024, 11, 3, 0)
      const next = addDay(start, 1)
      expect(diffHours(next, start)).toBe(25)
      expect(diffDays(next, start, "round")).toBe(1)
      expect(diffDays(next, start)).toBe(1) // trunc of 25h
    })

    it("exposes both transitions with opposite signed offsets", () => {
      if (ctx.skip) return
      expect(ctx.transitions).toHaveLength(2)
      expect((gap as Transition).isGap).toBe(true)
      expect((fall as Transition).isGap).toBe(false)
    })
  })

  describe("Europe/Berlin", () => {
    const ctx = runIf("Europe/Berlin")

    it("gap pair: +1 day from 00:00 spans 23h, wall preserved", () => {
      if (ctx.skip) return
      const start = local(2024, 3, 31, 0) // 00:00 CET, gap at 02:00
      const next = addDay(start, 1)
      expect([next.getMonth() + 1, next.getDate(), next.getHours()]).toEqual([4, 1, 0])
      expect((+next - +start) / 3_600_000).toBe(23)
    })

    it("fall pair: +1 day from 00:00 spans 25h, wall preserved", () => {
      if (ctx.skip) return
      const start = local(2024, 10, 27, 0)
      const next = addDay(start, 1)
      expect([next.getMonth() + 1, next.getDate(), next.getHours()]).toEqual([10, 28, 0])
      expect((+next - +start) / 3_600_000).toBe(25)
    })
  })

  describe("Australia/Lord_Howe (half-hour jumps)", () => {
    const ctx = runIf("Australia/Lord_Howe")

    it("spring half-hour gap: calendar day spans 23.5h", () => {
      if (ctx.skip) return
      const start = local(2024, 10, 6, 0) // clocks 02:00 -> 02:30
      const next = addDay(start, 1)
      expect([next.getMonth() + 1, next.getDate(), next.getHours()]).toEqual([10, 7, 0])
      expect((+next - +start) / 3_600_000).toBe(23.5)
    })

    it("autumn half-hour fall: calendar day spans 24.5h", () => {
      if (ctx.skip) return
      const start = local(2024, 4, 7, 0) // clocks 02:00 -> 01:30
      const next = addDay(start, 1)
      expect([next.getMonth() + 1, next.getDate(), next.getHours()]).toEqual([4, 8, 0])
      expect((+next - +start) / 3_600_000).toBe(24.5)
    })

    it("wall-nominal minute arithmetic skips the missing 30 minutes", () => {
      if (ctx.skip) return
      const start = local(2024, 10, 6, 1, 45)
      const plus60 = addMinute(start, 60)
      expect([plus60.getHours(), plus60.getMinutes()]).toEqual([2, 45])
      // only 30 actual minutes elapsed for a 60 nominal-minute step
      expect((+plus60 - +start) / 60_000).toBe(30)
    })

    it("wall-nominal minute arithmetic repeats 30 minutes in autumn", () => {
      if (ctx.skip) return
      const start = local(2024, 4, 7, 1, 15)
      const plus60 = addMinute(start, 60)
      expect([plus60.getHours(), plus60.getMinutes()]).toEqual([2, 15])
      expect((+plus60 - +start) / 60_000).toBe(90)
    })
  })

  describe("no-DST zones", () => {
    it("UTC: calendar days are always exactly 24h", () => {
      if (HOST !== "UTC") return
      const start = local(2024, 3, 10, 0)
      expect((+addDay(start, 1) - +start) / 3_600_000).toBe(24)
      expect(findTransitions(HOST, 2024)).toHaveLength(0)
    })

    it("Asia/Kolkata: +11:00? no — stable +05:30, every day is 24h", () => {
      if (HOST !== "Asia/Kolkata") return
      const start = local(2024, 3, 10, 0)
      expect((+addDay(start, 1) - +start) / 3_600_000).toBe(24)
      expect(findTransitions(HOST, 2024)).toHaveLength(0)
    })
  })
})

describe("calendar month: wall day target and overflow strategies", () => {
  it("clamps to last day by default (backward/clamp strategy)", () => {
    expect(+addMonth(local(2020, 1, 31), 1)).toBe(+local(2020, 2, 29))
    expect(+addMonth(local(2023, 1, 31), 1)).toBe(+local(2023, 2, 28))
    expect(+addMonth(local(2024, 4, 30), 1)).toBe(+local(2024, 5, 30))
  })

  it("overflows forward when dateOverflow=true", () => {
    expect(+addMonth(local(2020, 1, 31), 1, true)).toBe(+local(2020, 3, 2))
    expect(+addMonth(local(2023, 1, 31), 1, true)).toBe(+local(2023, 3, 3))
  })

  it("leap day pairs: Feb 29 -> Feb 28 in common years, Feb 29 in leap years", () => {
    expect(+addYear(local(2020, 2, 29), 1, false)).toBe(+local(2021, 2, 28))
    expect(+addYear(local(2020, 2, 29), 4, false)).toBe(+local(2024, 2, 29))
    expect(+addYear(local(2020, 2, 29), 1, true)).toBe(+local(2021, 3, 1))
  })

  it("preserves wall time fields across a month step (host zone)", () => {
    const start = local(2024, 1, 15, 10, 30, 45)
    const out = addMonth(start, 1)
    expect([
      out.getFullYear(),
      out.getMonth(),
      out.getDate(),
      out.getHours(),
      out.getMinutes(),
      out.getSeconds(),
    ]).toEqual([2024, 1, 15, 10, 30, 45])
  })

  it("negative months apply calendar units first in add() (no overflow surprise)", () => {
    // Jan 31 - 1 month under clamp = Dec 31.
    expect(+add(local(2024, 1, 31), { months: -1 }, false)).toBe(+local(2023, 12, 31))
  })
})

describe("calendar inverse relations (declared per unit + overflow)", () => {
  it("month clamp: add then diff is exact away from end-of-month pinning", () => {
    const bases = [
      local(2023, 1, 15),
      local(2024, 2, 29), // leap start
      local(2023, 6, 30),
    ]
    for (const base of bases) {
      for (const n of [1, 3, 6, 12, -2, -5]) {
        const shifted = addMonth(base, n, false)
        expect(diffMonths(shifted, base)).toBe(n)
      }
    }
  })

  it("diffMonths last-day rule: Feb 28 counts a full month from Jan 31", () => {
    // diffMonths treats a last-day-of-month endpoint specially: a full month
    // IS considered to have elapsed when the later date is its month's last
    // day, even though 28 < 31. This is why add/diff line up for clamping.
    expect(diffMonths(local(2023, 2, 28), local(2023, 1, 31))).toBe(1)
    // The rule triggers on the ENDPOINT being its month's last day, so it also
    // holds from Jan 30 (28 is still Feb's last day).
    expect(diffMonths(local(2023, 2, 28), local(2023, 1, 30))).toBe(1)
    // Mar 28 is not March's last day, but 28 < 31 is only re-checked against
    // the earlier month; here one full calendar month still elapsed.
    expect(diffMonths(local(2023, 3, 28), local(2023, 1, 31))).toBe(1)
    // Ending on Feb 27 (not the last day) before Jan 31 counts zero.
    expect(diffMonths(local(2023, 2, 27), local(2023, 1, 31))).toBe(0)
  })

  it("month add/diff inverse holds for both overflow strategies", () => {
    for (const overflow of [false, true]) {
      const base = local(2023, 1, 31)
      expect(diffMonths(addMonth(base, 1, overflow), base)).toBe(1)
    }
  })

  it("month add is NOT an involution under clamp (end-of-month pinning)", () => {
    // The defect class this guards: clamp +1 then -1 collapses Jan 31 -> Jan 28
    // because the intermediate Feb 28 cannot recover the original day.
    const base = local(2023, 1, 31)
    const roundTrip = addMonth(addMonth(base, 1, false), -1, false)
    expect(+roundTrip).toBe(+local(2023, 1, 28))
    expect(+roundTrip).not.toBe(+base)
    // Overflow mode at least keeps a stable forward path (Mar 3 -> Feb 3).
    const rtOverflow = addMonth(addMonth(base, 1, true), -1, true)
    expect(+rtOverflow).toBe(+local(2023, 2, 3))
  })

  it("Feb 29 + 1 year: clamp and overflow both count a full elapsed year", () => {
    // diffMonths' last-day rule means the clamped Feb 28 still reads as a
    // year; the distinction is the resulting wall day, asserted separately.
    expect(+addYear(local(2020, 2, 29), 1, false)).toBe(+local(2021, 2, 28))
    expect(+addYear(local(2020, 2, 29), 1, true)).toBe(+local(2021, 3, 1))
    expect(diffYears(addYear(local(2020, 2, 29), 1, false), local(2020, 2, 29))).toBe(1)
    expect(diffYears(addYear(local(2020, 2, 29), 1, true), local(2020, 2, 29))).toBe(1)
  })

  it("day inverse via trunc holds outside DST; inside it must be declared per rounding", () => {
    if (HOST === "America/New_York") {
      const gapStart = local(2024, 3, 10, 0)
      const shifted = addDay(gapStart, 1)
      expect(diffDays(shifted, gapStart)).toBe(0) // trunc: 23h
      expect(diffDays(shifted, gapStart, "ceil")).toBe(1)
      const fallStart = local(2024, 11, 3, 0)
      expect(diffDays(addDay(fallStart, 1), fallStart)).toBe(1) // 25h trunc
    } else if (HOST === "UTC" || HOST === "Asia/Kolkata") {
      const start = local(2024, 3, 10, 0)
      expect(diffDays(addDay(start, 1), start)).toBe(1)
    }
  })

  it("composite diff() reconstructs an exact elapsed duration (instant units)", () => {
    const a = new Date(Date.UTC(2024, 0, 1, 0, 0, 0))
    const b = new Date(
      Date.UTC(2024, 0, 1, 0, 0, 0) + ((2 * 24 + 3) * 3_600 + 4 * 60 + 5) * 1000 + 6
    )
    // UTC host: calendar and instant units coincide for this span.
    if (HOST === "UTC") {
      expect(diff(b, a)).toEqual({
        days: 2,
        hours: 3,
        minutes: 4,
        seconds: 5,
        milliseconds: 6,
      })
    }
  })
})
