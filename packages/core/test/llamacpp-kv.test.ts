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
    expect(typeof LlamaCppKV.isSessionKvOffloaded).toBe("function")
    expect(typeof LlamaCppKV.markSessionKvOffloaded).toBe("function")
    expect(typeof LlamaCppKV.selectParentSlot).toBe("function")
  })

  it("tracks offloaded session IDs and selects parent slot with highest token count", () => {
    const sid = "ses_test_offload_tracking"
    expect(LlamaCppKV.isSessionKvOffloaded(sid)).toBe(false)
    LlamaCppKV.markSessionKvOffloaded(sid, true)
    expect(LlamaCppKV.isSessionKvOffloaded(sid)).toBe(true)
    LlamaCppKV.markSessionKvOffloaded(sid, false)
    expect(LlamaCppKV.isSessionKvOffloaded(sid)).toBe(false)

    expect(
      LlamaCppKV.selectParentSlot([
        { id: 0, n_past: 100 },
        { id: 1, n_past: 42_000 },
      ]),
    ).toBe(1)
  })

  it("enforces exclusive llamacpp provider check and >65% context usage threshold", () => {
    expect(LlamaCppKV.isLlamaCppProvider("llamacpp")).toBe(true)
    expect(LlamaCppKV.isLlamaCppProvider("llama.cpp")).toBe(true)
    expect(LlamaCppKV.isLlamaCppProvider("LLAMACPP")).toBe(true)
    expect(LlamaCppKV.isLlamaCppProvider("mlx")).toBe(false)
    expect(LlamaCppKV.isLlamaCppProvider("esca")).toBe(false)
    expect(LlamaCppKV.isLlamaCppProvider("lmstudio")).toBe(false)
    expect(LlamaCppKV.isLlamaCppProvider("openai")).toBe(false)
    expect(LlamaCppKV.isLlamaCppProvider(undefined)).toBe(false)

    // <= 65% does NOT trigger disk offload (fits in memory)
    expect(LlamaCppKV.isAboveOffloadThreshold(50_000, 100_000)).toBe(false)
    expect(LlamaCppKV.isAboveOffloadThreshold(65_000, 100_000)).toBe(false)
    // > 65% triggers disk offload
    expect(LlamaCppKV.isAboveOffloadThreshold(65_001, 100_000)).toBe(true)
    expect(LlamaCppKV.isAboveOffloadThreshold(80_000, 100_000)).toBe(true)

    expect(LlamaCppKV.shouldOffloadSlot({ id: 0, n_past: 60_000, n_ctx: 100_000 })).toBe(false)
    expect(LlamaCppKV.shouldOffloadSlot({ id: 0, n_past: 65_000, n_ctx: 100_000 })).toBe(false)
    expect(LlamaCppKV.shouldOffloadSlot({ id: 0, n_past: 66_000, n_ctx: 100_000 })).toBe(true)
  })
})
