import { describe, expect, it } from "bun:test"
import { normalizeObjectivesConfigInput, DEFAULT_OBJECTIVES_CONFIG } from "../src/plugin/builtin/objectives-model.js"
import { LlamaCppKV } from "../src/session/llamacpp-kv.js"

describe("Objectives Config llama.cpp KV offload and subagent model", () => {
  it("defaults llamacppKvOffload to true in DEFAULT_OBJECTIVES_CONFIG", () => {
    expect(DEFAULT_OBJECTIVES_CONFIG.llamacppKvOffload).toBe(true)
  })

  it("normalizes llamacpp_kv_offload and subagent_model aliases properly", () => {
    const parsed = normalizeObjectivesConfigInput({
      llamacpp_kv_offload: false,
      subagent_model: "test-provider/test-model",
      llamacpp_slot_save_path: "/tmp/slots",
    })

    expect(parsed.llamacppKvOffload).toBe(false)
    expect(parsed.subagentModel).toBe("test-provider/test-model")
    expect(parsed.llamacppSlotSavePath).toBe("/tmp/slots")
  })

  it("normalizes camelCase variants correctly", () => {
    const parsed = normalizeObjectivesConfigInput({
      llamacppKvOffload: true,
      subagentModel: "vendor/small-model",
    })

    expect(parsed.llamacppKvOffload).toBe(true)
    expect(parsed.subagentModel).toBe("vendor/small-model")
  })

  it("LlamaCppKV has expected functions defined", () => {
    expect(typeof LlamaCppKV.resolveOrigin).toBe("function")
    expect(typeof LlamaCppKV.getSlots).toBe("function")
    expect(typeof LlamaCppKV.saveSlot).toBe("function")
    expect(typeof LlamaCppKV.restoreSlot).toBe("function")
    expect(typeof LlamaCppKV.eraseSlot).toBe("function")
    expect(typeof LlamaCppKV.withOffloadedSlot).toBe("function")
  })
})
