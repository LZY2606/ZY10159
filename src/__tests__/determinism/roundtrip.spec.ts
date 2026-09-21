import { describe, it, expect } from "vitest"
import { format, parse, parts, range, ap, offset } from "../../index"
import { ZONES, HOST_TZ, FIXED_NOW, wallFieldsAt, localeSupported } from "./helpers"

/**
 * FORMAT/PARSE ROUND-TRIPS.
 * A format round-trips to the same *instant* only when it encodes enough
 * information (year + wall fields + offset/zone). Formats missing a year,
 * offset, or both can only be checked against their declared default
 * (host-now fields, host-local interpretation) or their documented ambiguity.
 * We never pretend those restore the original instant.
 */
const HOST = HOST_TZ
const INSTANT = new Date("2024-11-03T05:30:15.250Z") // near NY overlap

describe("information-complete formats round-trip the instant in every zone", () => {
  // Each pattern carries year, wall fields, AND an offset plus millisecond
  // fraction: that is the minimum information that restores the same instant.
  const patterns = [
    "YYYY-MM-DDTHH:mm:ss.SSSZ",
    "YYYY-MM-DDTHH:mm:ss.SSSZZ",
    "YYYY/MM/DD HH:mm:ss.SSS Z",
  ]

  for (const zone of ZONES) {
    for (const pattern of patterns) {
      it(`${pattern} @ ${zone}`, () => {
        const text = format({ date: INSTANT, format: pattern, locale: "en", tz: zone })
        const back = parse(text, pattern, "en")
        expect(back.getTime()).toBe(INSTANT.getTime())
      })
    }
  }

  it("seconds-precision offsets parse to the exact offset-adjusted instant", () => {
    // parse() is the only path that can carry :ss offsets (Date cannot). Feed
    // it directly and check epoch arithmetic; formatting back uses the host
    // offset, so the original text is not reproducible by format().
    const pattern = "YYYY-MM-DDTHH:mm:ssZ"
    const text = "1883-11-18T12:03:57-05:32:11"
    const back = parse(text, pattern, "en")
    const expected = Date.UTC(1883, 10, 18, 12, 3, 57) + (5 * 3600 + 32 * 60 + 11) * 1000
    expect(back.getTime()).toBe(expected)
    // Re-parsing the same text is deterministic and stable.
    expect(parse(text, pattern, "en").getTime()).toBe(expected)
  })
})

describe("formats without an offset round-trip wall fields, not the instant", () => {
  it("naive date+time parses in the HOST zone (explicit, not presumed UTC)", () => {
    const pattern = "YYYY-MM-DD HH:mm:ss"
    const text = format(INSTANT, pattern, "en")
    const back = parse(text, pattern, "en")
    const want = wallFieldsAt(HOST, INSTANT)
    const got = wallFieldsAt(HOST, back)
    expect([got.y, got.mo, got.d, got.h, got.mi, got.s]).toEqual([
      want.y,
      want.mo,
      want.d,
      want.h,
      want.mi,
      want.s,
    ])
    // The same wall text must NOT be assumed to equal the UTC instant.
    if (offset(INSTANT, "utc", HOST) !== "+00:00") {
      expect(back.getTime()).not.toBe(INSTANT.getTime())
    }
  })

  it("date-only format round-trips the wall date with time defaulting to 00:00", () => {
    const pattern = "YYYY-MM-DD"
    const text = format(INSTANT, pattern, "en")
    const back = parse(text, pattern, "en")
    const want = wallFieldsAt(HOST, INSTANT)
    expect([back.getFullYear(), back.getMonth() + 1, back.getDate()]).toEqual([
      want.y,
      want.mo,
      want.d,
    ])
    expect([back.getHours(), back.getMinutes(), back.getSeconds()]).toEqual([0, 0, 0])
  })
})

describe("formats without a year use the documented host-now default", () => {
  it("MM-DD fills year/month defaults from the current date, not FIXED_NOW", () => {
    // parse() defaults absent fields from `new Date()`. We capture the real
    // current date at call time and assert against THAT (the declared default),
    // proving no hidden fixed clock is involved.
    const pattern = "MM-DD HH:mm"
    const text = "07-20 14:05"
    const before = new Date()
    const back = parse(text, pattern, "en")
    const after = new Date()
    expect(back.getMonth() + 1).toBe(7)
    expect(back.getDate()).toBe(20)
    expect([back.getHours(), back.getMinutes()]).toEqual([14, 5])
    expect(back.getFullYear()).toBeGreaterThanOrEqual(before.getFullYear())
    expect(back.getFullYear()).toBeLessThanOrEqual(after.getFullYear())
    // The omitted year defaults to the host clock year (documented default),
    // independently of the matrix FIXED_NOW — this is why the format cannot be
    // claimed to round-trip an arbitrary instant.
    expect(back.getFullYear()).toBe(new Date().getFullYear())
    expect(FIXED_NOW.getUTCFullYear()).toBe(2024)
  })
})

describe("ambiguous wall times have one declared resolution", () => {
  it("NY autumn overlap 01:30 resolves to the first (daylight) occurrence", () => {
    // This is host-zone behavior; only assert when running under New York.
    if (HOST !== "America/New_York") return
    const text = "2024-11-03 01:30"
    const back = parse(text, "YYYY-MM-DD HH:mm", "en")
    // 01:30 EDT = 05:30Z (first occurrence); the second 01:30 EST = 06:30Z.
    expect(back.toISOString()).toBe("2024-11-03T05:30:00.000Z")
    // A format lacking offset cannot distinguish the two: formatting 06:30Z
    // yields the same naive text, demonstrating the information loss.
    const second = new Date("2024-11-03T06:30:00.000Z")
    expect(format(second, "YYYY-MM-DD HH:mm", "en")).toBe(text)
  })
})

describe("locale-dependent tokens: probe capability, assert structure not punctuation", () => {
  const locales = ["en", "de", "ja"]

  for (const locale of locales) {
    it(`month/weekday names round-trip via range(): ${locale}`, () => {
      if (!localeSupported(locale)) return // skip, do not fail on small-ICU builds

      const pattern = "YYYY MMMM dddd DD"
      // MMMM/dddd are genitive-capable; format then parse the same locale.
      const text = format(INSTANT, pattern, locale, true)
      const back = parse(text, pattern, locale)
      const want = wallFieldsAt(HOST, INSTANT)
      expect([back.getFullYear(), back.getMonth() + 1, back.getDate()]).toEqual([
        want.y,
        want.mo,
        want.d,
      ])
    })

    it(`range() provides 12 months and 7 weekdays: ${locale}`, () => {
      if (!localeSupported(locale)) return
      expect(new Set(range("MMMM", locale)).size).toBe(12)
      expect(new Set(range("dddd", locale)).size).toBe(7)
    })

    it(`parts() maps tokens to Intl part types structurally: ${locale}`, () => {
      if (!localeSupported(locale)) return
      const map = Object.fromEntries(
        parts("YYYY-MM-DD", locale).map((p) => [p.token, p.partName])
      )
      expect(map).toMatchObject({
        YYYY: "year",
        MM: "month",
        DD: "day",
      })
    })
  }

  it("ap() returns am/pm markers per locale without asserting latin punctuation", () => {
    if (!localeSupported("en")) return
    const am = ap("am", "en")
    const pm = ap("pm", "en")
    expect(typeof am).toBe("string")
    expect(typeof pm).toBe("string")
    expect(am.toLowerCase()).not.toBe(pm.toLowerCase())
    // Structured contract: a 00:xx value formats to am, 13:xx to pm.
    const midnight = new Date("2024-06-15T00:15:00.000Z")
    const afternoon = new Date("2024-06-15T13:15:00.000Z")
    const fmtAm = format({ date: midnight, format: "h a", locale: "en", tz: "UTC" })
      .trim()
      .toLowerCase()
    const fmtPm = format({ date: afternoon, format: "h a", locale: "en", tz: "UTC" })
      .trim()
      .toLowerCase()
    expect(fmtAm).toContain(am.toLowerCase())
    expect(fmtPm).toContain(pm.toLowerCase())
  })

  it("unsupported locale probes skip instead of hard-failing on minimal ICU", () => {
    // A deliberately exotic tag; either supported or reported unsupported.
    const tag = "xx-YY-u-ca-bogus"
    const supported = localeSupported(tag)
    expect(typeof supported).toBe("boolean")
  })
})
