import { describe, expect, it } from "bun:test";
import { resolveClientIp } from "../../../src/api/client-ip.ts";

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/", { headers });
}

describe("resolveClientIp", () => {
  it("returns ip='direct' even when X-Forwarded-For is set (spoofable, never trusted)", () => {
    const result = resolveClientIp(req({ "X-Forwarded-For": "1.2.3.4" }));
    expect(result.ip).toBe("direct");
  });

  it("captures the first hop of X-Forwarded-For as forwardedFor (forensic claim)", () => {
    const result = resolveClientIp(req({ "X-Forwarded-For": "1.2.3.4, 10.0.0.1" }));
    expect(result.forwardedFor).toBe("1.2.3.4");
  });

  it("returns forwardedFor=null when X-Forwarded-For is absent", () => {
    const result = resolveClientIp(req());
    expect(result.ip).toBe("direct");
    expect(result.forwardedFor).toBeNull();
  });

  it("trims whitespace around the first hop", () => {
    const result = resolveClientIp(req({ "X-Forwarded-For": "  9.9.9.9 , 10.0.0.1" }));
    expect(result.forwardedFor).toBe("9.9.9.9");
  });

  it("returns forwardedFor=null when X-Forwarded-For is empty string", () => {
    const result = resolveClientIp(req({ "X-Forwarded-For": "" }));
    expect(result.forwardedFor).toBeNull();
  });

  it("matches rate-limit's canonical IP value", () => {
    // The rate-limit middleware uses the literal "direct" as its key.
    // Audit logs and session diagnostics must agree on the same canonical
    // value so an operator grepping `ip=direct` sees the full picture.
    const result = resolveClientIp(req({ "X-Forwarded-For": "203.0.113.7" }));
    expect(result.ip).toBe("direct");
  });
});
