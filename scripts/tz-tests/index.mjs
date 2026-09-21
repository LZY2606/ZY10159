#!/usr/bin/env node
/**
 * Multi-timezone deterministic test runner.
 *
 * Spawns one vitest child process per required IANA zone with a distinct TZ
 * environment variable, so the same spec files must reach identical
 * conclusions regardless of the host's default zone. Also runs once under a
 * synthetic numeric offset (Australia/Lord_Howe is a real IANA zone, used for
 * the 30-minute regime; no tzdb is bundled — zones come from the host ICU).
 *
 * Extra vitest arguments after "--" are forwarded (e.g. "--run").
 *
 * Environment:
 *   TEMPO_TEST_ZONES="UTC,Asia/Tokyo"  override the zone list
 *   TEMPO_HEAVY=1                      forwarded; enables the heavier property
 *                                      rounds inside the generated suite
 */
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, "..", "..")

const DEFAULT_ZONES = [
  "UTC",
  "America/New_York",
  "Europe/Berlin",
  "Australia/Lord_Howe",
  "Asia/Tokyo", // no DST control
]

const zones = (process.env.TEMPO_TEST_ZONES || DEFAULT_ZONES.join(","))
  .split(",")
  .map((z) => z.trim())
  .filter(Boolean)

const passthroughArgs = process.argv.slice(2)

let failures = 0

for (const zone of zones) {
  const label = `\n▼ TZ=${zone}`
  console.log(label)
  const result = spawnSync(
    "corepack",
    ["pnpm", "exec", "vitest", "run", "src/__tests__/determinism", ...passthroughArgs],
    {
      cwd: repoRoot,
      stdio: "inherit",
      env: { ...process.env, TZ: zone },
    }
  )
  if (result.status !== 0) {
    failures++
    console.error(`✗ zone failed: ${zone}`)
  } else {
    console.log(`✓ zone passed: ${zone}`)
  }
}

console.log(`\n${zones.length - failures}/${zones.length} zone processes passed`)
process.exit(failures === 0 ? 0 : 1)
