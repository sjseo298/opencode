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

  it("enforces exclusive llamacpp provider check and mechanical overflow probability calculation", () => {
    expect(LlamaCppKV.isLlamaCppProvider("llamacpp")).toBe(true)
    expect(LlamaCppKV.isLlamaCppProvider("llama.cpp")).toBe(true)
    expect(LlamaCppKV.isLlamaCppProvider("LLAMACPP")).toBe(true)
    expect(LlamaCppKV.isLlamaCppProvider("mlx")).toBe(false)
    expect(LlamaCppKV.isLlamaCppProvider("esca")).toBe(false)
    expect(LlamaCppKV.isLlamaCppProvider("lmstudio")).toBe(false)
    expect(LlamaCppKV.isLlamaCppProvider("openai")).toBe(false)
    expect(LlamaCppKV.isLlamaCppProvider(undefined)).toBe(false)

    const sessionID = "ses_mech_test"
    LlamaCppKV.clearSubagentTelemetry(sessionID)

    // 1. Non-llamacpp provider or kvUnified=false never offloads
    expect(
      LlamaCppKV.computeOffloadDecision({
        sessionID,
        providerID: "mlx",
        kvUnified: true,
        contextLimit: 100_000,
        parentUsedTokens: 80_000,
      }).shouldOffload,
    ).toBe(false)

    expect(
      LlamaCppKV.computeOffloadDecision({
        sessionID,
        providerID: "llamacpp",
        kvUnified: false,
        contextLimit: 100_000,
        parentUsedTokens: 80_000,
      }).shouldOffload,
    ).toBe(false)

    // 2. Low parent usage + small estimated task -> low overflow probability -> stays in RAM
    const lowDecision = LlamaCppKV.computeOffloadDecision({
      sessionID,
      providerID: "llamacpp",
      kvUnified: true,
      contextLimit: 100_000, // ceiling = 84,000
      parentUsedTokens: 30_000, // availableWithoutOffload = 54,000
      estimatedTaskTokens: 20_000,
    })
    expect(lowDecision.shouldOffload).toBe(false)
    expect(lowDecision.overflowProbability).toBeLessThan(0.5)

    // 3. Same 30,000 parent tokens (only 30% of window!), but subagent task is estimated at 50,000 tokens
    // A fixed 65% rule would fail to offload, whereas the mechanical calculator detects overflow risk!
    const heavyTaskDecision = LlamaCppKV.computeOffloadDecision({
      sessionID,
      providerID: "llamacpp",
      kvUnified: true,
      contextLimit: 100_000, // ceiling = 84,000
      parentUsedTokens: 30_000, // availableWithoutOffload = 54,000
      estimatedTaskTokens: 50_000, // projected demand > 54,000
    })
    expect(heavyTaskDecision.shouldOffload).toBe(true)
    expect(heavyTaskDecision.overflowProbability).toBeGreaterThanOrEqual(0.5)

    // 4. Historical telemetry adaptation: if recent subagents in this session consumed 45k tokens and compacted,
    // even without an explicit estimatedTaskTokens, the mechanical model learns from session history and offloads!
    LlamaCppKV.recordSubagentTelemetry(sessionID, {
      childSessionID: "sub_hist_1",
      tokensUsed: 42_000,
      estimatedTokens: 20_000,
      hadCompaction: true,
      hadOverflow: false,
      timestamp: Date.now() - 2000,
    })
    LlamaCppKV.recordSubagentTelemetry(sessionID, {
      childSessionID: "sub_hist_2",
      tokensUsed: 46_000,
      estimatedTokens: 25_000,
      hadCompaction: true,
      hadOverflow: false,
      timestamp: Date.now() - 1000,
    })

    const learnedDecision = LlamaCppKV.computeOffloadDecision({
      sessionID,
      providerID: "llamacpp",
      kvUnified: true,
      contextLimit: 100_000, // ceiling = 84,000
      parentUsedTokens: 35_000, // availableWithoutOffload = 49,000
    })
    expect(learnedDecision.historicalSampleCount).toBe(2)
    expect(learnedDecision.historicalCompactionRate).toBe(1)
    expect(learnedDecision.shouldOffload).toBe(true)
    expect(learnedDecision.overflowProbability).toBeGreaterThanOrEqual(0.5)

    LlamaCppKV.clearSubagentTelemetry(sessionID)
  })
})
