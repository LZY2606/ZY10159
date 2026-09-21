import { describe, it, expect } from "vitest"
import {
  addDay,
  addHour,
  addMinute,
  addSecond,
  addMillisecond,
  diffMilliseconds,
  diffHours,
} from "../../index"
import { HOST_TZ, findTransitions } from "./helpers"

/**
 * ELAPSED TIME (metamorphic relations across transitions).
 *
 * Tempo's `add*` functions are WALL-NOMINAL setters. The key metamorphic fact:
 *
 *   addDay(d,1) === addHour(d,24) === addMinute(d,1440)
 *               === addSecond(d,86400) === addMillisecond(d,86_400_000)
 *
 * All five target the next wall day and therefore share the SAME elapsed
 * duration — which is 23h in a spring gap and 25h in an autumn overlap (23.5 /
 * 24.5 for a half-hour zone). A single "+1 day === 24 hours" assertion cannot
 * hold and is exactly the class of defect this file exists to catch.
 *
 * True elapsed time is observable two ways: `diffMilliseconds` (epoch subtraction)
 * and raw epoch +n. We assert actual milliseconds, never nominal counts.
 */
const HOST = HOST_TZ
const HOUR = 3_600_000
const MIN = 60_000

function local(y: number, mo: number, d: number, h = 0, mi = 0, s = 0) {
  return new Date(y, mo - 1, d, h, mi, s)
}

/** Whole minutes shown on the host wall clock since the local epoch (ordinal). */
function wallMinutes(d: Date): number {
  return Math.floor(
    Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()) /
      60_000
  )
}

describe("wall-nominal coincidence: every add* targets the same next wall day", () => {
  const dayMs = 86_400_000
  const samples: Array<{
    name: string
    zone: string
    make: () => Date
    expectHours: number
  }> = [
    {
      name: "NY spring gap",
      zone: "America/New_York",
      make: () => local(2024, 3, 10, 0),
      expectHours: 23,
    },
    {
      name: "NY autumn overlap",
      zone: "America/New_York",
      make: () => local(2024, 11, 3, 0),
      expectHours: 25,
    },
    {
      name: "Berlin spring gap",
      zone: "Europe/Berlin",
      make: () => local(2024, 3, 31, 0),
      expectHours: 23,
    },
    {
      name: "Berlin autumn overlap",
      zone: "Europe/Berlin",
      make: () => local(2024, 10, 27, 0),
      expectHours: 25,
    },
    {
      name: "Lord Howe half-hour gap",
      zone: "Australia/Lord_Howe",
      make: () => local(2024, 10, 6, 0),
      expectHours: 23.5,
    },
    {
      name: "Lord Howe half-hour fall",
      zone: "Australia/Lord_Howe",
      make: () => local(2024, 4, 7, 0),
      expectHours: 24.5,
    },
  ]

  for (const sample of samples) {
    describe(sample.name, () => {
      if (HOST !== sample.zone) {
        it.skip(`requires host TZ=${sample.zone} (current ${HOST})`, () => {})
        return
      }

      it("all five add* variants coincide to one instant", () => {
        const d = sample.make()
        const results = [
          +addDay(d, 1),
          +addHour(d, 24),
          +addMinute(d, 1440),
          +addSecond(d, 86400),
          +addMillisecond(d, dayMs),
        ]
        for (const r of results) expect(r).toBe(results[0])
      })

      it("elapsed milliseconds equal the transition-adjusted duration", () => {
        const d = sample.make()
        const next = addDay(d, 1)
        expect(diffMilliseconds(next, d)).toBe(sample.expectHours * HOUR)
        expect(diffHours(next, d)).toBe(Math.trunc(sample.expectHours))
      })

      it("the result preserves 00:00:00.000 wall fields (calendar target)", () => {
        const next = addDay(sample.make(), 1)
        expect([
          next.getHours(),
          next.getMinutes(),
          next.getSeconds(),
          next.getMilliseconds(),
        ]).toEqual([0, 0, 0, 0])
      })
    })
  }

  it("UTC and Asia/Kolkata (no DST): every nominal day is exactly 24h", () => {
    if (HOST !== "UTC" && HOST !== "Asia/Kolkata") return
    const d = local(2024, 3, 10, 0)
    expect(+addDay(d, 1)).toBe(d.getTime() + dayMs)
    expect(+addMillisecond(d, dayMs)).toBe(+addDay(d, 1))
    expect(findTransitions(HOST, 2024)).toHaveLength(0)
  })
})

describe("paired samples at the transition instant (gap vs fall-back)", () => {
  it("Lord Howe: a 60 nominal-minute step spans 30 actual min in gap, 90 in fall", () => {
    if (HOST !== "Australia/Lord_Howe") return
    const gapStart = local(2024, 10, 6, 1, 45)
    const gapPlus = addMinute(gapStart, 60)
    // Wall target: 01:45 + 60 nominal minutes = 02:45 (02:15-02:45 gap skipped).
    expect([gapPlus.getHours(), gapPlus.getMinutes()]).toEqual([2, 45])
    // Nominal wall minutes come from wall fields, NOT diffMinutes (which
    // truncates elapsed ms and reports 30 here).
    expect(wallMinutes(gapPlus) - wallMinutes(gapStart)).toBe(60)
    expect(diffMilliseconds(gapPlus, gapStart) / MIN).toBe(30) // actual

    const fallStart = local(2024, 4, 7, 1, 15)
    const fallPlus = addMinute(fallStart, 60)
    expect([fallPlus.getHours(), fallPlus.getMinutes()]).toEqual([2, 15])
    expect(wallMinutes(fallPlus) - wallMinutes(fallStart)).toBe(60)
    expect(diffMilliseconds(fallPlus, fallStart) / MIN).toBe(90)
  })

  it("New York: a 60 nominal-minute step that crosses the whole gap is 60 actual", () => {
    if (HOST !== "America/New_York") return
    // 01:30 + 60 nominal minutes targets wall 02:30, which after the jump is
    // 03:30 EDT; the skipped hour means this still takes only 60 real minutes
    // (01:30 EST -> 03:30 EDT = 06:30Z - 05:30Z).
    const atGap = local(2024, 3, 10, 1, 30)
    const p = addMinute(atGap, 60)
    expect([p.getHours(), p.getMinutes()]).toEqual([3, 30])
    expect(wallMinutes(p) - wallMinutes(atGap)).toBe(120) // wall clock advanced 2h
    expect(diffMilliseconds(p, atGap) / MIN).toBe(60) // only 60 actually elapsed
  })

  it("raw epoch +24h must NOT equal the calendar day across any transition", () => {
    const table: Record<string, Array<[number, number, number]>> = {
      "America/New_York": [
        [2024, 3, 10],
        [2024, 11, 3],
      ],
      "Europe/Berlin": [
        [2024, 3, 31],
        [2024, 10, 27],
      ],
      "Australia/Lord_Howe": [
        [2024, 10, 6],
        [2024, 4, 7],
      ],
    }
    const rows = table[HOST]
    if (!rows) return
    for (const [y, mo, d] of rows) {
      const start = local(y, mo, d, 0)
      const calendar = +addDay(start, 1)
      const elapsed = start.getTime() + 86_400_000
      expect(calendar).not.toBe(elapsed)
    }
  })
})

describe("transition scanner agrees with the hand-authored fixed samples", () => {
  it("finds a gap and a fall-back with equal-magnitude offset change", () => {
    const t = findTransitions(HOST, 2024)
    if (t.length === 0) {
      expect(["UTC", "Asia/Kolkata"]).toContain(HOST)
      return
    }
    expect(t.length).toBeGreaterThanOrEqual(2)
    const gaps = t.filter((x) => x.isGap).map((x) => Math.abs(x.deltaMin))
    const falls = t.filter((x) => !x.isGap).map((x) => Math.abs(x.deltaMin))
    expect(gaps.length).toBeGreaterThan(0)
    expect(falls.length).toBeGreaterThan(0)
    // Half-hour zone jumps by 30; hour zones by 60.
    const expected = HOST === "Australia/Lord_Howe" ? 30 : 60
    expect([...gaps, ...falls].every((m) => m === expected)).toBe(true)
  })
})
