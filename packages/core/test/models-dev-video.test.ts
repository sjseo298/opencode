import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ModelsDev } from "@opencode/core/models-dev"
import snapshotText from "../src/models-dev/snapshot.txt" with { type: "text" }

// The catalog lists the Alibaba video models with only their AI SDK package; the native media
// mapping must keep them runnable through @opencode/ai/providers/alibaba/videos.
describe("ModelsDev Alibaba video routing", () => {
  test("routes aisdk-only token plan video entries to the native videos entrypoint", async () => {
    const snapshots = await Effect.runPromise(ModelsDev.decodeSnapshot(snapshotText))
    const provider = snapshots.find((snapshot) => snapshot.info.id === "alibaba-token-plan")
    expect(provider).toBeDefined()
    for (const id of ["happyhorse-1.1-t2v", "happyhorse-1.1-i2v", "happyhorse-1.1-r2v"]) {
      const model = provider!.models.find((entry) => entry.id === id)
      expect(model).toBeDefined()
      expect(model!.type).toBe("video")
      expect(model!.package).toBe("@opencode/ai/providers/alibaba/videos")
      expect(model!.settings?.baseURL).toBe("https://token-plan.ap-southeast-1.maas.aliyuncs.com")
    }
  })

  test("routes the regional Alibaba video entries to the same entrypoint with their own host", async () => {
    const snapshots = await Effect.runPromise(ModelsDev.decodeSnapshot(snapshotText))
    const provider = snapshots.find((snapshot) => snapshot.info.id === "alibaba")
    expect(provider).toBeDefined()
    const model = provider!.models.find((entry) => entry.id === "happyhorse-1.1-t2v")
    expect(model).toBeDefined()
    expect(model!.package).toBe("@opencode/ai/providers/alibaba/videos")
    expect(model!.settings?.baseURL).toBe("https://dashscope-intl.aliyuncs.com")
  })

  test("keeps image entries on their catalog opencodeai entrypoint", async () => {
    const snapshots = await Effect.runPromise(ModelsDev.decodeSnapshot(snapshotText))
    const provider = snapshots.find((snapshot) => snapshot.info.id === "alibaba-token-plan")
    const model = provider!.models.find((entry) => entry.id === "wan2.7-image")
    expect(model).toBeDefined()
    expect(model!.type).toBe("image")
    expect(model!.package).toBe("@opencode/ai/providers/alibaba/images")
  })
})
