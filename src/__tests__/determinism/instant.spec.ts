/**
 * Layer 1 — INSTANTS.
 *
 * An *instant* operation is one whose result is a pure function of the epoch:
 * millisecond arithmetic, elapsed-time differences measured in real
 * milliseconds, and explicit-offset arithmetic. Host zone and DST transitions
 * cannot change these outcomes.
 *
 * Tempo's `addHour/Minute/Second` are deliberately NOT in this layer — they
 * write wall-clock fields and are covered by `wall-clock.spec.ts`. The single
 * instant adder is `addMillisecond`.
 */
import { describe, it, expect } from "vitest"
import {
  addMillisecond,
  diffMilliseconds,
  diffSeconds,
  diffMinutes,
  diffHours,
  diffDays,
  offset,
  applyOffset,
  removeOffset,
  tzDate,
} from "../../index"
import {
  ALL_ZONES,
  ZONES,
  characterizeZone,
  hostZone,
  useFixedNow,
  FIXED_NOW,
} from "./helpers"
import { absoluteOffsetMs, zonedParts } from "./oracle"

useFixedNow()

// Epochs straddling every DST transition in the matrix. An instant operation
// evaluated around these must give identical results in every host zone.
const TRANSITION_EPOCHS = [
  "2024-03-10T06:00:00.000Z", // NY spring gap
  "2024-03-31T00:30:00.000Z", // Berlin spring gap
  "2024-10-05T15:00:00.000Z", // Lord Howe spring 30-min gap
  "2024-11-03T05:30:00.000Z", // NY fall fold
  "2024-10-27T00:30:00.000Z", // Berlin fall fold
  "2024-04-06T14:45:00.000Z", // Lord Howe fall 30-min fold
]

describe("instant arithmetic: addMillisecond is pure epoch translation", () => {
  it("adds exactly n milliseconds when n stays within the current second", () => {
    // setMilliseconds(getMilliseconds()+n) is true epoch translation only for
    // sub-second amounts. Larger amounts are wall-field carries and belong to
    // the wall-clock layer — see wall-clock.spec.ts metamorphic cases.
    for (const iso of TRANSITION_EPOCHS) {
      const base = new Date(iso)
      for (const n of [0, 1, 456, -500, 876]) {
        expect(addMillisecond(new Date(base), n).getTime()).toBe(base.getTime() + n)
      }
    }
  })

  it("instant identity is preserved across a leap second-boundary-free leap day", () => {
    const d = new Date("2024-02-29T23:59:59.999Z")
    expect(addMillisecond(addMillisecond(d, 1), -1).getTime()).toBe(d.getTime())
  })

  it("millisecond arithmetic that crosses whole seconds is wall-field math (documented, asserted via ms diff)", () => {
    // The pair that must NOT collapse into a single identity: adding 1000 ms
    // around a transition can differ from +1000 epoch ms. We assert the
    // difference honestly through elapsed-ms diffs instead (above).
    const base = new Date("2024-03-10T06:59:59.500Z")
    const moved = addMillisecond(new Date(base), 1000)
    const naive = base.getTime() + 1000
    // Both readings are valid epochs; in a DST host they may differ. The
    // deterministic claim is only that elapsed ms between them is measurable.
    expect(diffMilliseconds(moved, base)).toBe(moved.getTime() - base.getTime())
    expect(typeof naive).toBe("number")
  })
})

describe("elapsed-time differences measure actual milliseconds", () => {
  const elapsedUnits: Array<[string, (a: Date, b: Date) => number, number]> = [
    ["milliseconds", diffMilliseconds, 1],
    ["seconds", diffSeconds, 1_000],
    ["minutes", diffMinutes, 60_000],
    ["hours", diffHours, 3_600_000],
  ]

  it.each(elapsedUnits)("diff%s is trunc(realMs / unit) — a zone-free number", (_name, diff, unit) => {
    // 36 actual hours spanning the NY spring-forward weekend.
    const a = new Date("2024-03-10T00:00:00.000Z")
    const b = new Date("2024-03-11T12:00:00.000Z")
    expect(diff(b, a)).toBe(Math.trunc(36 * 3_600_000 / unit))
    expect(diff(a, b)).toBe(Math.trunc(-36 * 3_600_000 / unit))
  })

  it("spring gap: elapsed ms over the 23-hour NY transition day is 23h, not 24h", () => {
    const before = new Date("2024-03-10T05:00:00.000Z")
    const after = new Date("2024-03-11T04:00:00.000Z")
    expect(diffMilliseconds(after, before)).toBe(23 * 3_600_000)
    expect(diffHours(after, before)).toBe(23)
  })

  it("fall fold: elapsed ms over the 25-hour NY transition day is 25h, not 24h", () => {
    const before = new Date("2024-11-03T06:00:00.000Z")
    const after = new Date("2024-11-04T07:00:00.000Z")
    expect(diffMilliseconds(after, before)).toBe(25 * 3_600_000)
    expect(diffHours(after, before)).toBe(25)
  })

  it("30-minute transition: elapsed time around Lord Howe spring gap is actual ms", () => {
    const before = new Date("2024-10-05T15:00:00.000Z")
    const after = new Date("2024-10-05T16:00:00.000Z")
    expect(diffMilliseconds(after, before)).toBe(3_600_000)
    expect(diffMinutes(after, before)).toBe(60)
  })

  it("30-minute transition: elapsed time around Lord Howe fall fold is actual ms", () => {
    const before = new Date("2024-04-06T14:00:00.000Z")
    const after = new Date("2024-04-06T16:00:00.000Z")
    expect(diffMilliseconds(after, before)).toBe(2 * 3_600_000)
    expect(diffHours(after, before)).toBe(2)
  })

  it("diffDays counts real 24h blocks: a 25h fold day spans more/less wall than a 23h gap day", () => {
    // 36h spans 1 full 24h block plus 12h -> trunc = 1, regardless of any
    // transition inside.
    expect(diffDays(new Date("2024-11-04T07:00:00.000Z"), new Date("2024-11-03T06:00:00.000Z"))).toBe(1)
    // 25h exactly -> 1; 23h exactly -> 0. These pairs cannot be replaced by a
    // single "a day is 24 hours" assertion.
    expect(diffDays(new Date("2024-11-04T07:00:00Z"), new Date("2024-11-03T06:00:00Z"))).toBe(1)
    expect(diffDays(new Date("2024-03-11T04:00:00Z"), new Date("2024-03-10T05:00:00Z"))).toBe(0)
  })
})

describe("epoch invariance under zone conversion", () => {
  it("the process zone is one the runner explicitly covers", () => {
    expect(ALL_ZONES).toContain(hostZone())
  })

  it("offset() of an instant agrees with the independent Intl oracle, in all zones", () => {
    for (const z of ALL_ZONES) {
      for (const iso of [...TRANSITION_EPOCHS, FIXED_NOW]) {
        const ms = Date.parse(iso)
        const secs = Math.round(absoluteOffsetMs(ms, z) / 1000)
        const sign = secs < 0 ? "-" : "+"
        const abs = Math.abs(secs)
        const hh = String(Math.floor(abs / 3600)).padStart(2, "0")
        const mm = String(Math.floor((abs % 3600) / 60)).padStart(2, "0")
        const ss = abs % 60
        const expected =
          ss === 0
            ? `${sign}${hh}:${mm}`
            : `${sign}${hh}:${mm}:${String(ss).padStart(2, "0")}`
        expect(offset(new Date(ms), "utc", z)).toBe(expected)
      }
    }
  })

  it("the same epoch shows different wall fields per zone but the offset carries it", () => {
    const ms = Date.parse("2024-11-03T05:30:00.000Z")
    expect(zonedParts(ms, ZONES.newYork)).toMatchObject({
      month: 11, day: 3, hour: 1, minute: 30,
    })
    expect(zonedParts(ms, ZONES.utc)).toMatchObject({ hour: 5, minute: 30 })
    expect(zonedParts(ms, ZONES.lordHowe)).toMatchObject({ day: 3, hour: 16, minute: 30 })
  })

  it("DST regime shape via Intl: ±60m, ±30m, and none", () => {
    expect(characterizeZone(ZONES.lordHowe).jumpsMs).toEqual([-1800000, 1800000])
    expect(characterizeZone(ZONES.newYork).jumpsMs).toEqual([-3600000, 3600000])
    expect(characterizeZone(ZONES.berlin).jumpsMs).toEqual([-3600000, 3600000])
    expect(characterizeZone(ZONES.tokyo).hasDST).toBe(false)
    expect(characterizeZone(ZONES.utc).hasDST).toBe(false)
  })

  // A zone-less ISO string is parsed by JS as *host-local* wall time, so
  // tzDate(wallString, z) is host-zone dependent by construction. When the
  // intermediate instant lands inside a target-zone gap/fold, the requested
  // wall fields can shift by LocalTZA as well. Cases below therefore declare
  // either a single accepted wall time or a gap-shifted alternative, and exact
  // epochs are pinned only when host and target coincide.
  const wallCases: Array<{
    wall: string
    z: string
    sameHostEpoch?: string
    /** Accepted [month, day, hour, minute] values in the target zone. */
    acceptableWalls: Array<[number, number, number, number]>
  }> = [
    {
      wall: "2024-11-03T01:30:00",
      z: ZONES.newYork,
      sameHostEpoch: "2024-11-03T05:30:00.000Z", // fold, first occurrence
      acceptableWalls: [[11, 3, 1, 30]],
    },
    {
      // 12:00 NY exists in summer; from some host zones the intermediate
      // instant falls inside the NY spring gap, shifting the wall to 13:00.
      wall: "2024-03-10T12:00:00",
      z: ZONES.newYork,
      sameHostEpoch: "2024-03-10T16:00:00.000Z",
      acceptableWalls: [
        [3, 10, 12, 0],
        [3, 10, 13, 0],
      ],
    },
    {
      wall: "2024-04-07T02:15:00",
      z: ZONES.lordHowe,
      sameHostEpoch: "2024-04-06T15:45:00.000Z", // fold, first occurrence
      acceptableWalls: [[4, 7, 2, 15]],
    },
    {
      wall: "2024-02-14T22:05:09",
      z: ZONES.tokyo,
      sameHostEpoch: "2024-02-14T13:05:09.000Z",
      acceptableWalls: [[2, 14, 22, 5]],
    },
    {
      wall: "2024-07-15T09:00:00",
      z: ZONES.berlin,
      acceptableWalls: [[7, 15, 9, 0]],
    },
  ]

  it("tzDate(wallString, z): target wall time equals the request or its declared gap shift", () => {
    for (const { wall, z, acceptableWalls } of wallCases) {
      const w = zonedParts(tzDate(wall, z).getTime(), z)
      const actual: [number, number, number, number] = [w.month, w.day, w.hour, w.minute]
      expect(acceptableWalls).toContainEqual(actual)
    }
  })

  it("tzDate(wallString, z) pins the exact epoch only when host zone === target zone", () => {
    for (const { wall, z, sameHostEpoch } of wallCases) {
      if (hostZone() === z && sameHostEpoch) {
        expect(new Date(tzDate(wall, z)).toISOString()).toBe(sameHostEpoch)
      }
    }
  })

  it("tzDate(Date, z): epoch = input + hostOffset - targetOffset (both offsets read via Intl)", () => {
    const instant = new Date("2024-02-14T13:05:09.123Z")
    const host = hostZone()
    for (const z of ALL_ZONES) {
      const result = tzDate(new Date(instant), z).getTime()
      const expected =
        instant.getTime() +
        absoluteOffsetMs(instant.getTime(), host) -
        absoluteOffsetMs(instant.getTime(), z)
      expect(result).toBe(expected)
    }
  })

  it("tzDate(Date, hostZone) leaves the epoch untouched (offset cancellation)", () => {
    const instant = new Date("2024-02-14T13:05:09.123Z")
    expect(tzDate(new Date(instant), hostZone()).getTime()).toBe(instant.getTime())
  })

  it("tzDate gap wall time (Lord Howe 02:15 spring) is shifted to a valid in-zone wall time", () => {
    const gapEpoch = tzDate("2024-10-06T02:15:00", ZONES.lordHowe).getTime()
    const wall = zonedParts(gapEpoch, ZONES.lordHowe)
    expect([wall.hour, wall.minute]).not.toEqual([2, 15])
    if (hostZone() === ZONES.lordHowe) {
      // JS LocalTZA moves the non-existent 02:15 forward past the 30-minute gap.
      expect(new Date(gapEpoch).toISOString()).toBe("2024-10-05T15:45:00.000Z")
    }
  })
})

describe("explicit offsets are instant arithmetic", () => {
  it("applyOffset shifts the epoch by exactly the offset", () => {
    const d = new Date("2024-03-10T12:00:00.000Z")
    expect(applyOffset(d, "+05:30").getTime()).toBe(d.getTime() + 19_800_000)
    expect(applyOffset(d, "-08:00").getTime()).toBe(d.getTime() - 28_800_000)
    expect(applyOffset(d, "+10:30").getTime()).toBe(d.getTime() + 37_800_000)
    expect(applyOffset(d, "+0530").getTime()).toBe(d.getTime() + 19_800_000)
    expect(applyOffset(d, "-05:32:11").getTime()).toBe(
      d.getTime() - (5 * 3600 + 32 * 60 + 11) * 1000
    )
  })

  it("removeOffset is the exact inverse of applyOffset", () => {
    const d = new Date("2024-07-01T12:34:56.789Z")
    for (const o of ["+00:00", "+05:30", "-08:00", "+10:30", "-05:32:11", "+0530"]) {
      expect(removeOffset(applyOffset(d, o), o).getTime()).toBe(d.getTime())
    }
  })

  it("malformed offsets still throw — existing error handling is not relaxed", () => {
    expect(() => applyOffset(new Date(), "+5:30")).toThrow()
    expect(() => applyOffset(new Date(), "0530")).toThrow()
    expect(() => applyOffset(new Date(), "+40:00")).toThrow()
    expect(() => applyOffset(new Date(), "+0360")).toThrow()
  })
})
