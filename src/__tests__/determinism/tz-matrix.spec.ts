import { describe, it, expect } from "vitest"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { ZONES, HOST_TZ, HEAVY } from "./helpers"

/**
 * MULTI-TIMEZONE SUBPROCESS DRIVER.
 *
 * The calendar ops above are host-zone local operations. To prove the matrix
 * yields the SAME pass/fail conclusion regardless of the host default zone,
 * this file spawns one vitest child process per covered zone with TZ pinned in
 * the child environment. This is what CI invokes; it also demonstrates how to
 * reproduce a different-host failure locally.
 *
 * Recursion guard: children set TEMPO_TZ_CHILD=1 so this driver becomes inert
 * inside them (a child never spawns grandchildren).
 */
const IS_CHILD = process.env.TEMPO_TZ_CHILD === "1"
const vitestBin = fileURLToPath(
  new URL("../../../node_modules/vitest/vitest.mjs", import.meta.url)
)

// All sibling determinism specs except this driver.
const TARGETS = [
  "src/__tests__/determinism/instant.spec.ts",
  "src/__tests__/determinism/calendar.spec.ts",
  "src/__tests__/determinism/elapsed.spec.ts",
  "src/__tests__/determinism/boundaries.spec.ts",
  "src/__tests__/determinism/roundtrip.spec.ts",
  "src/__tests__/determinism/property.spec.ts",
]

const SKIP_UNLESS = IS_CHILD
  ? "inert inside a TZ child process"
  : process.env.TEMPO_TZ_MATRIX === "0"
    ? "disabled via TEMPO_TZ_MATRIX=0"
    : null

const describeOrSkip = SKIP_UNLESS ? describe.skip : describe

describeOrSkip(`tz matrix (driver; host is ${HOST_TZ})`, () => {
  for (const zone of ZONES) {
    it(`determinism suite passes with TZ=${zone}`, () => {
      const result = spawnSync(process.execPath, [vitestBin, "run", ...TARGETS], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          TZ: zone,
          TEMPO_TZ_CHILD: "1",
          ...(HEAVY ? { TEMPO_HEAVY: "1" } : {}),
        },
      })

      if (result.status !== 0) {
        throw new Error(
          `Child run failed with TZ=${zone} (exit ${result.status}).\n` +
            `--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`
        )
      }
      // Surface the child summary so a green run is auditable.
      const summary = (result.stdout || "")
        .split("\n")
        .filter((line) => /Tests\s+\d+\s+passed|Test Files/.test(line))
        .join(" | ")
      expect(result.status).toBe(0)
      // eslint-disable-next-line no-console
      console.log(`[tz-matrix] ${zone}: ${summary}`)
    }, 60_000)
  }

  it("child and parent agree: the parent host is itself a covered zone", () => {
    expect((ZONES as readonly string[]).includes(HOST_TZ)).toBe(true)
  })
})
