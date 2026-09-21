import { describe, it, expect } from "vitest"
import {
  diffMilliseconds,
  diffSeconds,
  diffMinutes,
  diffHours,
  diffDays,
  applyOffset,
  removeOffset,
  offset,
  tzDate,
  format,
  parse,
} from "../../index"
import { ZONES, wallFieldsAt, offsetSeconds } from "./helpers"

/**
 * INSTANT LAYER.
 * An instant is epoch milliseconds. In Tempo the only genuinely instant
 * operations are raw epoch construction (`new Date(epoch + n)`) and
 * `diffMilliseconds` (a subtraction). Every `add*` function is a *wall-nominal
 * setter (`setHours/getHours`, etc.) and therefore moves with DST; see
 * elapsed.spec.ts for the metamorphic proof. This file pins down what "instant"
 * actually guarantees: epoch invariance under a change of observation zone.
 */
describe("instant layer: epoch is invariant under zone (re)interpretation", () => {
  const instant = new Date("2024-11-03T05:30:15.250Z")

  for (const zone of ZONES) {
    it(`format(tz=${zone}) -> parse offset round-trips the same epoch`, () => {
      // Year + wall fields + offset + fraction: information-complete.
      const pattern = "YYYY-MM-DDTHH:mm:ss.SSSZ"
      const formatted = format({ date: instant, format: pattern, locale: "en", tz: zone })
      const back = parse(formatted, pattern, "en")
      expect(back.getTime()).toBe(instant.getTime())
    })
  }

  for (const zone of ZONES) {
    it(`offset() matches the Intl-derived offset: ${zone}`, () => {
      const token = offset(instant, "utc", zone)
      const match = token.match(/([+-])(\d{2}):(\d{2})(?::(\d{2}))?/)!
      const [, sign, hh, mm, ss = "0"] = match
      const secs =
        (Number(hh) * 3600 + Number(mm) * 60 + Number(ss)) * (sign === "-" ? -1 : 1)
      expect(secs).toBe(offsetSeconds(zone, instant))
    })
  }

  it("viewing one instant in five zones yields five wall readings", () => {
    const readings = ZONES.map((z) => {
      const w = wallFieldsAt(z, instant)
      return `${w.mo}/${w.d} ${w.h}:${w.mi}`
    })
    expect(new Set(readings).size).toBeGreaterThan(1)
    // ...yet every reading describes the same fixed epoch.
    for (const z of ZONES) {
      const pattern = "YYYY-MM-DDTHH:mm:ss.SSSZ"
      const text = format({ date: instant, format: pattern, locale: "en", tz: z })
      expect(parse(text, pattern, "en").getTime()).toBe(instant.getTime())
    }
  })

  it("applyOffset/removeOffset are exact inverses (incl. half-hour zones)", () => {
    const d = new Date("2024-06-15T12:00:00.000Z")
    for (const off of ["+05:30", "-03:30", "+10:30", "-08:00", "+00:00"]) {
      expect(removeOffset(applyOffset(d, off), off).getTime()).toBe(d.getTime())
    }
  })

  it("seconds-precision offsets are honored as pure epoch seconds", () => {
    const d = new Date("2024-06-15T12:00:00.000Z")
    const off = "+05:32:11"
    expect(applyOffset(d, off).getTime() - d.getTime()).toBe(
      (5 * 3600 + 32 * 60 + 11) * 1000
    )
    expect(removeOffset(applyOffset(d, off), off).getTime()).toBe(d.getTime())
  })

  it("parsing a seconds-precision offset yields the exact instant", () => {
    const pattern = "YYYY-MM-DDTHH:mm:ssZ"
    const text = "1883-11-18T12:03:57-05:32:11"
    const expected = Date.UTC(1883, 10, 18, 12, 3, 57) + (5 * 3600 + 32 * 60 + 11) * 1000
    expect(parse(text, pattern, "en").getTime()).toBe(expected)
  })

  it("tzDate maps a naive wall time to the offset-adjusted instant", () => {
    expect(tzDate("2024-06-15T12:00:00", "Asia/Kolkata").toISOString()).toBe(
      "2024-06-15T06:30:00.000Z"
    )
    expect(tzDate("2024-04-15T12:30:00", "Australia/Lord_Howe").toISOString()).toBe(
      "2024-04-15T02:00:00.000Z"
    )
  })
})

describe("instant layer: diffMilliseconds is pure epoch subtraction", () => {
  // Values adjacent to transitions; the subtraction cannot depend on the wall
  // clock, so it is identical in every host zone (asserted via the tz driver).
  const pairs: Array<[string, string]> = [
    ["2024-03-10T06:00:00.000Z", "2024-03-10T09:45:30.500Z"],
    ["2024-11-03T05:00:00.000Z", "2024-11-03T06:30:00.000Z"],
    ["2024-10-05T15:00:00.000Z", "2024-10-05T16:00:00.000Z"],
  ]

  for (const [a, b] of pairs) {
    it(`epoch subtraction: ${a} -> ${b}`, () => {
      const left = new Date(b)
      const right = new Date(a)
      const ms = +left - +right
      expect(diffMilliseconds(left, right)).toBe(ms)
      expect(diffSeconds(left, right)).toBe(Math.trunc(ms / 1000))
      expect(diffMinutes(left, right)).toBe(Math.trunc(ms / 60_000))
      expect(diffHours(left, right)).toBe(Math.trunc(ms / 3_600_000))
    })
  }

  it("raw epoch +n is the ONLY operation that always moves exactly n ms", () => {
    const d = new Date("2024-03-10T05:00:00.000Z") // NY gap-day local midnight
    for (const n of [1, 60_000, 3_600_000, 23 * 3_600_000, 24 * 3_600_000]) {
      expect(new Date(d.getTime() + n).getTime()).toBe(d.getTime() + n)
    }
  })

  it("diffDays truncation differs from ceil specifically on sub-24h spans", () => {
    // 23 whole hours on the gap day: trunc -> 0, ceil -> 1.
    const a = new Date("2024-03-10T05:00:00.000Z")
    const b = new Date(a.getTime() + 23 * 3_600_000)
    expect(diffDays(b, a)).toBe(0)
    expect(diffDays(b, a, "ceil")).toBe(1)
  })
})
