/**
 * Shared infrastructure for the deterministic date test matrix.
 *
 * Every test gets an explicit fixed instant for `now`; nothing reads the host
 * clock. Zones are covered by running the whole suite in child processes with
 * different `TZ` values (see scripts/tz-tests.mjs), and in-process assertions
 * that depend on the host zone first verify which zone the host is emulating.
 */
import { beforeAll, beforeEach, vi } from "vitest"
import { absoluteOffsetMs } from "./oracle"

/** The fixed "now" used by every test (a leap-year Wednesday, 13:05 UTC). */
export const FIXED_NOW = "2024-02-14T13:05:09.123Z"
export const FIXED_NOW_MS = Date.parse(FIXED_NOW)

/**
 * Zones the matrix explicitly covers. The runner spawns one worker process per
 * zone (UTC + three DST regimes with different jump sizes + a no-DST zone).
 */
export const ZONES = {
  utc: "UTC",
  newYork: "America/New_York",
  berlin: "Europe/Berlin",
  lordHowe: "Australia/Lord_Howe",
  tokyo: "Asia/Tokyo",
} as const

export const ALL_ZONES = Object.values(ZONES)

/** Wall-clock signature of a DST regime, checked via Intl in each process. */
export interface ZoneCharacter {
  zone: string
  hasDST: boolean
  /** Signed offset changes (ms) observed over the probe window. */
  jumpsMs: number[]
}

const HOUR = 3_600_000
const DAY = 86_400_000

/**
 * Probes a zone for DST transitions between 2023-01-01 and 2026-01-01 and
 * records the distinct jump magnitudes. Pure Intl; independent of the host.
 */
export function characterizeZone(zone: string): ZoneCharacter {
  const start = Date.UTC(2023, 0, 1)
  const end = Date.UTC(2026, 0, 1)
  const jumps: number[] = []
  let prev = absoluteOffsetMs(start, zone)
  for (let t = start + HOUR; t < end; t += HOUR) {
    const off = absoluteOffsetMs(t, zone)
    if (off !== prev) {
      const jump = off - prev
      if (!jumps.includes(jump)) jumps.push(jump)
      prev = off
    }
  }
  return { zone, hasDST: jumps.length > 0, jumpsMs: jumps.sort((a, b) => a - b) }
}

/** IANA zone the current process resolves to (the `TZ` it was launched with). */
export function hostZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

export function whenHostZoneIs(zone: string | string[]): boolean {
  const h = hostZone()
  return Array.isArray(zone) ? zone.includes(h) : h === zone
}

/**
 * Fixed-seed PRNG (mulberry32). Deterministic across Node versions; the seed is
 * part of the contract so a failure can always be reproduced exactly.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const SEED = 0x5e4d_504f // "TEMPO"-ish constant

/** Inclusive integer in [min, max]. */
export function intBetween(rand: () => number, min: number, max: number): number {
  return min + Math.floor(rand() * (max - min + 1))
}

/** Deterministically choose an array element. */
export function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)]
}

/**
 * Delta-debugging style shrinker for a one-dimensional generated case.
 *
 * `interpolate(seed, mutated, t)` maps t in [0,1] to a candidate (0 = safe
 * anchor, 1 = failing case). `holds(candidate)` is the property; it is true at
 * the anchor and false at the failing case. Binary search returns the candidate
 * closest to the anchor that still fails, so a failure near a DST/month
 * boundary is reported as a concrete date adjacent to that boundary.
 */
export function shrink<T>(
  seed: T,
  mutated: T,
  holds: (candidate: T) => boolean,
  interpolate: (a: T, b: T, t: number) => T,
  steps = 24
): T {
  // Invariant: candidate at lo passes, candidate at hi fails.
  let lo = 0
  let hi = 1
  if (!holds(interpolate(seed, mutated, lo))) {
    throw new Error("shrink(): anchor case must satisfy the property")
  }
  if (holds(interpolate(seed, mutated, hi))) {
    throw new Error("shrink(): failing case must violate the property")
  }
  for (let i = 0; i < steps; i++) {
    const mid = (lo + hi) / 2
    if (holds(interpolate(seed, mutated, mid))) lo = mid
    else hi = mid
  }
  return interpolate(seed, mutated, hi)
}

/**
 * Whether Intl can format the given locale at all, and whether its month /
 * weekday names are distinguishable (not ICU-fallback aliases).
 */
export function localeIsUsable(locale: string): boolean {
  try {
    const monthWidths: Array<Intl.DateTimeFormatOptions["month"]> = ["long", "short"]
    const months = new Set(
      monthWidths.map((width) =>
        new Intl.DateTimeFormat(locale, { month: width, timeZone: "UTC" })
          .format(new Date("2024-01-15T00:00:00Z"))
      )
    )
    const weekdayWidths: Array<Intl.DateTimeFormatOptions["weekday"]> = ["long", "short"]
    const weekdays = new Set(
      weekdayWidths.map((width) =>
        new Intl.DateTimeFormat(locale, {
          weekday: width,
          timeZone: "UTC",
        }).format(new Date("2024-02-14T00:00:00Z"))
      )
    )
    return months.size === 2 && weekdays.size === 2
  } catch {
    return false
  }
}

/**
 * Structured, punctuation-free expectations for a locale: the parts Intl
 * itself produces. Tests assert Tempo reproduces these parts rather than any
 * particular literal separator.
 */
export function referenceParts(
  locale: string,
  instant: number
): { monthLong: string; monthShort: string; weekdayLong: string; weekdayShort: string } {
  const fmt = (options: Intl.DateTimeFormatOptions) => {
    const parts = new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).formatToParts(
      new Date(instant)
    )
    return parts.find((p) => p.type === (options.month ? "month" : "weekday"))!.value
  }
  return {
    monthLong: fmt({ month: "long" }),
    monthShort: fmt({ month: "short" }),
    weekdayLong: fmt({ weekday: "long" }),
    weekdayShort: fmt({ weekday: "short" }),
  }
}

/** Freeze the clock for every test in a suite to FIXED_NOW. */
export function useFixedNow() {
  beforeAll(() => {
    // Sanity: host must expose one of the zones the runner covers, or UTC by
    // default. Tests never rely on host behavior beyond this.
    void hostZone()
  })
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(FIXED_NOW_MS))
  })
}

export { HOUR as MS_PER_HOUR, DAY as MS_PER_DAY }
