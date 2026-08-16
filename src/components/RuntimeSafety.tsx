import {
  Component,
  useEffect,
  useSyncExternalStore,
  type ErrorInfo,
  type ReactNode,
} from "react";
import {
  dismissRuntimeIssue,
  getRuntimeIssuesSnapshot,
  reportRuntimeIssue,
  subscribeRuntimeIssues,
} from "../utils/runtimeHealth";
import { CloseIcon, ReloadIcon } from "./icons";

export class AppErrorBoundary extends Component<
  { children: ReactNode },
  { error?: Error }
> {
  state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportRuntimeIssue(
      new Error(`${error.message}${info.componentStack ?? ""}`),
      "Rendering was stopped by the safety circuit",
    );
  }

  render() {
    if (this.state.error) {
      return (
        <main className="runtime-fallback" role="alert">
          <h1>Something went wrong</h1>
          <p>
            Rendering was stopped before it could lock up the page. Your saved
            browser data has not been deleted.
          </p>
          <pre>{this.state.error.message}</pre>
          <button className="primary-btn" type="button" onClick={() => location.reload()}>
            Reload app
          </button>
        </main>
      );
    }
    return this.props.children;
  }
}

export function RuntimeIssueBanner() {
  const issues = useSyncExternalStore(
    subscribeRuntimeIssues,
    getRuntimeIssuesSnapshot,
    getRuntimeIssuesSnapshot,
  );

  useEffect(() => {
    const onError = (event: ErrorEvent) =>
      reportRuntimeIssue(event.error ?? event.message, "Unexpected browser error");
    const onRejection = (event: PromiseRejectionEvent) =>
      reportRuntimeIssue(event.reason, "Unexpected asynchronous error");
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  const issue = issues[0];
  if (!issue) return null;

  return (
    <aside className="runtime-banner" role="alert">
      <div>
        <strong>{issue.context}</strong>
        <span>{issue.message}</span>
        {issue.count > 1 && <small>Repeated {issue.count} times</small>}
      </div>
      <button
        type="button"
        className="icon-btn"
        aria-label="Reload"
        title="Reload the page"
        onClick={() => location.reload()}
      >
        <ReloadIcon />
      </button>
      <button
        type="button"
        // Quiet, now that reload beside it is also a filled icon button:
        // two identical circles would give no clue which one acts.
        className="icon-btn icon-btn-quiet"
        aria-label="Dismiss error"
        title="Dismiss error"
        onClick={() => dismissRuntimeIssue(issue.id)}
      >
        <CloseIcon />
      </button>
    </aside>
  );
}

/** Inline boundary used when one malformed graph branch is cut off. */
export function RuntimeCircuitNotice({ message }: { message: string }) {
  useEffect(() => {
    reportRuntimeIssue(message, "Malformed block graph was stopped", "warning");
  }, [message]);
  return <p className="runtime-circuit">{message}</p>;
}
