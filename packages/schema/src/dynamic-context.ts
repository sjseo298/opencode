export * as DynamicContext from "./dynamic-context.js"

import { Schema } from "effect"
import { Rpc } from "./rpc.js"
import { optional } from "./schema.js"

export const DynamicContextEntrySchema = Schema.Struct({
  limit: optional(Schema.Number),
  used: optional(Schema.Number),
  totalSlots: optional(Schema.Number),
  maxSubagents: optional(Schema.Number),
}).annotate({ identifier: "DynamicContext.Entry" })

export type DynamicContextEntry = typeof DynamicContextEntrySchema.Type

export const DynamicContextSnapshotSchema = Schema.Struct({
  entries: Schema.Record(Schema.String, DynamicContextEntrySchema),
}).annotate({ identifier: "DynamicContext.Snapshot" })

export type DynamicContextSnapshot = typeof DynamicContextSnapshotSchema.Type

export const DynamicContextRpc = Rpc.define({
  id: "llamacpp.context",
  methods: {
    getSnapshot: {
      input: Schema.toStandardSchemaV1(Schema.Struct({})),
      output: Schema.toStandardSchemaV1(DynamicContextSnapshotSchema),
    },
    setLimit: {
      input: Schema.toStandardSchemaV1(
        Schema.Struct({
          modelKey: Schema.String,
          limit: Schema.Number,
        }),
      ),
      output: Schema.toStandardSchemaV1(
        Schema.Struct({
          modelKey: Schema.String,
          limit: Schema.Number,
        }),
      ),
    },
    refresh: {
      input: Schema.toStandardSchemaV1(
        Schema.Struct({
          providerID: optional(Schema.String),
          modelID: optional(Schema.String),
        }),
      ),
      output: Schema.toStandardSchemaV1(
        Schema.Struct({
          updated: Schema.Boolean,
          nCtx: optional(Schema.Number),
          previous: optional(Schema.Number),
          totalSlots: optional(Schema.Number),
          maxSubagents: optional(Schema.Number),
          error: optional(Schema.Boolean),
        }),
      ),
    },
  },
  events: {},
})
