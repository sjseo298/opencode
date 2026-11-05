# TUI Experiments

- Temporary, opt-in UI experiments belong in the `experiments` registry in `src/component/dialog-experiments.tsx`, with behavior gated by the matching `config.experimental` key.
- The Experiments framework is permanent infrastructure. Keep the registry, dialog, settings persistence, toggle handling, and UI entry point even when there are no active experiments.
- Graduating an experiment means removing only its registry entry and feature-specific gate, making that feature's behavior unconditional. Abandoning an experiment means removing its entry, gate, and experimental behavior.
- Do not remove or simplify away the reusable Experiments infrastructure because the registry is empty. An empty registry is intentional and ready for future experiments, not dead code.

## Sidebar Objectives Architecture

- The `SidebarObjectives` component (`packages/tui/src/feature-plugins/sidebar/objectives.tsx`) renders the objective tree directly from OpenCode's canonical `session.metadata.objectives`:
  1. Updated atomically on every `objective_manage` invocation in `hierarchical-objectives.ts`.
  2. Persisted formally in OpenCode's SQLite database (`session` table) and dispatched across the event bus via `session.metadata.updated`.
  3. Received by `@opencode/client` Solid data layer (`packages/client/src/solid/data.ts`), which reconciles `store.session.info[sessionID].metadata` upon receiving `session.metadata.updated`.
  4. Reactively listened in `SidebarObjectives` via Solid's `context.data.session.get(sessionID)`, ensuring immediate zero-latency updates across process boundaries.
  5. Live active-objective status feedback displayed in the collapsed header (`view.open = false`) to ensure users never perceive an empty or lost tree when collapsed.

## Reactive Plan Approval Architecture (`DialogPlanApproval`)

- When an objective tree transitions to `presented_awaiting_confirmation`:
  1. An event-driven one-shot trigger in `packages/tui/src/routes/session/index.tsx` detects the state transition on `session().metadata.objectives.status`.
  2. The application automatically renders `DialogPlanApproval` (`packages/tui/src/routes/session/dialog-plan-approval.tsx`) as a native modal popup without requiring agent text intervention.
  3. When the user selects "Sesión Fresca", a completely standalone top-level session (`parentID: undefined`) is created, the objective tree is imported, and `route.navigate` switches the active session immediately to the fresh session with 100% token headroom.
