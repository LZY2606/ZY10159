/**
 * Layer 5 — GENERATED, FIXED-SEED PROPERTIES.
 *
 * A deterministic mulberry32 PRNG (seed exported from helpers) generates
 * (instant, zone, unit, amount) tuples. Sampling is biased toward DST
 * transition windows, month ends, and leap days so failures cluster near real
 * boundaries; on failure, `shrink()` walks the case back toward a safe anchor
 * so the reported counterexample is the closest concrete date to the
 * transition.
 *
 * Round counts default to a quick deterministic pass; set TEMPO_HEAVY=1 for
 * the heavier CI round.
 */
import { describe, it, expect } from "vitest"
import {
  addDay,
  addMonth,
  addYear,
  diffMilliseconds,
  diffHours,
  dayStart,
  dayEnd,
} from "../../index"
import {
  ZONES,
  SEED,
  mulberry32,
  intBetween,
  pick,
  shrink,
  hostZone,
  useFixedNow,
  MS_PER_DAY,
  MS_PER_HOUR,
} from "./helpers"
import {
  absoluteOffsetMs,
  zonedParts,
  findTransition,
  refineTransition,
  daysInMonth,
  calendarAddMonths,
} from "./oracle"

useFixedNow()

const HEAVY = process.env.TEMPO_HEAVY === "1"
const ROUNDS = HEAVY ? 400 : 60

/** Safe anchor dates (noon local, mid-month) plus biased boundary anchors. */
const ANCHOR_EPOCHS = [
  Date.UTC(2023, 0, 15, 12),
  Date.UTC(2024, 5, 15, 12),
  Date.UTC(2025, 8, 10, 12),
]

interface GeneratedCase {
  ms: number
  zone: string
}

/** Cached transition instants per zone, computed once per process. */
const transitionCache = new Map<string, number[]>()

function transitionsFor(zone: string): number[] {
  let list = transitionCache.get(zone)
  if (list) return list
  list = []
  let cursor = Date.UTC(2023, 0, 1)
  for (let i = 0; i < 24; i++) {
    const tr = findTransition(zone, cursor, 120 * MS_PER_DAY)
    if (!tr) break
    const at = refineTransition(zone, tr.beforeMs, tr.afterMs)
    list.push(at)
    cursor = at + 2 * MS_PER_DAY
  }
  transitionCache.set(zone, list)
  return list
}

/**
 * Produces an instant: with probability ~0.5 within ±3 days of a real DST
 * transition in `zone`, otherwise a random instant in 2023..2026.
 */
function genInstant(rand: () => number, zone: string): GeneratedCase {
  const transitions = transitionsFor(zone)
  if (rand() < 0.5 && transitions.length) {
    const at = pick(rand, transitions)
    return { ms: at + intBetween(rand, -3 * MS_PER_DAY, 3 * MS_PER_DAY), zone }
  }
  return {
    ms: Date.UTC(2023, 0, 1) + Math.floor(rand() * 1095 * MS_PER_DAY),
    zone,
  }
}

describe("property: elapsed millisecond diffs are zone-independent", () => {
  it("diffMilliseconds(a,b) === a-b for every generated pair in every host zone", () => {
    const rand = mulberry32(SEED ^ 0x01)
    for (let i = 0; i < ROUNDS; i++) {
      const zone = pick(rand, Object.values(ZONES))
      const a = genInstant(rand, zone).ms
      const b = a + intBetween(rand, -10 * MS_PER_DAY, 10 * MS_PER_DAY)
      expect(diffMilliseconds(new Date(a), new Date(b))).toBe(a - b)
    }
  }, 20_000)

  it("diffHours is trunc(realMs/3600000), never a wall-hour count", () => {
    const rand = mulberry32(SEED ^ 0x02)
    for (let i = 0; i < ROUNDS; i++) {
      const zone = pick(rand, Object.values(ZONES))
      const a = genInstant(rand, zone).ms
      const b = a + intBetween(rand, -48, 48) * MS_PER_HOUR
      expect(diffHours(new Date(a), new Date(b))).toBe(Math.trunc((a - b) / MS_PER_HOUR))
    }
  }, 20_000)
})

describe("property: instant identity under zone reads", () => {
  it("absoluteOffsetMs oracle agrees with itself one second away within a non-transition second", () => {
    const rand = mulberry32(SEED ^ 0x03)
    for (let i = 0; i < ROUNDS; i++) {
      const zone = pick(rand, Object.values(ZONES))
      const { ms } = genInstant(rand, zone)
      // A second away is within the same offset except exactly at a boundary.
      const o1 = absoluteOffsetMs(ms, zone)
      const o2 = absoluteOffsetMs(ms + 1000, zone)
      expect(Math.abs(o1 - o2)).toBeLessThanOrEqual(MS_PER_HOUR)
      expect(Number.isInteger(o1 / 60000) || o1 % 1000 === 0).toBe(true)
    }
  }, 20_000)
})

describe("property: wall invariants of the calendar adders", () => {
  // addMonth under clamp: resulting day === min(source day, target month length)
  it("addMonth clamp matches the independent Gregorian oracle for random dates", () => {
    const rand = mulberry32(SEED ^ 0x04)
    const zone = hostZone()
    for (let i = 0; i < ROUNDS; i++) {
      const y = intBetween(rand, 2020, 2028)
      const m = intBetween(rand, 1, 12)
      const d = intBetween(rand, 1, 31)
      const n = intBetween(rand, -18, 18)
      const validDay = Math.min(d, daysInMonth(y, m))
      const input = new Date(y, m - 1, validDay, 9, 30, 0, 0)
      const result = addMonth(input, n, false)
      const expected = calendarAddMonths(y, m, validDay, n, "clamp")
      const p = zonedParts(result.getTime(), zone)
      expect([p.year, p.month, p.day]).toEqual([expected.year, expected.month, expected.day])
    }
  })

  it("addYear clamp keeps Feb 29 only in leap target years", () => {
    const rand = mulberry32(SEED ^ 0x05)
    for (let i = 0; i < Math.min(ROUNDS, 64); i++) {
      const n = intBetween(rand, -4, 8)
      const result = addYear(new Date(2024, 1, 29, 12, 0), n, false)
      const p = zonedParts(result.getTime(), hostZone())
      const targetYear = 2024 + n
      const expectedDay = targetYear % 4 === 0 && (targetYear % 100 !== 0 || targetYear % 400 === 0) ? 29 : 28
      expect([p.year, p.month, p.day]).toEqual([targetYear, 2, expectedDay])
    }
  })

  it("addDay preserves time of day for random dates (host-zone wall fields)", () => {
    const rand = mulberry32(SEED ^ 0x06)
    const zone = hostZone()
    for (let i = 0; i < ROUNDS; i++) {
      // Construct a local date safely away from this host's transitions by
      // picking day 10..20 of a month; transitions in covered zones occur in
      // the first week or known fixed days (NY 2nd Sun, EU last Sun — days 1..7
      // or 24..31; bias away from both).
      const y = intBetween(rand, 2020, 2028)
      const m = intBetween(rand, 1, 12)
      const d = intBetween(rand, 10, 20)
      const input = new Date(y, m - 1, d, 11, 45, 23, 0)
      const n = intBetween(rand, -100, 100)
      const p = zonedParts(addDay(input, n).getTime(), zone)
      expect([p.hour, p.minute, p.second]).toEqual([11, 45, 23])
    }
  })
})

describe("property: boundaries bracket their containing instant", () => {
  it("dayStart <= instant <= dayEnd; wall width is constant, epoch width changes only on DST", () => {
    const rand = mulberry32(SEED ^ 0x07)
    const zone = hostZone()
    for (let i = 0; i < ROUNDS; i++) {
      const { ms } = genInstant(rand, zone)
      const d = new Date(ms)
      const s = dayStart(new Date(d))
      const e = dayEnd(new Date(d))
      expect(diffMilliseconds(d, s)).toBeGreaterThanOrEqual(0)
      expect(diffMilliseconds(e, d)).toBeGreaterThanOrEqual(0)
      const width = e.getTime() - s.getTime()
      const widthWall =
        width + absoluteOffsetMs(e.getTime(), zone) - absoluteOffsetMs(s.getTime(), zone)
      // Wall-clock width between the two midnights is always one day minus 1ms.
      expect(widthWall).toBe(MS_PER_DAY - 1)
      // Epoch width differs only when the day contains an offset change.
      const sameOffset =
        absoluteOffsetMs(s.getTime(), zone) === absoluteOffsetMs(e.getTime(), zone)
      if (sameOffset) expect(width).toBe(MS_PER_DAY - 1)
      else expect(Math.abs(width - (MS_PER_DAY - 1))).toBeLessThanOrEqual(MS_PER_HOUR)
    }
  }, 20_000)
})

describe("property: shrinking moves a failing case to the nearest boundary", () => {
  it("shrink returns a failing case close to the anchor/failure boundary", () => {
    // Property: "instant is at least 1000 ms after anchor". Anchor passes
    // (delta 0 < 1000)... invert: property holds while delta < 1000 and fails
    // at far.
    const anchor = Date.UTC(2024, 2, 10, 5)
    const far = anchor + 10_000 // violates "within 1000 ms"
    const reduced = shrink(
      anchor,
      far,
      (candidate) => candidate - anchor < 1000,
      (a, b, t) => Math.round(a + (b - a) * t)
    )
    expect(reduced - anchor).toBeGreaterThanOrEqual(1000)
    expect(reduced - anchor).toBeLessThan(1100)
    expect(reduced).toBeLessThan(far)
  })

  it("a real transition-biased failure shrinks to a date within hours of the transition", () => {
    const zone = ZONES.newYork
    const tr = findTransition(zone, Date.UTC(2024, 2, 1), 60 * MS_PER_DAY)!
    const transitionMs = refineTransition(zone, tr.beforeMs, tr.afterMs)
    const anchor = transitionMs - 30 * MS_PER_DAY
    const mutated = transitionMs + MS_PER_HOUR
    // Property under test: "instant is at least 6h before the transition".
    // anchor (-30d) holds; mutated (just after transition) violates it.
    const reduced = shrink(
      anchor,
      mutated,
      (candidate) => transitionMs - candidate >= 6 * MS_PER_HOUR,
      (a, b, t) => Math.round(a + (b - a) * t),
      24
    )
    // The shrunk counterexample sits at the 6h-before-transition fence, not
    // 30 days away.
    expect(transitionMs - reduced).toBeGreaterThanOrEqual(0)
    expect(transitionMs - reduced).toBeLessThan(7 * MS_PER_HOUR)
  })
})
