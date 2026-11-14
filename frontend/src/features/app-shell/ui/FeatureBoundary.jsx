import { Component } from "react";
import PageNotification from "./PageNotification";

function sameKeys(previous = [], next = []) {
  return previous.length === next.length && previous.every((value, index) => Object.is(value, next[index]));
}

/**
 * Error boundary for one feature panel (or one Console page). A render or
 * effect error inside it (for example a Carbon component that throws on
 * misuse) replaces only this panel with a short message and a "Try again"
 * button; the shell, navigation and the rest of the page keep working
 * instead of React unmounting the whole app to a blank screen.
 *
 *   <FeatureBoundary label="Your weekly report" resetKeys={[courseId]}>
 *     <WeeklyReportCard ... />
 *   </FeatureBoundary>
 *
 * `resetKeys`: when any value changes (e.g. the route), a crashed panel is
 * rendered again. `fallback` overrides the message (a node, or a function of
 * `{ error, reset }`).
 */
export default class FeatureBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
    this.reset = this.reset.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error: error || new Error("Unknown rendering error") };
  }

  componentDidCatch(error, info) {
    if (typeof console !== "undefined" && console.error) {
      console.error(`[FeatureBoundary] "${this.props.label || "section"}" crashed:`, error, info?.componentStack || "");
    }
    this.props.onError?.(error, info);
  }

  componentDidUpdate(previous) {
    if (this.state.error && !sameKeys(previous.resetKeys, this.props.resetKeys)) this.reset();
  }

  reset() {
    this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children ?? null;

    const { fallback, label } = this.props;
    if (typeof fallback === "function") return fallback({ error, reset: this.reset });
    if (fallback !== undefined) return fallback;

    return (
      <div className="cds-feature-boundary" data-feature-boundary={label || "section"}>
        <PageNotification
          kind="error"
          title={`${label || "This section"} couldn't be shown.`}
          subtitle="Something went wrong here; the rest of the page still works. Try again, or reload the page."
          actionLabel="Try again"
          onAction={this.reset}
        />
      </div>
    );
  }
}
