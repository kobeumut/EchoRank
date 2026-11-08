export type ProviderErrorCode = "not_configured" | "unauthorized" | "rate_limited" | "timeout" | "provider_error" | "invalid_response";

/** Sanitized on purpose: only the code ever leaves the server, never provider or CLI output. */
export class ProviderError extends Error {
  constructor(public code: ProviderErrorCode) { super(code); }
}
