import { describe, it, expect } from "vitest"
import { addDay } from "../addDay"

// Assertions target wall-clock fields (timezone-independent) rather than a
// zone-specific UTC offset, so they hold under every host TZ.
describe("addDay", () => {
  it("gets the next day at the beginning of the month", () => {
    const d = addDay("2022-01-01")
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2022, 0, 2])
  })
  it("gets the next day at the end of the year", () => {
    const d = addDay("2022-12-31")
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2023, 0, 1])
  })
  it("gets the next day by providing specified positive number of days", () => {
    const d = addDay("2022-01-01", 5)
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2022, 0, 6])
  })
  it("gets the next day by providing specified negative number of days", () => {
    const d = addDay("2022-01-01", -5)
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2021, 11, 27])
  })

  // test with the current time is at diffDays
})
