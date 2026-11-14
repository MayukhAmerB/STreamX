// Old URL /report-grading/queue → Grading › Queue (/console/{ws}/grading/queue,
// UI overhaul plan §3.3). OWNER: WS-D2. The page lives in features/grading;
// this module only forwards old links (query kept) and re-exports the queue
// building blocks for existing imports and tests.
import WorkspaceRedirect from "../features/app-shell/WorkspaceRedirect";

export {
  DuplicateSignals,
  GradingSplitView,
  groupQueue,
  QUEUE_STATUS_OPTIONS,
  queueFilters,
  QueueList,
  SignalBadges,
} from "../features/grading/GradingQueue";

export default function ReportsQueuePage() {
  return <WorkspaceRedirect />;
}
