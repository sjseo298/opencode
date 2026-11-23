import { expect, test } from "bun:test"
import { computeNightWindowInfo } from "../src/alibaba-usage.js"

// The night window is 14:00–00:00 UTC daily (22:00–08:00 UTC+8). isActive and the
// countdown are pure UTC math, so they are deterministic regardless of the host
// timezone; localStart/localEnd are timezone-dependent and intentionally not pinned.

test("inactive morning counts down positively to the next 14:00 UTC start", () => {
  // 06:20:47 in Bogotá (UTC-5) = 11:20:47 UTC, before today's 14:00 UTC start.
  const info = computeNightWindowInfo(Date.UTC(2026, 10, 23, 11, 20, 47))
  expect(info.isActive).toBe(false)
  expect(info.countdown.trim()).toBe("2h 39m")
})

test("inactive countdown is never negative across the pre-window span", () => {
  for (const hour of [0, 6, 11, 13]) {
    const info = computeNightWindowInfo(Date.UTC(2026, 10, 23, hour, 0, 0))
    expect(info.isActive).toBe(false)
    expect(info.countdown).not.toContain("-")
  }
  // One minute before the start still waits positively rather than wrapping negative.
  expect(computeNightWindowInfo(Date.UTC(2026, 10, 23, 13, 59, 0)).countdown.trim()).toBe("0h 1m")
})

test("active window counts down to its end, from 10h at start to 0h at the boundary", () => {
  const start = computeNightWindowInfo(Date.UTC(2026, 10, 23, 14, 0, 0))
  expect(start.isActive).toBe(true)
  expect(start.countdown.trim()).toBe("10h 0m left")

  const middle = computeNightWindowInfo(Date.UTC(2026, 10, 23, 16, 0, 0))
  expect(middle.isActive).toBe(true)
  expect(middle.countdown.trim()).toBe("8h 0m left")

  const nearEnd = computeNightWindowInfo(Date.UTC(2026, 10, 23, 23, 59, 0))
  expect(nearEnd.isActive).toBe(true)
  expect(nearEnd.countdown.trim()).toBe("0h 1m left")
})

test("window flips to inactive exactly at the 00:00 UTC end boundary", () => {
  const info = computeNightWindowInfo(Date.UTC(2026, 10, 24, 0, 0, 0))
  expect(info.isActive).toBe(false)
  expect(info.countdown.trim()).toBe("14h 0m")
})