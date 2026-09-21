# Deterministic date test matrix

These specs establish a layered contract for Tempo's date math so the suite
means the same thing on any host default timezone and ICU build.

## Layers

| File | Layer | What is asserted |
| --- | --- | --- |
| `instant.spec.ts` | **Instant** | Pure epoch operations: `addMillisecond` (sub-second), elapsed-time `diff*` measured in real ms, explicit offset arithmetic, `tzDate` epoch mapping. Host zone cannot change the result. |
| `wall-clock.spec.ts` | **Wall clock** | `addDay/Hour/Minute/Second/Millisecond` write local fields. Assertions are wall fields via the Intl oracle; gap/fold pairs cover spring missing and fall repeated moments (60-min and 30-min). |
| `calendar.spec.ts` | **Calendar units** | `addMonth/Year` target fields against hand-rolled Gregorian math, clamp vs forward overflow, leap-day/month-end pairs, week anchors, closed-interval boundary adjacency, and add/diff inverses per unit and mode. |
| `format-parse.spec.ts` | **Text** | Round-trips only for formats carrying date+time+offset; missing fields follow fixed-`now` defaults and host-local interpretation; locale assertions are capability-gated and structured. |
| `property.spec.ts` | **Generated** | Fixed-seed (`helpers.ts` `SEED`) mulberry32 generator biased to transitions/month ends, with a binary `shrink()` to the nearest boundary. |

## Reference oracle (`oracle.ts`)

Expectations never restate the implementation: wall fields come from
`Intl.DateTimeFormat.formatToParts` with an explicit IANA zone, calendar math is
independent proleptic Gregorian code, and transitions are discovered by
scanning offset changes rather than hard-coded dates.

## Fixed inputs

* Every test freezes the clock to `FIXED_NOW` (`2024-02-14T13:05:09.123Z`).
* Exact epochs inside DST gaps/folds are only pinned when the process host
  zone is the zone under test; elsewhere wall fields are asserted.
* Covered zones: `UTC`, `America/New_York`, `Europe/Berlin`,
  `Australia/Lord_Howe` (30-minute jumps), `Asia/Tokyo` (no DST control).

## Running

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm test -- --run                       # existing suite (NY host)
corepack pnpm run test:determinism               # one vitest child per zone
TEMPO_TEST_ZONES="UTC,Asia/Tokyo" corepack pnpm run test:determinism
corepack pnpm run test:heavy                     # TEMPO_HEAVY=1, all zones
```

No bundled tzdb: all zone data comes from the runtime's ICU. No snapshots of
locale punctuation: structured Intl parts are used instead.
