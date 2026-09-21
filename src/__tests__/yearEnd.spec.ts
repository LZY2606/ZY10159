import { describe, it, expect } from "vitest"
import { yearEnd } from "../yearEnd"

describe("yearEnd", () => {
  it("can become the end of the year", () => {
    const d = yearEnd("2023-02-22T12:00:00Z")
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2023, 11, 31])
    expect([d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()]).toEqual([
      23, 59, 59, 999,
    ])
  })

  it("can give the end of the current year", () => {
    const compare = new Date()
    compare.setMonth(11, 31)
    compare.setHours(23, 59, 59, 999)
    expect(yearEnd()).toEqual(compare)
  })
})
