import type { SessionCreateInput, SessionInfo } from "@opencode/client/promise"
import { cloneObjectivesForFreshSession as cloneRawObjectives, normalizeSessionObjectives } from "@opencode/schema/objectives"

type SessionMetadataValue = NonNullable<SessionCreateInput["metadata"]>[string]

export {
  activeSecondaryObjective,
  formatTreeSummary,
  isObjectiveClosed,
  normalizeSessionObjectives,
  type ContextMetricsView,
  type DelegationView,
  type DoDCriterionView,
  type FindingLifecycle,
  type FindingView,
  type FingerprintView,
  type ObjectiveStatus,
  type OptionStatusView,
  type OptionView,
  type PrimaryObjectiveStatus,
  type PrimaryObjectiveView,
  type SecondaryObjectiveView,
  type TertiaryObjectiveView,
} from "@opencode/schema/objectives"

export function normalizePrimaryObjectiveView(metadata: SessionInfo["metadata"]) {
  return normalizeSessionObjectives(metadata)
}

export function cloneObjectivesForFreshSession(
  metadata: SessionInfo["metadata"],
  originSessionID: string,
): SessionMetadataValue {
  // SAFETY: cloned value from @opencode/schema/objectives is JSON-serializable SessionMetadata.
  return cloneRawObjectives(metadata, originSessionID) as SessionMetadataValue
}
