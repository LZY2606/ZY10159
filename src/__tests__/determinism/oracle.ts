/**
 * Independent reference oracle for the deterministic test matrix.
 *
 * Tempo is implemented on top of the host `Date` / `Intl` machinery. To avoid
 * tests that merely repeat the implementation ("x === x"), every expectation
 * below is derived independently: wall-clock readings go through
 * `Intl.DateTimeFormat.formatToParts` with an explicit IANA zone, calendar
 * arithmetic is hand-rolled proleptic-Gregorian math, and the only place the
 * host `Date` local-time API is used is when modeling how a *wall clock* input
 * maps to an epoch inside the host zone — which is exactly the contract under
 * test.
 */

export type Zone = string

/** Wall-clock fields in an IANA zone, independent of `Date` local getters. */
export interface WallParts {
  year: number
  month: number // 1-12
  day: number // 1-31
  hour: number // 0-23
  minute: number
  second: number
  millisecond: number
  weekday: number // 0 = Sunday ... 6 = Saturday
  /** UTC offset of this instant in this zone, in milliseconds east of UTC. */
  offsetMs: number
}

const formatterCache = new Map<string, Intl.DateTimeFormat>()

function partsFormatter(tz: Zone): Intl.DateTimeFormat {
  let f = formatterCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      era: "short",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
      timeZone: tz,
      hourCycle: "h23",
    })
    formatterCache.set(tz, f)
  }
  return f
}

/**
 * Reads wall-clock fields + offset for an epoch in `tz` purely via Intl.
 */
export function zonedParts(ms: number, tz: Zone): WallParts {
  const instant = new Date(ms)
  const map = new Map<string, string>()
  for (const part of partsFormatter(tz).formatToParts(instant)) {
    if (part.type !== "literal") map.set(part.type, part.value)
  }
  const rawYear = Number(map.get("year"))
  const year = map.get("era") === "BC" ? 1 - rawYear : rawYear
  // hourCycle h23 still yields "24" at midnight in some ICU builds; the
  // narrow-midnight wall hour is always 0 for the fields Tempo writes.
  const hour = Number(map.get("hour")) % 24
  const offsetMs = absoluteOffsetMs(ms, tz)
  return {
    year,
    month: Number(map.get("month")),
    day: Number(map.get("day")),
    hour,
    minute: Number(map.get("minute")),
    second: Number(map.get("second")),
    millisecond: instant.getUTCMilliseconds(),
    weekday: weekdayFromName(map.get("weekday")!),
    offsetMs,
  }
}

function weekdayFromName(name: string): number {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(name)
}

function zonedPartsRaw(
  ms: number,
  tz: Zone
): Omit<WallParts, "offsetMs" | "weekday"> {
  const instant = new Date(ms)
  const map = new Map<string, string>()
  for (const part of partsFormatter(tz).formatToParts(instant)) {
    if (part.type !== "literal") map.set(part.type, part.value)
  }
  return {
    year:
      map.get("era") === "BC" ? 1 - Number(map.get("year")) : Number(map.get("year")),
    month: Number(map.get("month")),
    day: Number(map.get("day")),
    hour: Number(map.get("hour")) % 24,
    minute: Number(map.get("minute")),
    second: Number(map.get("second")),
    millisecond: instant.getUTCMilliseconds(),
  }
}

/**
 * Absolute UTC offset (ms) at an epoch: wall-time-as-UTC minus epoch. Wall time
 * is reconstructed from Intl parts, so this never consults the host zone.
 */
export function absoluteOffsetMs(ms: number, tz: Zone): number {
  const w = zonedPartsRaw(ms, tz)
  const wallAsUtc = Date.UTC(
    w.year,
    w.month - 1,
    w.day,
    w.hour,
    w.minute,
    w.second,
    w.millisecond
  )
  return wallAsUtc - ms
}

const DAY_MS = 86_400_000

/**
 * Finds the UTC epoch range of a DST transition on or after `fromMs` (searches
 * forward up to `limitMs`) in `tz`. Returns the bracket around the offset
 * change: two epochs 1h apart whose offsets differ, plus the size of the jump.
 */
export function findTransition(
  tz: Zone,
  fromMs: number,
  limitMs = 400 * DAY_MS
): { beforeMs: number; afterMs: number; jumpMs: number } | null {
  let prev = fromMs
  let prevOff = absoluteOffsetMs(prev, tz)
  for (let t = fromMs + 3_600_000; t <= fromMs + limitMs; t += 3_600_000) {
    const off = absoluteOffsetMs(t, tz)
    if (off !== prevOff) {
      return { beforeMs: prev, afterMs: t, jumpMs: off - prevOff }
    }
    prev = t
    prevOff = off
  }
  return null
}

/**
 * Refines a transition bracket to the millisecond by bisection.
 */
export function refineTransition(
  tz: Zone,
  lo: number,
  hi: number
): number {
  const offLo = absoluteOffsetMs(lo, tz)
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2)
    if (absoluteOffsetMs(mid, tz) === offLo) lo = mid
    else hi = mid
  }
  return hi
}

// ---- Pure proleptic-Gregorian calendar math (no Date/Intl) --------------

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

export function daysInMonth(year: number, month: number): number {
  const lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return month === 2 && isLeapYear(year) ? 29 : lengths[month - 1]
}

/** Clamp-aware month add: mirrors Tempo's dateOverflow contract independently. */
export function calendarAddMonths(
  y: number,
  m: number,
  d: number,
  amount: number,
  overflow: "clamp" | "forward"
): { year: number; month: number; day: number } {
  const zeroBased = (y * 12 + (m - 1) + amount)
  const year = Math.floor(zeroBased / 12)
  const month = zeroBased - year * 12 + 1
  if (overflow === "forward") return { year, month, day: d }
  const max = daysInMonth(year, month)
  return { year, month, day: Math.min(d, max) }
}

/** Zeller-free weekday via a known anchor: 2024-01-01 was a Monday (1). */
export function calendarWeekday(year: number, month: number, day: number): number {
  const anchor = Date.UTC(2024, 0, 1) // Monday (1 in JS convention)
  const target = Date.UTC(year, month - 1, day)
  return ((1 + Math.round((target - anchor) / DAY_MS)) % 7 + 7) % 7
}
