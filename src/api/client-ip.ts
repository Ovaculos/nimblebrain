/**
 * Resolve a request's client IP for logging and rate-limiting purposes.
 *
 * `X-Forwarded-For` is client-supplied and spoofable end-to-end: NB has no
 * shared secret with any upstream proxy, so the header value carries no
 * authority. The rate limiter ([rate-limit.ts](./middleware/rate-limit.ts))
 * refuses to trust it; audit logs and session diagnostics use the same
 * canonical value (`"direct"`) for consistency, while preserving the raw
 * first-hop claim under `forwardedFor` for forensic correlation.
 *
 * Callers that want the spoofable header should use `forwardedFor`. Callers
 * that want a stable, untrusted-but-canonical key should use `ip`.
 */
export interface ClientIp {
  /**
   * Canonical IP for logs and rate-limit keys. Always `"direct"` today —
   * NB does not consume any upstream proxy IP header. Matches
   * `rate-limit.ts`'s rate-limit key.
   */
  ip: "direct";
  /**
   * First hop of the `X-Forwarded-For` header, trimmed. `null` if the
   * header is absent or empty. Forensic only — never use as an
   * authoritative client identifier or rate-limit key.
   */
  forwardedFor: string | null;
}

export function resolveClientIp(req: Request): ClientIp {
  const raw = req.headers.get("x-forwarded-for");
  const firstHop = raw?.split(",")[0]?.trim();
  return {
    ip: "direct",
    forwardedFor: firstHop && firstHop.length > 0 ? firstHop : null,
  };
}
