import { describe, it, expect } from "vitest"
import { yearStart } from "../yearStart"

describe("yearStart", () => {
  it("can become the start of the year", () => {
    const d = yearStart("2023-02-22T12:00:00Z")
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2023, 0, 1])
    expect([d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()]).toEqual([
      0, 0, 0, 0,
    ])
  })

  it("can give the end of the current year", () => {
    const compare = new Date()
    compare.setMonth(0, 1)
    compare.setHours(0, 0, 0, 0)
    expect(yearStart()).toEqual(compare)
  })
})
