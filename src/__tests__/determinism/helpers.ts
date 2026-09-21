/**
 * Deterministic test infrastructure for Tempo's layered time model.
 *
 * Three layers must never be conflated:
 *  - instant:  a point on the UTC timeline (epoch milliseconds).
 *  - wall:      calendar fields (y/mo/d/h/mi/s) as displayed in some zone.
 *  - calendar: nominal units (day/week/month/year) whose physical length can
 *              change across DST transitions and month/year boundaries.
 *
 * Every helper here is pure and fixed-input: no `new Date()` without an
 * argument, no device-locale reads. All zone math goes through the runtime's
 * Intl tzdb (we never ship one).
 */

/**
 * The single fixed "now" shared by the whole matrix. No test may read the
 * host clock; values that default to the current instant are pinned here.
 */
export const FIXED_NOW = new Date("2024-06-15T12:34:56.789Z")

/** Zones the matrix explicitly covers (including a no-DST half-hour zone). */
export const ZONES = [
  "UTC",
  "America/New_York",
  "Europe/Berlin",
  "Australia/Lord_Howe",
  "Asia/Kolkata",
] as const

export type Zone = (typeof ZONES)[number]

/** Zone the current test process is pinned to via the TZ environment variable. */
export const HOST_TZ = process.env.TZ ?? "UTC"

/** Whether the heavier property rounds are enabled. */
export const HEAVY = process.env.TEMPO_HEAVY === "1"

export function rounds(normal: number, heavy: number): number {
  return HEAVY ? heavy : normal
}

export interface WallFields {
  y: number
  mo: number // 1-12
  d: number
  h: number
  mi: number
  s: number
  ms: number
}

/**
 * Reads wall-clock fields for an instant in an arbitrary zone through Intl.
 * This is the only sanctioned way to observe zoned wall time in the matrix.
 */
export function wallFieldsAt(zone: string, instant: Date): WallFields {
  const dtf = new Intl.DateTimeFormat("en-US", {
    era: "short",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZone: zone,
    hourCycle: "h23",
  })
  const parts: Record<string, string> = {}
  for (const part of dtf.formatToParts(instant)) {
    if (part.type !== "literal") parts[part.type] = part.value
  }
  const y = parts.era === "BC" ? 1 - Number(parts.year) : Number(parts.year)
  return {
    y,
    mo: Number(parts.month),
    d: Number(parts.day),
    h: Number(parts.hour),
    mi: Number(parts.minute),
    s: Number(parts.second),
    ms: instant.getMilliseconds(),
  }
}

/** UTC offset (seconds) of a zone at an instant, computed from Intl output. */
export function offsetSeconds(zone: string, instant: Date): number {
  const w = wallFieldsAt(zone, instant)
  const asUtc = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s, w.ms)
  return Math.round((asUtc - instant.getTime()) / 1000)
}

/**
 * Resolves a naive wall-clock time in a zone to the instant that displays it.
 * DST gaps never exist on input here; existence can be checked with
 * {@link wallExists}.
 */
export function wallInstant(
  zone: string,
  fields: Partial<WallFields> & Pick<WallFields, "y" | "mo" | "d">
): Date {
  const target: WallFields = { h: 0, mi: 0, s: 0, ms: 0, ...fields }
  const naive = Date.UTC(
    target.y,
    target.mo - 1,
    target.d,
    target.h,
    target.mi,
    target.s,
    target.ms
  )
  // Iteratively correct the guess with the zone offset (converges in <=2).
  let epoch = naive
  for (let i = 0; i < 4; i++) {
    epoch = naive - offsetSeconds(zone, new Date(epoch)) * 1000
  }
  return new Date(epoch)
}

/** Whether a wall-clock time exists in the zone (false inside a spring gap). */
export function wallExists(
  zone: string,
  fields: Partial<WallFields> & Pick<WallFields, "y" | "mo" | "d">
): boolean {
  const instant = wallInstant(zone, fields)
  const shown = wallFieldsAt(zone, instant)
  const wanted: WallFields = { h: 0, mi: 0, s: 0, ms: 0, ...fields }
  return (
    shown.y === wanted.y &&
    shown.mo === wanted.mo &&
    shown.d === wanted.d &&
    shown.h === wanted.h &&
    shown.mi === wanted.mi &&
    shown.s === wanted.s
  )
}

export interface Transition {
  /** Last whole minute carrying the old offset. */
  before: Date
  /** First whole minute carrying the new offset. */
  after: Date
  beforeOffsetSecs: number
  afterOffsetSecs: number
  /** Offset change in minutes. */
  deltaMin: number
  /** true for a spring-forward gap, false for an autumn fall-back. */
  isGap: boolean
}

/**
 * Scans a year of a zone for offset transitions, refining each to the minute.
 * Replaces hard-coded transition tables with data read from the runtime tzdb.
 */
const transitionCache = new Map<string, Transition[]>()

export function findTransitions(zone: string, year: number): Transition[] {
  const cacheKey = `${zone}:${year}`
  const cached = transitionCache.get(cacheKey)
  if (cached) return cached
  const start = Date.UTC(year, 0, 1)
  const end = Date.UTC(year + 1, 0, 1)
  const hour = 3_600_000
  const minute = 60_000
  const out: Transition[] = []
  let prevOffset = offsetSeconds(zone, new Date(start))
  for (let t = start; t < end; t += hour) {
    const offset = offsetSeconds(zone, new Date(t))
    if (offset === prevOffset) continue
    // Refine the [t-hour, t] bracket to the first changed minute.
    let lo = t - hour
    let hi = t
    while (hi - lo > minute) {
      const mid = lo + Math.floor((hi - lo) / 2 / minute) * minute
      if (offsetSeconds(zone, new Date(mid)) === prevOffset) lo = mid
      else hi = mid
    }
    out.push({
      before: new Date(lo),
      after: new Date(hi),
      beforeOffsetSecs: prevOffset,
      afterOffsetSecs: offset,
      deltaMin: (offset - prevOffset) / 60,
      isGap: offset > prevOffset,
    })
    prevOffset = offset
    t = hi
  }
  transitionCache.set(cacheKey, out)
  return out
}

/** Whether a zone observes any offset change in a year. */
export function zoneHasDST(zone: string, year = 2024): boolean {
  return findTransitions(zone, year).length > 0
}

/** Deterministic PRNG (mulberry32). The seed is part of the test contract. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

/**
 * Shrinks a failing integer parameter to the boundary where failure starts.
 * Precondition: `fails(lo)` is false and `fails(hi)` is true. Returns the
 * smallest index in (lo, hi] that fails, so reported cases land right next to
 * the offending transition instead of at the original random draw.
 */
export function minimizeFailure(
  lo: number,
  hi: number,
  fails: (n: number) => boolean
): number {
  if (fails(lo)) throw new Error("minimizeFailure expects fails(lo) === false")
  if (!fails(hi)) throw new Error("minimizeFailure expects fails(hi) === true")
  while (lo + 1 < hi) {
    const mid = lo + Math.floor((hi - lo) / 2)
    if (fails(mid)) hi = mid
    else lo = mid
  }
  return hi
}

/** Whether the runtime ships ICU data for a locale (probe before asserting). */
export function localeSupported(locale: string): boolean {
  try {
    return Intl.DateTimeFormat.supportedLocalesOf(locale).length > 0
  } catch {
    return false
  }
}

/** Whether the runtime reports full (not short/basic) ICU data. */
export function hasFullICU(): boolean {
  try {
    return (
      new Intl.DateTimeFormat("th-TH", { dateStyle: "full" }).format(FIXED_NOW).length > 0
    )
  } catch {
    return false
  }
}
