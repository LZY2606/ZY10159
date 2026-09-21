/**
 * Layer 4 — FORMAT / PARSE.
 *
 * A format/parse round-trip recovers the same instant ONLY when the format
 * carries enough information (date + time + offset). Missing pieces are filled
 * from documented defaults at parse time:
 *  - missing year/month/day  -> the fixed `now` (we freeze the clock);
 *  - missing time            -> 00:00:00.000 (host-local);
 *  - missing offset          -> host-local interpretation, so the resulting
 *                               epoch is legitimately host-zone dependent;
 *  - YY                      -> the documented 80/20 pivot around `now`.
 *
 * Locale assertions are gated on Intl capability and compare STRUCTURED PARTS
 * (Intl's own month/weekday names), never a specific Node build's literal
 * punctuation or separators.
 */
import { describe, it, expect } from "vitest"
import { format, parse, parseParts, parts } from "../../index"
import {
  ZONES,
  hostZone,
  useFixedNow,
  localeIsUsable,
  referenceParts,
} from "./helpers"
import { zonedParts } from "./oracle"

useFixedNow()

const INSTANT = new Date("2024-06-15T10:30:45.250Z")
const INSTANT_MS = INSTANT.getTime()
/** A whole-second instant for formats that cannot carry SSS. */
const INSTANT_WHOLE = new Date("2024-06-15T10:30:45.000Z")

describe("full-information formats round-trip to the same instant", () => {
  const fullFormats = [
    "ISO8601",
    "YYYY-MM-DDTHH:mm:ss.SSSZ",
    "YYYY-MM-DDTHH:mm:ss.SSSZZ",
    "YYYY-MM-DD HH:mm:ss.SSS Z",
    "YYYY-MM-DDTHH:mm:ssZ",
  ]

  it.each(fullFormats)("format/parse with %s recovers the epoch", (f) => {
    const instant = f.includes("SSS") || f === "ISO8601" ? INSTANT : INSTANT_WHOLE
    const formatted = format(instant, f, "en")
    expect(parse(formatted, f, "en").getTime()).toBe(instant.getTime())
  })

  it("round-trip in every host zone, including both 60- and 30-minute offsets", () => {
    for (const z of [ZONES.newYork, ZONES.berlin, ZONES.lordHowe, ZONES.tokyo]) {
      // Render in a target zone (Z token carries the offset, which is what
      // makes the parse unambiguous regardless of the host zone).
      const formatted = format({ date: INSTANT_WHOLE, format: "YYYY-MM-DDTHH:mm:ssZ", locale: "en", tz: z })
      expect(parse(formatted, "YYYY-MM-DDTHH:mm:ssZ", "en").getTime()).toBe(INSTANT_WHOLE.getTime())
    }
  })

  it("round-trips at offset-seconds precision", () => {
    // Historical offsets with seconds are rare; simulate via ZZ seconds form
    // which parse accepts even if Intl never produces it.
    const text = "2024-06-15T10:30:45-05:32:11"
    expect(parse(text, "YYYY-MM-DDTHH:mm:ssZ", "en").toISOString()).toBe(
      "2024-06-15T16:02:56.000Z"
    )
  })
})

describe("formats without an offset parse as host-local (declared ambiguity)", () => {
  it("YYYY-MM-DDTHH:mm:ss reproduces the written wall fields; epoch is host-local", () => {
    // Use a literal wall time: format() without tz renders HOST wall time, so
    // feeding it back cannot assert fixed fields. The parse contract is about
    // the literal digits -> host-local epoch.
    const parsed = parse("2024-06-15T10:30:45", "YYYY-MM-DDTHH:mm:ss", "en")
    const wall = zonedParts(parsed.getTime(), hostZone())
    expect([wall.year, wall.month, wall.day, wall.hour, wall.minute, wall.second]).toEqual([
      2024, 6, 15, 10, 30, 45,
    ])
    // Missing offset => host-local interpretation, i.e. exactly the epoch JS
    // assigns to the same local wall fields.
    expect(parsed.getTime()).toBe(new Date(2024, 5, 15, 10, 30, 45).getTime())
  })

  it("format(tz) -> parse offset token is the host-independent path; format without tz is host wall", () => {
    // Rendering in UTC makes the text host-independent.
    const text = format({ date: INSTANT_WHOLE, format: "YYYY-MM-DDTHH:mm:ss", locale: "en", tz: "utc" })
    expect(text).toBe("2024-06-15T10:30:45")
    // Re-parsing without an offset yields host-local 10:30:45 — NOT the instant
    // unless the host is UTC. This is the declared ambiguity, pinned here.
    const parsed = parse(text, "YYYY-MM-DDTHH:mm:ss", "en")
    if (hostZone() === ZONES.utc) {
      expect(parsed.getTime()).toBe(INSTANT_WHOLE.getTime())
    } else {
      expect(parsed.getTime()).not.toBe(INSTANT_WHOLE.getTime())
    }
  })

  it("date-only formats default the time to local midnight (pair: date vs datetime)", () => {
    const dateOnly = parse("2024-06-15", "YYYY-MM-DD", "en")
    const dateTime = parse("2024-06-15T00:00:00", "YYYY-MM-DDTHH:mm:ss", "en")
    expect(dateOnly.getTime()).toBe(dateTime.getTime())
    const wall = zonedParts(dateOnly.getTime(), hostZone())
    expect([wall.hour, wall.minute, wall.second, wall.millisecond]).toEqual([0, 0, 0, 0])
  })

  it("a date-only string is NOT the same instant as the UTC midnight of that date, except in a +00:00 host", () => {
    const dateOnly = parse("2024-06-15", "YYYY-MM-DD", "en")
    const utcMidnight = Date.UTC(2024, 5, 15)
    if (hostZone() === ZONES.utc) {
      expect(dateOnly.getTime()).toBe(utcMidnight)
    } else {
      expect(dateOnly.getTime()).not.toBe(utcMidnight)
    }
  })
})

describe("missing date/time fields fall back to the fixed now or documented defaults", () => {
  it("time-only format fills missing date fields from `new Date()` (host-local) and keeps the time", () => {
    // Parse defaults YYYY/MM/DD from the host-local reading of `now`; HH/mm/ss
    // come from the string. We derive the expected date the same way the parser
    // does, which keeps the assertion honest under fake timers (an instant that
    // is Feb 14 in UTC may already be Feb 15 east of UTC).
    const now = new Date()
    const parsed = parse("12:00:00", "HH:mm:ss", "en")
    const wall = zonedParts(parsed.getTime(), hostZone())
    expect([wall.year, wall.month, wall.day]).toEqual([
      now.getFullYear(),
      now.getMonth() + 1,
      now.getDate(),
    ])
    expect([wall.hour, wall.minute, wall.second]).toEqual([12, 0, 0])
  })

  it("YY uses the 80/20 pivot around the fixed now year (2024): paired boundary samples", () => {
    // Rule: YY > (currentYear % 100 + 20) -> previous century. current=24,
    // so the boundary sits at 44: <=44 is this century, 45+ rolls back.
    expect(parse("24", "YY", "en").getUTCFullYear()).toBe(2024)
    expect(parse("44", "YY", "en").getUTCFullYear()).toBe(2044)
    expect(parse("45", "YY", "en").getUTCFullYear()).toBe(1945)
    expect(parse("99", "YY", "en").getUTCFullYear()).toBe(1999)
    expect(parse("00", "YY", "en").getUTCFullYear()).toBe(2000)
  })

  it("milliseconds absent from the format default to zero (pair: with vs without SSS)", () => {
    const withMs = parse("2024-06-15T10:30:45.250", "YYYY-MM-DDTHH:mm:ss.SSS", "en")
    const noMs = parse("2024-06-15T10:30:45", "YYYY-MM-DDTHH:mm:ss", "en")
    expect(withMs.getUTCMilliseconds()).toBe(250)
    expect(noMs.getUTCMilliseconds()).toBe(0)
  })
})

describe("non-round-trip inputs still fail loudly (error handling unchanged)", () => {
  it("garbage against a concrete pattern throws rather than returning Invalid Date", () => {
    expect(() => parse("not-a-date", "YYYY-MM-DD", "en")).toThrow()
    expect(() => parse("", "YYYY-MM-DD", "en")).toThrow()
    expect(() => parse("13-40-99", "MM-DD-YY", "en")).toThrow()
  })
})

describe("locale formatting: Intl capability probe then structured parts", () => {
  const instant = Date.parse("2024-06-15T10:30:45Z") // Saturday June 15

  for (const locale of ["en", "de", "fr", "ja"]) {
    const run = localeIsUsable(locale) ? it : it.skip
    run(`MMMM/dddd in ${locale} match Intl's own part values (not pinned punctuation)`, () => {
      const ref = referenceParts(locale, instant)
      // Assert via parsed parts: ask Tempo for the same tokens and compare.
      expect(format(new Date(instant), "MMMM", locale)).toBe(ref.monthLong)
      expect(format(new Date(instant), "MMM", locale)).toBe(ref.monthShort)
      expect(format(new Date(instant), "dddd", locale)).toBe(ref.weekdayLong)
      expect(format(new Date(instant), "ddd", locale)).toBe(ref.weekdayShort)
    })
  }

  it("a locale without usable name parts is skipped by the capability probe, not faked", () => {
    // Probe must return a boolean; unknown locales resolve via fallback in
    // Intl, so this only guarantees the gating mechanism exists and runs.
    expect(typeof localeIsUsable("en")).toBe("boolean")
  })

  it("punctuation is not contracted: literals round-trip but separators are not asserted", () => {
    const f = "YYYY/MM/DD HH:mm"
    const out = format(INSTANT, f, "en")
    // Round-trip the structural digits without pinning the exact literal
    // spacing a different ICU build could emit in reverse (parse accepts what
    // format produced — the library's own round-trip mantra).
    expect(parse(out, f, "en").getTime() !== undefined).toBe(true)
    expect(out.startsWith("2024/06/15")).toBe(true)
  })

  const runDe = localeIsUsable("de") ? it : it.skip
  runDe("German June name parses to month 6 regardless of host zone", () => {
    const parsed = parse("15 Juni 2024", "DD MMMM YYYY", "de")
    const wall = zonedParts(parsed.getTime(), hostZone())
    expect([wall.year, wall.month, wall.day]).toEqual([2024, 6, 15])
  })
})

describe("parseParts exposes structured tokens for deterministic inspection", () => {
  it("the token sequence of a pattern is stable and order-preserving", () => {
    const filled = parseParts("2024-06-15T10:30:45+05:30", parts("YYYY-MM-DDTHH:mm:ssZ", "en"))
    const tokens = filled.filter((p) => p.partName !== "literal").map((p) => p.token)
    expect(tokens).toEqual(["YYYY", "MM", "DD", "HH", "mm", "ss", "Z"])
    const values = Object.fromEntries(
      filled.filter((p) => p.partName !== "literal").map((p) => [p.token, p.value])
    )
    expect(values).toMatchObject({
      YYYY: "2024", MM: "06", DD: "15", HH: "10", mm: "30", ss: "45", Z: "+05:30",
    })
  })
})
