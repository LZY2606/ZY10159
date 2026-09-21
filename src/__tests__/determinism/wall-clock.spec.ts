/**
 * Layer 2 — WALL-CLOCK TIME.
 *
 * addDay / addHour / addMinute / addSecond / addMillisecond all write *local
 * wall-clock fields* (they call `Date#setDate/setHours/...`). The contract is
 * therefore stated in wall fields, not epoch milliseconds:
 *
 *   add[Unit](date, n) has the requested wall field advanced by n units after
 *   JS LocalTZA normalization; crossing a DST gap pushes the result forward and
 *   landing in a fold takes the first (pre-transition) occurrence.
 *
 * Every assertion here is either:
 *  - universal but expressed as wall fields read through the Intl oracle, or
 *  - host-zone guarded, using explicit expected epochs only for the zone the
 *    process was launched in.
 *
 * Spring-missing and fall-repeated moments always appear as PAIRS, including
 * the 30-minute Lord Howe jump; no single "a day is 24 hours" assertion is
 * allowed to cover both.
 */
import { describe, it, expect } from "vitest"
import {
  addDay,
  addHour,
  addMinute,
  addSecond,
  addMillisecond,
} from "../../index"
import {
  ZONES,
  hostZone,
  whenHostZoneIs,
  useFixedNow,
  MS_PER_HOUR,
} from "./helpers"
import { zonedParts, absoluteOffsetMs } from "./oracle"

useFixedNow()

/** Local wall constructor — only used inside host-guarded transition blocks. */
function localWall(y: number, mo: number, d: number, h: number, mi: number, s = 0, ms = 0) {
  return new Date(y, mo - 1, d, h, mi, s, ms)
}

interface TransitionSpec {
  zone: string
  label: string
  kind: "spring" | "fall"
  jumpMs: number
  /** [y, m, d] of the transition day. */
  day: [number, number, number]
  /** First non-existent (spring) / first repeated (fall) wall hour-minute. */
  wall: [number, number]
  /** End of the gap / fold window. */
  wallEnd: [number, number]
}

const TRANSITIONS: TransitionSpec[] = [
  {
    zone: ZONES.newYork,
    label: "New York spring gap",
    kind: "spring",
    jumpMs: MS_PER_HOUR,
    day: [2024, 3, 10],
    wall: [2, 0],
    wallEnd: [3, 0],
  },
  {
    zone: ZONES.newYork,
    label: "New York fall fold",
    kind: "fall",
    jumpMs: -MS_PER_HOUR,
    day: [2024, 11, 3],
    wall: [1, 0],
    wallEnd: [2, 0],
  },
  {
    zone: ZONES.berlin,
    label: "Berlin spring gap",
    kind: "spring",
    jumpMs: MS_PER_HOUR,
    day: [2024, 3, 31],
    wall: [2, 0],
    wallEnd: [3, 0],
  },
  {
    zone: ZONES.berlin,
    label: "Berlin fall fold",
    kind: "fall",
    jumpMs: -MS_PER_HOUR,
    day: [2024, 10, 27],
    wall: [2, 0],
    wallEnd: [3, 0],
  },
  {
    zone: ZONES.lordHowe,
    label: "Lord Howe spring 30-minute gap",
    kind: "spring",
    jumpMs: MS_PER_HOUR / 2,
    day: [2024, 10, 6],
    wall: [2, 0],
    wallEnd: [2, 30],
  },
  {
    zone: ZONES.lordHowe,
    label: "Lord Howe fall 30-minute fold",
    kind: "fall",
    jumpMs: -MS_PER_HOUR / 2,
    day: [2024, 4, 7],
    // Clocks go 01:30 (+11:00), then repeat 01:30..02:00 at +10:30.
    wall: [1, 30],
    wallEnd: [2, 0],
  },
]

describe("wall-field adders preserve the requested field across ordinary days", () => {
  it("addHour(d, 1) advances the local hour by one wall hour", () => {
    const d = new Date("2024-02-14T10:00:00.000Z")
    for (const n of [1, 5, -2, 24]) {
      const r = addHour(new Date(d), n)
      const p = zonedParts(r.getTime(), hostZone())
      const base = zonedParts(d.getTime() + n * MS_PER_HOUR, hostZone())
      // Wall hour/minute agreement even if (near transitions) the epoch differs.
      expect([p.hour, p.minute]).toEqual([base.hour, base.minute])
    }
  })
})

/**
 * Spring-missing moments and fall-repeated moments as pairs. Runs the explicit
 * epoch assertions only in the zone whose local clock this process owns.
 */
describe("DST transition pairs: gap (spring) and fold (fall)", () => {
  for (const t of TRANSITIONS) {
    const guarded = whenHostZoneIs(t.zone)
    const run = guarded ? it : it.skip

    run(`${t.label}: wall times inside the transition normalize per LocalTZA`, () => {
      const [y, m, d] = t.day
      const [wh] = t.wall
      const [eh, em] = t.wallEnd

      // Wall minute of a time inside the gap/fold window. 60-minute windows
      // start at :00 so sample :30; Lord Howe's 30-minute windows start at
      // :00 (gap) or :30 (fold), so sample :15 or :45 respectively.
      const midMinute =
        t.kind === "spring"
          ? Math.abs(t.jumpMs) === MS_PER_HOUR
            ? 30 // [02:00, 03:00)
            : 15 // Lord Howe [02:00, 02:30)
          : t.wall[1] + Math.abs(t.jumpMs) / 60000 / 2

      // Total wall minutes after the LocalTZA forward shift.
      const shiftedTotal = midMinute + t.jumpMs / 60000
      const shiftedHour = wh + Math.floor(shiftedTotal / 60)
      const shiftedMinute = shiftedTotal % 60

      if (t.kind === "spring") {
        // PAIR A — the missing wall time: LocalTZA shifts it forward by jump.
        const inside = localWall(y, m, d, wh, midMinute, 0)
        const parts = zonedParts(inside.getTime(), t.zone)
        expect([parts.hour, parts.minute]).toEqual([shiftedHour, shiftedMinute])
        // PAIR B — the first valid instant at the end of the gap.
        const after = localWall(y, m, d, eh, em, 0)
        const afterParts = zonedParts(after.getTime(), t.zone)
        expect([afterParts.hour, afterParts.minute]).toEqual([eh, em])
        // The shifted wall time equals the same epoch as constructing the
        // post-gap valid wall fields directly (LocalTZA many-to-one on gaps).
        const equivalent = localWall(y, m, d, shiftedHour, shiftedMinute, 0)
        expect(inside.getTime()).toBe(equivalent.getTime())
      } else {
        // PAIR A — the repeated wall time resolves to the FIRST occurrence
        // (pre-transition offset).
        const repeated = localWall(y, m, d, wh, midMinute, 0)
        const repeatedParts = zonedParts(repeated.getTime(), t.zone)
        expect([repeatedParts.hour, repeatedParts.minute]).toEqual([wh, midMinute])
        const offsetAtFirst = absoluteOffsetMs(repeated.getTime(), t.zone)
        // PAIR B — the same wall time one jump later in epoch: SECOND
        // occurrence, different offset, identical wall fields.
        const second = new Date(repeated.getTime() + Math.abs(t.jumpMs))
        const secondParts = zonedParts(second.getTime(), t.zone)
        expect([secondParts.hour, secondParts.minute]).toEqual([wh, midMinute])
        expect(absoluteOffsetMs(second.getTime(), t.zone)).not.toBe(offsetAtFirst)
        expect(Math.abs(absoluteOffsetMs(second.getTime(), t.zone) - offsetAtFirst)).toBe(
          Math.abs(t.jumpMs)
        )
        // And the first wall time strictly after the fold exists uniquely.
        const after = localWall(y, m, d, eh, em, 0)
        const afterParts = zonedParts(after.getTime(), t.zone)
        expect([afterParts.hour, afterParts.minute]).toEqual([eh, em])
      }
    })
  }
})

describe("addDay is a calendar day (wall date increment), never 24 fixed hours", () => {
  const noDstRun = whenHostZoneIs([ZONES.utc, ZONES.tokyo]) ? it : it.skip
  noDstRun("in no-DST zones adding one day equals exactly 24h", () => {
    const d = new Date("2024-03-09T15:00:00.000Z")
    const r = addDay(new Date(d), 1)
    expect(r.getTime() - d.getTime()).toBe(86_400_000)
  })

  const dayCases: Array<{ zone: string; epochBefore: string; epochAfter: string }> = [
    // NY spring: local noon Sat -> local noon Sun is 23h.
    {
      zone: ZONES.newYork,
      epochBefore: "2024-03-09T17:00:00.000Z", // noon local
      epochAfter: "2024-03-10T16:00:00.000Z",
    },
    // NY fall: local noon Sun -> local noon Mon is 25h.
    {
      zone: ZONES.newYork,
      epochBefore: "2024-11-02T16:00:00.000Z",
      epochAfter: "2024-11-03T17:00:00.000Z",
    },
    // LH spring: local noon Sat -> noon Sun is 23.5h (noon is +1030/1100).
    {
      zone: ZONES.lordHowe,
      epochBefore: "2024-10-05T01:30:00.000Z", // noon +1030
      epochAfter: "2024-10-06T01:00:00.000Z", // noon +1100
    },
    // LH fall: local noon Sat -> noon Sun is 24.5h.
    {
      zone: ZONES.lordHowe,
      epochBefore: "2024-04-06T01:00:00.000Z", // noon +1100
      epochAfter: "2024-04-07T01:30:00.000Z", // noon +1030
    },
  ]

  for (const c of dayCases) {
    const run = whenHostZoneIs(c.zone) ? it : it.skip
    run(`calendar day across ${c.zone} transition keeps local noon; epoch delta is not 24h`, () => {
      const before = new Date(c.epochBefore)
      const after = addDay(new Date(before), 1)
      expect(after.toISOString()).toBe(c.epochAfter)
      const pb = zonedParts(before.getTime(), c.zone)
      const pa = zonedParts(after.getTime(), c.zone)
      expect([pa.hour, pa.minute]).toEqual([pb.hour, pb.minute])
      expect(after.getTime() - before.getTime()).not.toBe(86_400_000)
    })
  }

  it("wall invariant: addDay increments the local ordinal date by one and keeps the time of day", () => {
    // The input is a local wall date for THIS process zone (noon on a fixed
    // day), so the assertion is deterministic and the runner covers every zone.
    const zone = hostZone()
    const base = localWall(2024, 6, 15, 12, 30, 45)
    const before = zonedParts(base.getTime(), zone)
    const after = zonedParts(addDay(new Date(base), 1).getTime(), zone)
    const dayOrdinal = (p: { year: number; month: number; day: number }) =>
      Date.UTC(p.year, p.month - 1, p.day)
    expect(dayOrdinal(after) - dayOrdinal(before)).toBe(86_400_000)
    expect([after.hour, after.minute, after.second]).toEqual([
      before.hour,
      before.minute,
      before.second,
    ])
  })

  it("metamorphic: addDay(d, 1) n times equals addDay(d, n) around every transition", () => {
    for (const t of TRANSITIONS) {
      if (!whenHostZoneIs(t.zone)) continue
      const [y, m, d] = t.day
      const noon = localWall(y, m, d - 2, 12, 0, 0)
      let stepped = new Date(noon)
      for (let i = 0; i < 4; i++) stepped = addDay(stepped, 1)
      expect(stepped.getTime()).toBe(addDay(new Date(noon), 4).getTime())
    }
  })
})

describe("wall setters crossing a transition: metamorphic relation add vs repeated set", () => {
  // Setting hours/minutes in two steps vs one step must agree (LocalTZA is
  // applied once at the end); this catches implementations that normalize
  // after each intermediate set.
  for (const t of TRANSITIONS) {
    const run = whenHostZoneIs(t.zone) ? it : it.skip
    run(`${t.label}: addMinute in one step equals addMinute in two steps`, () => {
      const [y, m, d] = t.day
      const [wh] = t.wall
      const start = localWall(y, m, d, wh - 1, 45, 0)
      const oneShot = addMinute(new Date(start), 30)
      const twoStep = addMinute(addMinute(new Date(start), 10), 20)
      expect(oneShot.getTime()).toBe(twoStep.getTime())
    })
  }

  it("addSecond(3600) differs from addHour(1) only by wall semantics — both documented via local fields", () => {
    const d = new Date("2024-02-14T10:00:00.000Z")
    const a = addSecond(new Date(d), 3600)
    const b = addHour(new Date(d), 1)
    const pa = zonedParts(a.getTime(), hostZone())
    const pb = zonedParts(b.getTime(), hostZone())
    expect([pa.hour, pa.minute, pa.second]).toEqual([pb.hour, pb.minute, pb.second])
  })

  it("addMillisecond within the same millisecond range equals the epoch shift", () => {
    const d = new Date("2024-02-14T10:00:00.250Z")
    expect(addMillisecond(new Date(d), 250).getTime()).toBe(d.getTime() + 250)
    expect(addMillisecond(new Date(d), -250).getTime()).toBe(d.getTime() - 250)
  })
})
