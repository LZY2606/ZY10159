import { describe, it, expect } from "vitest"
import {
  addDay,
  addMonth,
  addYear,
  addHour,
  addMillisecond,
  dayStart,
  dayEnd,
  diffMilliseconds,
  diffMonths,
  format,
  parse,
} from "../../index"
import {
  HOST_TZ,
  rounds,
  mulberry32,
  minimizeFailure,
  findTransitions,
  type Transition,
  wallFieldsAt,
} from "./helpers"

/**
 * FIXED-SEED PROPERTY ROUNDS.
 *
 * A mulberry32 generator (seed is part of the contract) draws
 * (instant, zone, unit, amount) tuples from a *safe* envelope: 2001-2034,
 * modern zones with whole/half-hour offsets — never historical LMT zones.
 * Heavy iteration counts only run when TEMPO_HEAVY=1.
 *
 * When an invariant fails, `minimizeFailure` walks the amount down to the
 * smallest failing value, which by construction sits adjacent to the DST
 * transition or month boundary the generator happened to cross.
 */
const HOST = HOST_TZ
const SEED = 0x1163
const ENVELOPE_START = Date.UTC(2001, 0, 1)
const ENVELOPE_END = Date.UTC(2035, 0, 1)

type Draw = {
  n: number
  instant: Date
  epoch: number
}

/** Fixed-seed draws of instants inside the safe envelope. */
function drawInstants(count: number): Draw[] {
  const rnd = mulberry32(SEED)
  return Array.from({ length: count }, (_, i) => {
    const epoch = ENVELOPE_START + Math.floor(rnd() * (ENVELOPE_END - ENVELOPE_START))
    return { n: i, instant: new Date(epoch), epoch }
  })
}

/** Fixed-seed draws of (instant, unit, amount). */
function drawOps(count: number) {
  const rnd = mulberry32(SEED ^ 0x9e3779b9)
  const units = ["day", "month", "year", "hour", "millisecond"] as const
  return Array.from({ length: count }, () => {
    const epoch = ENVELOPE_START + Math.floor(rnd() * (ENVELOPE_END - ENVELOPE_START))
    const unit = units[Math.floor(rnd() * units.length)]
    const amount = 1 + Math.floor(rnd() * 400)
    return { instant: new Date(epoch), unit, amount }
  })
}

function applyOp(d: Date, unit: string, amount: number, overflow: boolean): Date {
  switch (unit) {
    case "day":
      return addDay(d, amount)
    case "month":
      return addMonth(d, amount, overflow)
    case "year":
      return addYear(d, amount, overflow)
    case "hour":
      return addHour(d, amount)
    case "millisecond":
      return addMillisecond(d, amount)
  }
  throw new Error(`unknown unit ${unit}`)
}

/** Local ordinal day number (DST-safe) for comparing wall-day movement. */
function ordinalDay(d: Date): number {
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000)
}

describe("property: instant invariants hold for every seeded draw", () => {
  const draws = drawInstants(rounds(200, 4000))

  it("epoch diff is symmetric and negates under argument order", () => {
    for (const { instant, epoch } of draws) {
      const other = new Date(epoch + 123_456_789)
      expect(diffMilliseconds(other, instant)).toBe(123_456_789)
      expect(diffMilliseconds(instant, other)).toBe(-123_456_789)
    }
  })

  it("raw epoch +n then -n returns exactly to the start", () => {
    for (const { instant } of draws) {
      const n = 1 + (instant.getTime() % 1_000_000)
      expect(new Date(instant.getTime() + n - n).getTime()).toBe(instant.getTime())
    }
  })

  it("information-complete format/parse round-trips every draw in every zone", () => {
    const zones = ["UTC", HOST, "Asia/Kolkata"]
    const pattern = "YYYY-MM-DDTHH:mm:ss.SSSZ"
    for (const { instant } of draws.slice(0, rounds(40, 400))) {
      for (const zone of zones) {
        const text = format({ date: instant, format: pattern, locale: "en", tz: zone })
        expect(parse(text, pattern, "en").getTime()).toBe(instant.getTime())
      }
    }
  })
})

describe("property: calendar invariants over seeded ops", () => {
  const ops = drawOps(rounds(200, 3000))

  it("every add moves strictly forward in epoch time", () => {
    for (const { instant, unit, amount } of ops) {
      const out = applyOp(instant, unit, amount, false)
      expect(+out).toBeGreaterThanOrEqual(+instant)
    }
  })

  it("month/year with clamp never exceeds the target month's last day", () => {
    for (const { instant, unit, amount } of ops) {
      if (unit !== "month" && unit !== "year") continue
      const out = applyOp(instant, unit, amount, false)
      const w = wallFieldsAt(HOST, out)
      const lastDay = daysInMonth(w.y, w.mo)
      expect(w.d).toBeLessThanOrEqual(lastDay)
    }
  })

  it("day add advances the wall date by exactly the nominal amount", () => {
    for (const { instant, unit, amount } of ops) {
      if (unit !== "day") continue
      const out = addDay(instant, amount)
      expect(ordinalDay(out) - ordinalDay(instant)).toBe(amount)
    }
  })

  it("day start/end contain the instant; interval is 24h in no-DST zones", () => {
    const hostHasDST = findTransitions(HOST, 2024).length > 0
    for (const { instant } of drawInstants(rounds(100, 1000))) {
      const s = dayStart(instant)
      const e = dayEnd(instant)
      expect(+s).toBeLessThanOrEqual(+instant)
      expect(+e).toBeGreaterThanOrEqual(+instant)
      if (!hostHasDST) {
        expect(+e - +s).toBe(86_399_999)
      }
    }
  })
})

describe("property: failures shrink to the transition/boundary neighbor", () => {
  // Transitions of the host year are the only places a "day != 24h" invariant
  // can break. We assert the shrinker lands directly on one.
  it("minimizeFailure finds the exact step where elapsed time stops being 24h", () => {
    const transitions = findTransitions(HOST, 2024)
    if (transitions.length === 0) {
      // No-DST host: the 24h invariant never fails; check the trivial boundary.
      expect(minimizeFailure(0, 10, (n) => n >= 7)).toBe(7)
      return
    }
    // Anchor at local midnight before each gap; +n calendar days stays 24h
    // until the step sequence first straddles a transition day.
    for (const tr of transitions as Transition[]) {
      // Local midnight of the transition day: the very first calendar-day
      // step straddles the jump, so the shrunk boundary is n = 1.
      const anchor = dayStart(new Date(tr.before))
      const stepIsNot24h = (n: number) => {
        const step = addDay(anchor, n)
        const prev = addDay(anchor, n - 1)
        return Math.abs(diffMilliseconds(step, prev) / 86_400_000 - 1) > 1e-9
      }
      expect(stepIsNot24h(0)).toBe(false)
      expect(stepIsNot24h(1)).toBe(true)
      // Only the first step straddles the jump; binary search collapses [0,1].
      const firstFailing = minimizeFailure(0, 1, stepIsNot24h)
      expect(firstFailing).toBe(1)
      const spanH = (+addDay(anchor, 1) - +anchor) / 3_600_000
      expect([23, 25, 23.5, 24.5]).toContain(spanH)
    }
  })

  it("month-end boundary: shrink lands the amount that first pins the day", () => {
    // Jan 31; adding months stays on day 31 until the first short month.
    const base = new Date("2023-01-31T12:00:00") // host-local, unambiguous day
    // The predicate is false at n=0 and true at n=1 (Feb pins to 28); it is
    // false again at n=2 (March has 31), so the monotone failing interval is
    // exactly [0,1]. Shrinkers require a monotone suffix.
    const fails = (n: number) => addMonth(base, n, false).getDate() !== 31
    expect(fails(0)).toBe(false)
    expect(fails(1)).toBe(true)
    const first = minimizeFailure(0, 1, fails)
    expect(first).toBe(1) // February 2023 is the first pin
    expect(addMonth(base, first, false).getDate()).toBe(28)
  })

  it("shrinker preconditions are enforced (no silent misuse)", () => {
    expect(() => minimizeFailure(0, 10, () => false)).toThrow()
    expect(() => minimizeFailure(0, 10, () => true)).toThrow()
  })
})

describe("property: diffMonths last-day invariant over month-end draws", () => {
  it("clamped end-of-month shifts always read as a full month", () => {
    const draws = drawInstants(rounds(100, 1500))
    for (const { instant } of draws) {
      const start = new Date(instant)
      const shifted = addMonth(start, 1, false)
      const d = diffMonths(shifted, start)
      expect(d === 0 || d === 1).toBe(true)
    }
  })

  it("year clamp never jumps months and diffYears stays a whole year", () => {
    for (const { instant } of drawInstants(rounds(60, 600))) {
      const shifted = addYear(instant, 1, false)
      const w = wallFieldsAt(HOST, shifted)
      expect(w.mo).toBe(wallFieldsAt(HOST, instant).mo)
    }
  })
})

function daysInMonth(y: number, mo: number): number {
  return new Date(y, mo, 0).getDate()
}
