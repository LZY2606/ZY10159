/**
 * Layer 3b — COMPOSITE diff() DECOMPOSITION.
 *
 * `diff(later, earlier)` returns a positive Duration broken into years,
 * months, weeks, days, hours, minutes, seconds, milliseconds. Calendar units
 * come first (with the last-day rule), fixed-duration units carry the exact
 * remainder. Argument order flips every field's sign; `abs` removes that sign.
 *
 * The inverse relation with `add()` is stated per case: on safe (non-clamping)
 * dates the duration reconstructs the target exactly; month-end pairs are
 * documented by their committed last-day/remainder breakdown rather than
 * assumed invertible.
 */
import { describe, it, expect } from "vitest"
import { add, diff, addMillisecond, diffMonths } from "../../index"
import { hostZone, useFixedNow } from "./helpers"
import { zonedParts } from "./oracle"

useFixedNow()

function localWall(y: number, mo: number, d: number, h = 12, mi = 0, s = 0, ms = 0) {
  return new Date(y, mo - 1, d, h, mi, s, ms)
}

describe("diff() decomposition reconstructs exactly on safe days", () => {
  it("add(earlier, diff(later, earlier), forward).getTime() === later", () => {
    const pairs: Array<[Date, Date]> = [
      // [later, earlier]
      [localWall(2025, 8, 20, 16, 30, 45, 250), localWall(2024, 6, 15, 12, 0, 0, 0)],
      [localWall(2024, 1, 2), localWall(2024, 1, 1)],
      [localWall(2024, 2, 29, 8, 15), localWall(2023, 11, 10, 6, 0)],
      [localWall(2024, 6, 15, 12, 30), localWall(2024, 6, 15)], // same calendar day
    ]
    for (const [later, earlier] of pairs) {
      const duration = diff(later, earlier)
      expect(add(new Date(earlier), duration, true).getTime()).toBe(later.getTime())
    }
  })

  it("diff is antisymmetric: diff(a,b) is the field-wise negation of diff(b,a)", () => {
    const a = localWall(2024, 6, 15, 9, 0)
    const b = localWall(2025, 2, 3, 14, 45)
    const ab = diff(a, b) // a < b -> negative
    const ba = diff(b, a) // positive
    for (const key of Object.keys(ba) as Array<keyof typeof ba>) {
      expect(ab[key]).toBe(-(ba[key] ?? 0))
    }
  })

  it("abs yields a positive breakdown regardless of argument order", () => {
    const later = localWall(2024, 1, 1)
    const earlier = localWall(2023, 1, 1)
    const d = diff(earlier, later, { abs: true }) // earlier < later, but abs
    expect(Object.values(d).every((v) => (v ?? 0) >= 0)).toBe(true)
    expect(d.years).toBe(1)
  })
})

describe("diff() skip removes units and shifts magnitude down", () => {
  it("skipping weeks surfaces the span as days", () => {
    const later = localWall(2024, 6, 17) // +14 days
    const earlier = localWall(2024, 6, 3)
    const withWeeks = diff(later, earlier)
    const noWeeks = diff(later, earlier, { skip: ["weeks"] })
    expect(withWeeks.weeks).toBe(2)
    expect(noWeeks.weeks).toBeUndefined()
    expect(noWeeks.days).toBe(14)
  })

  it("skip accepts a Set as well as an array", () => {
    const later = localWall(2025, 6, 1)
    const earlier = localWall(2024, 6, 1)
    const d = diff(later, earlier, { skip: new Set(["years", "months", "weeks"]) })
    expect(d.years).toBeUndefined()
    expect(d.months).toBeUndefined()
    expect(d.weeks).toBeUndefined()
    expect((d.days ?? 0) >= 365).toBe(true)
  })
})

describe("diff() month-end/leap pairs: calendarDiff backs out partial months", () => {
  // The standalone diffMonths() applies the last-day rule, but the composite
  // diff() only keeps a calendar unit when subtracting it does not overshoot
  // the target; clamps that overshoot back the month out into weeks/days.
  it("Jan 31 -> Feb 29 (leap) decomposes into weeks+days, NOT a month (backout)", () => {
    const d = diff(localWall(2024, 2, 29), localWall(2024, 1, 31))
    expect(d.months ?? 0).toBe(0)
    expect(d).toEqual({ weeks: 4, days: 1 })
  })

  it("Jan 31 -> Feb 28 (non-leap) is exactly four weeks under backout", () => {
    const d = diff(localWall(2023, 2, 28), localWall(2023, 1, 31))
    expect(d).toEqual({ weeks: 4 })
  })

  it("the same pair reports 1 under the standalone last-day rule (declared separately)", () => {
    // The two functions legitimately disagree here; the matrix pins both.
    expect(diffMonths(localWall(2024, 2, 29), localWall(2024, 1, 31))).toBe(1)
  })

  it("full years still appear when no clamp overshoots: Feb 28 -> Feb 28 is one year", () => {
    const d = diff(localWall(2025, 2, 28), localWall(2024, 2, 28))
    expect(d.years).toBe(1)
  })
})

describe("fixed-duration tail is exact milliseconds", () => {
  it("same calendar instant differing only in ms leaves seconds+milliseconds", () => {
    const earlier = localWall(2024, 6, 15, 12, 0, 0, 0)
    const later = addMillisecond(new Date(earlier), 12345)
    const d = diff(later, earlier)
    expect(d).toEqual({ seconds: 12, milliseconds: 345 })
  })

  it("23.5h actual elapsed across the NY gap breaks into 23h + 30m + 500ms in a +00:00 host", () => {
    // The fixed-unit tail of the composite diff operates on host Dates; to
    // state the actual-ms contract without coupling to host calendar removal,
    // this precise breakdown is pinned in the UTC process (the runner covers
    // it); other zones are covered by the instant-layer diffHours pairs.
    if (hostZone() !== "UTC") return
    const earlier = new Date("2024-03-10T05:00:00.000Z")
    const later = new Date("2024-03-11T04:30:00.500Z")
    const d = diff(later, earlier, { skip: ["years", "months", "weeks", "days"] })
    expect(d.hours).toBe(23)
    expect(d.minutes).toBe(30)
    expect(d.milliseconds).toBe(500)
    expect(zonedParts(earlier.getTime(), hostZone()).hour).toBe(5)
  })
})
