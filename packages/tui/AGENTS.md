# TUI Experiments

- Temporary, opt-in UI experiments belong in the `experiments` registry in `src/component/dialog-experiments.tsx`, with behavior gated by the matching `config.experimental` key.
- The Experiments framework is permanent infrastructure. Keep the registry, dialog, settings persistence, toggle handling, and UI entry point even when there are no active experiments.
- Graduating an experiment means removing only its registry entry and feature-specific gate, making that feature's behavior unconditional. Abandoning an experiment means removing its entry, gate, and experimental behavior.
- Do not remove or simplify away the reusable Experiments infrastructure because the registry is empty. An empty registry is intentional and ready for future experiments, not dead code.

## Sidebar Objectives Resilience

- The `SidebarObjectives` component (`packages/tui/src/feature-plugins/sidebar/objectives.tsx`) uses a multi-layered fallback strategy to render the objective tree in large or long-running sessions:
  1. `globalThis.__OPENCODE_OBJECTIVES__` in-memory map for single-process development and tests.
  2. Shared disk snapshots via `getSharedObjectivesPath(sessionID)` (`~/.local/share/opencode/objectives/${sessionID}.json`) to bridge process boundaries between server daemon and TUI.
  3. Dynamic auto-recovery for paginated sessions where `set_primary` has scrolled out of the client message buffer: `update_secondary`, `update_tertiary`, and `update_dod` auto-synthesize the root PO and missing subtasks.
  4. Chronological compaction parsing supporting multiple markdown and checkbox checkpoint formats, maintaining continuity across context compaction events.
  5. Live active-objective status feedback displayed in the collapsed header (`view.open = false`) to ensure users never perceive an empty or lost tree when collapsed.
