export type RuntimeIssueSeverity = "warning" | "error";

export type RuntimeIssue = {
  id: string;
  context: string;
  message: string;
  severity: RuntimeIssueSeverity;
  timestamp: number;
  count: number;
};

let issues: RuntimeIssue[] = [];
const listeners = new Set<() => void>();

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown runtime error";
  }
}

function emit() {
  for (const listener of listeners) listener();
}

/** Report a recoverable failure to the visible runtime-health banner. */
export function reportRuntimeIssue(
  error: unknown,
  context: string,
  severity: RuntimeIssueSeverity = "error",
) {
  const message = errorMessage(error);
  const key = `${severity}|${context}|${message}`;
  const existing = issues.find((issue) => issue.id === key);
  const issue: RuntimeIssue = existing
    ? { ...existing, count: existing.count + 1, timestamp: Date.now() }
    : { id: key, context, message, severity, timestamp: Date.now(), count: 1 };

  issues = [issue, ...issues.filter((candidate) => candidate.id !== key)].slice(0, 5);
  console.error(`[${context}] ${message}`, error);
  emit();
}

export function dismissRuntimeIssue(id: string) {
  issues = issues.filter((issue) => issue.id !== id);
  emit();
}

export function subscribeRuntimeIssues(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getRuntimeIssuesSnapshot() {
  return issues;
}

export const RUNTIME_LIMITS = {
  blockDepth: 32,
  graphNodes: 10_000,
  patchBatch: 5_000,
  storedBytes: 4_000_000,
} as const;
