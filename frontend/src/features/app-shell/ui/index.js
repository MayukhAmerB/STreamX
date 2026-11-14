// Shared Carbon building blocks for functional pages (phases 2-5).
export { default as EmptyState } from "./EmptyState";
export { default as FeatureBoundary } from "./FeatureBoundary";
export { default as PageHeader } from "./PageHeader";
export { default as PageNotification } from "./PageNotification";
export { default as PageSkeleton, useSkeletonGate } from "./PageSkeleton";
export { default as ProgressMeter } from "./ProgressMeter";
export { default as StatChips, StatChipsSkeleton } from "./StatChips";
export { Toast, ToastProvider, useToast } from "./toast";
export { useBreakpoint, useMediaQuery } from "../useBreakpoint";
// >>> UI overhaul components (stubs by WS-0, implemented by WS-A; plan Appendix A.5) >>>
export { default as BulkBar } from "./BulkBar";
export { default as ConfirmDialog } from "./ConfirmDialog";
export { default as DisabledReason } from "./DisabledReason";
export { default as DropZone } from "./DropZone";
export { default as ErrorState } from "./ErrorState";
export { default as NotFoundState } from "./NotFoundState";
export { default as ResponsiveTable } from "./ResponsiveTable";
export { default as RoutePlaceholder } from "./RoutePlaceholder";
export { default as ScrollTabs } from "./ScrollTabs";
export { default as SegmentedSwitch } from "./SegmentedSwitch";
export { default as SidePanel, useSidePanelParam } from "./SidePanel";
export { default as StatusTag, STATUS_VOCABULARY } from "./StatusTag";
export { default as StickyActionBar, useUnsavedChangesGuard } from "./StickyActionBar";
export { T1Home, T2List, T3Detail, T4Form, T5Studio } from "./templates";
// <<< UI overhaul <<<
export { default as Toolbar } from "./Toolbar";
