import { expect, test } from "bun:test"
import { Option } from "effect"
import { Env } from "../src/env"

test("session environment omits server credentials", () => {
  const previousPassword = process.env.OPENCODE_PASSWORD
  const previousLegacyPassword = process.env.OPENCODE_SERVER_PASSWORD
  const previousValue = process.env.OPENCODE_SESSION_ENV_TEST
  process.env.OPENCODE_PASSWORD = "password"
  process.env.OPENCODE_SERVER_PASSWORD = "legacy"
  process.env.OPENCODE_SESSION_ENV_TEST = "included"

  const environment = Env.session()

  if (previousPassword === undefined) delete process.env.OPENCODE_PASSWORD
  else process.env.OPENCODE_PASSWORD = previousPassword
  if (previousLegacyPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
  else process.env.OPENCODE_SERVER_PASSWORD = previousLegacyPassword
  if (previousValue === undefined) delete process.env.OPENCODE_SESSION_ENV_TEST
  else process.env.OPENCODE_SESSION_ENV_TEST = previousValue

  expect(environment.OPENCODE_PASSWORD).toBeUndefined()
  expect(environment.OPENCODE_SERVER_PASSWORD).toBeUndefined()
  expect(environment.OPENCODE_SESSION_ENV_TEST).toBe("included")
})

test("applyObjectivesCliFlags enables unattended when defaultUnattended is true unless explicitly overridden", () => {
  const prevOverrides = process.env.OPENCODE_OBJECTIVES_CLI_OVERRIDES
  const prevUnattended = process.env.OPENCODE_UNATTENDED
  const prevObjUnattended = process.env.OPENCODE_OBJECTIVES_UNATTENDED

  try {
    delete process.env.OPENCODE_OBJECTIVES_CLI_OVERRIDES
    delete process.env.OPENCODE_UNATTENDED
    delete process.env.OPENCODE_OBJECTIVES_UNATTENDED

    Env.applyObjectivesCliFlags({}, { defaultUnattended: true })
    expect(JSON.parse(process.env.OPENCODE_OBJECTIVES_CLI_OVERRIDES!)).toEqual({ unattended: true })

    delete process.env.OPENCODE_OBJECTIVES_CLI_OVERRIDES
    Env.applyObjectivesCliFlags({ objectivesUnattended: Option.some(false) }, { defaultUnattended: true })
    expect(JSON.parse(process.env.OPENCODE_OBJECTIVES_CLI_OVERRIDES!)).toEqual({ unattended: false })

    delete process.env.OPENCODE_OBJECTIVES_CLI_OVERRIDES
    process.env.OPENCODE_UNATTENDED = "false"
    Env.applyObjectivesCliFlags({}, { defaultUnattended: true })
    expect(process.env.OPENCODE_OBJECTIVES_CLI_OVERRIDES).toBeUndefined()
  } finally {
    if (prevOverrides === undefined) delete process.env.OPENCODE_OBJECTIVES_CLI_OVERRIDES
    else process.env.OPENCODE_OBJECTIVES_CLI_OVERRIDES = prevOverrides
    if (prevUnattended === undefined) delete process.env.OPENCODE_UNATTENDED
    else process.env.OPENCODE_UNATTENDED = prevUnattended
    if (prevObjUnattended === undefined) delete process.env.OPENCODE_OBJECTIVES_UNATTENDED
    else process.env.OPENCODE_OBJECTIVES_UNATTENDED = prevObjUnattended
  }
})
