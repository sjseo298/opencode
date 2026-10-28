# TUI Experiments

- Temporary, opt-in UI experiments belong in the `experiments` registry in `src/component/dialog-experiments.tsx`, with behavior gated by the matching `config.experimental` key.
- The Experiments framework is permanent infrastructure. Keep the registry, dialog, settings persistence, toggle handling, and UI entry point even when there are no active experiments.
- Graduating an experiment means removing only its registry entry and feature-specific gate, making that feature's behavior unconditional. Abandoning an experiment means removing its entry, gate, and experimental behavior.
- Do not remove or simplify away the reusable Experiments infrastructure because the registry is empty. An empty registry is intentional and ready for future experiments, not dead code.

## Sidebar Objectives Architecture

- The `SidebarObjectives` component (`packages/tui/src/feature-plugins/sidebar/objectives.tsx`) renders the objective tree directly from OpenCode's canonical `session.metadata.objectives`:
  1. Updated atomically on every `objective_manage` invocation in `hierarchical-objectives.ts`.
  2. Persisted formally in OpenCode's SQLite database (`session` table) and dispatched via `session.metadata.updated`.
  3. Reactively listened via Solid's `context.data.session.get(sessionID)`, ensuring immediate zero-latency updates across process boundaries.
  4. Live active-objective status feedback displayed in the collapsed header (`view.open = false`) to ensure users never perceive an empty or lost tree when collapsed.
