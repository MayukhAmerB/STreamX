// Capabilities: what the signed-in viewer may use (UI overhaul plan §5.4,
// Appendix A.1 / A.5). OWNER: WS-F.
export { default as applyCapabilities, CAPABILITY_STATES, CHECKING_REASON, resolveCapability } from "./applyCapabilities";
export {
  CAPABILITIES_POLL_MS,
  CAPABILITIES_STALE_EVENT,
  FEATURE_DISABLED_CODE,
  featureDisabledDetail,
  fetchCapabilities,
} from "./api";
export { FEATURE_WORKSPACES, FEATURES_MANAGE_URL, TEACH_ITEM_KEYS, WORKSPACES } from "./constants";
export { default as FeatureGate, FeatureOffState, resolveFeatureGate } from "./FeatureGate";
export { CAPABILITY_REVEAL_EVENT, noteCapabilities, resetCapabilityReveal, useCapabilityReveal } from "./reveal";
export { default as useCapabilities, resetCapabilitiesCache } from "./useCapabilities";
export { default as usePurchaseGate, PURCHASE_STATES, resolvePurchaseGate } from "./usePurchaseGate";
