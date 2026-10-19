// Story 9.2: how a refused app call is described, shared by the dry-run driver's attempt() (Story 9.1)
// and the persona tool layer. The error's own class name and message are the finding; an "unavailable"
// error's cause (the database's own refusal) and any error code are kept alongside them.

export type ErrorDescription = { error: string; message: string; code?: string; cause?: string };

function describeCause(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  if (typeof cause === "object" && cause) {
    const { code, message } = cause as { code?: unknown; message?: unknown };
    return [code, message].filter(v => typeof v === "string" && v !== "").join(" ") || "unknown";
  }
  return String(cause);
}

/** The class name, message, code (when the error has one) and cause (when it has one) of a thrown value. */
export function describeError(error: unknown): ErrorDescription {
  const message = error instanceof Error ? error.message : String(error);
  const code = typeof error === "object" && error && "code" in error ? String((error as { code: unknown }).code) : undefined;
  const cause = error instanceof Error && error.cause !== undefined ? describeCause(error.cause) : undefined;
  return { error: error instanceof Error ? error.name : "Error", message, ...(code ? { code } : {}), ...(cause ? { cause } : {}) };
}
