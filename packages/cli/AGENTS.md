# CLI and TUI development guide

- Use `@opencode/client` and the location-scoped data in `packages/tui/src/context/data.tsx`.
- Preserve established TUI behavior unless the task intentionally changes it.
- Follow the `Cross-Surface Coherence (TUI ↔ Web/Desktop)` section in the root `AGENTS.md`: any user-facing command or server setting shared with Web/Desktop must stay aligned with `packages/schema/src/surface-parity.ts` and pass `bun script/check-surface-parity.ts`.
