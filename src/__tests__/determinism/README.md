# Deterministic time-math test matrix

These specs pin Tempo's date arithmetic to an explicit three-layer model so the
suite stops being a "passes on my machine in one zone" artifact.

## Layers

- **instant** — a point on the UTC timeline (epoch ms). Only raw epoch
  construction (`new Date(t + n)`) and `diffMilliseconds` are true instant
  operations in Tempo. See `instant.spec.ts`.
- **wall** — calendar fields as displayed in a zone (`wallFieldsAt` in
  `helpers.ts`, read only through `Intl`).
- **calendar units** — day/week/month/year *target wall fields*. Every Tempo
  `add*` is a wall-nominal setter (`setHours/getHours`, …), so a "day" is not
  always 24 h. See `calendar.spec.ts` and `elapsed.spec.ts`.

## Key metamorphic facts

`addDay(d,1) === addHour(d,24) === addMinute(d,1440) === addSecond(d,86400)
=== addMillisecond(d,86_400_000)` — all five land on the next **wall** day and
share one elapsed duration: **23 h in a spring gap, 25 h in an autumn
overlap**, **23.5 h / 24.5 h** in Australia/Lord_Howe (half-hour jumps).
A single "+1 day is 24 hours" assertion is therefore wrong by construction.

Paired samples cover both sides of every transition for
`America/New_York`, `Europe/Berlin`, `Australia/Lord_Howe`, plus no-DST
controls (`UTC`, `Asia/Kolkata`). Transition instants are discovered at runtime
with `findTransitions()` (Intl tzdb) — no tz data is bundled.

## Determinism

- `FIXED_NOW` is the only "current" instant. Tests never read the host clock;
  values that default to "now" are explicitly checked against `new Date()` and
  documented as defaults, not round-trips.
- Property rounds use a fixed-seed mulberry32 generator (`SEED`) over a safe
  2001–2034 envelope. Failing amounts are reduced with `minimizeFailure()` to
  the step adjacent to the DST transition / month boundary.
- Normal round counts run by default; set `TEMPO_HEAVY=1` for the larger
  iteration counts.

## format/parse information content

`roundtrip.spec.ts` only claims same-instant round-trips for formats carrying
year + wall fields + **offset** + fraction. Formats missing the year or offset
are checked against their declared default (host-now year, host-local naive
interpretation) or their documented ambiguity (e.g. the repeated 01:30 in the
New York autumn overlap). Locale cases first probe ICU support
(`localeSupported`) and assert structured parts or Tempo's stable behavior —
never a specific Node build's punctuation.

## Boundaries

`boundaries.spec.ts` models end-of-X inclusively (`...:59.999`) via the
half-open interval `[start, end + 1ms)`, asserting adjacency exactly and
separately from the inclusive last-instant predicate. `monthEnd` intentionally
preserves wall time.

## Multi-timezone subprocess driver

`tz-matrix.spec.ts` spawns one vitest child per covered zone with `TZ` pinned
in the child environment and verifies the *same* pass/fail result regardless of
the parent host default. It is inert inside a child (`TEMPO_TZ_CHILD=1`) and can
be disabled with `TEMPO_TZ_MATRIX=0`.

## Commands

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm test -- --run            # full suite under America/New_York + tz children
corepack pnpm run test:tz             # just the multi-zone driver under a UTC parent
TEMPO_HEAVY=1 corepack pnpm run test:heavy   # larger seeded rounds
```
