import { expect, test } from "bun:test"
import { buildSlashCommandEntries, parseClientSlashCommand } from "./client-slash-command"

const options = [
  { id: "btw.ask", trigger: "btw", arguments: true, type: "builtin" as const },
  { id: "custom.btw", trigger: "custom", type: "custom" as const },
  { id: "model.choose", trigger: "model", type: "builtin" as const },
]

test.each([
  { text: "/btw why this approach?", result: { id: "btw.ask", input: "why this approach?" } },
  { text: "/btw\nwhy this approach?", result: { id: "btw.ask", input: "why this approach?" } },
  { text: "/btw", result: { id: "btw.ask", input: "" } },
  { text: "/btwx nope", result: undefined },
  { text: "/custom nope", result: undefined },
  { text: "/model opus", result: undefined },
  { text: "ask /btw later", result: undefined },
])("parses $text as a client argument command", (row) => {
  expect(parseClientSlashCommand(options, row.text)).toEqual(row.result)
})

test("assigns unique suggestionId values to slashAliases while preserving canonical command id", () => {
  const entries = buildSlashCommandEntries(
    [{ name: "deploy", description: "Custom deploy" }],
    [
      {
        id: "project.open",
        slash: "open",
        slashAliases: ["projects", "project"],
        title: "Open project",
      },
      {
        id: "session.plan.review",
        slash: "plan",
        title: "Review plan",
      },
      {
        id: "session.yolo",
        slash: "yolo",
        slashAliases: ["permissions", "auto-approve"],
        title: "Toggle permissions",
      },
      {
        id: "suggested.skip",
        slash: "skip",
        title: "Ignored suggested",
      },
      {
        id: "disabled.cmd",
        slash: "disabled",
        title: "Disabled",
        disabled: true,
      },
    ],
  )

  const suggestionIds = entries.map((entry) => entry.suggestionId)
  expect(new Set(suggestionIds).size).toBe(entries.length)
  expect(entries.map((entry) => ({ id: entry.id, suggestionId: entry.suggestionId, trigger: entry.trigger }))).toEqual([
    { id: "custom.deploy", suggestionId: "custom.deploy", trigger: "deploy" },
    { id: "project.open", suggestionId: "project.open", trigger: "open" },
    { id: "project.open", suggestionId: "project.open:projects", trigger: "projects" },
    { id: "project.open", suggestionId: "project.open:project", trigger: "project" },
    { id: "session.plan.review", suggestionId: "session.plan.review", trigger: "plan" },
    { id: "session.yolo", suggestionId: "session.yolo", trigger: "yolo" },
    { id: "session.yolo", suggestionId: "session.yolo:permissions", trigger: "permissions" },
    { id: "session.yolo", suggestionId: "session.yolo:auto-approve", trigger: "auto-approve" },
  ])
})
