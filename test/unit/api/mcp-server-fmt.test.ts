import { describe, expect, it } from "bun:test";
import { fmtSessionContext, type McpSessionContext } from "../../../src/api/mcp-server.ts";

function req(headers: Record<string, string> = {}): Request {
	return new Request("http://localhost/mcp", { headers });
}

const SID = "abcdef1234567890";

const identityCtx: McpSessionContext = {
	identity: {
		id: "usr_xyz",
		email: "x@example.com",
		displayName: "X",
		orgRole: "admin",
	},
};

describe("fmtSessionContext", () => {
	it("emits canonical ip=direct with no forwarded-for when X-Forwarded-For absent", () => {
		const out = fmtSessionContext(req(), SID, identityCtx);
		expect(out).toBe("sessionId=abcdef12 identity=usr_xyz ip=direct");
	});

	it("appends forwarded-for=<first-hop> when X-Forwarded-For is present, never as ip", () => {
		const out = fmtSessionContext(req({ "X-Forwarded-For": "1.2.3.4, 10.0.0.1" }), SID, identityCtx);
		expect(out).toBe(
			"sessionId=abcdef12 identity=usr_xyz ip=direct forwarded-for=1.2.3.4",
		);
	});

	it("renders sessionId=none and identity=none when both missing", () => {
		const out = fmtSessionContext(req(), null);
		expect(out).toBe("sessionId=none identity=none ip=direct");
	});

	it("never lets X-Forwarded-For override the ip= field", () => {
		const out = fmtSessionContext(req({ "X-Forwarded-For": "203.0.113.7" }), SID, identityCtx);
		expect(out).toContain("ip=direct");
		expect(out).not.toContain("ip=203.0.113.7");
	});
});
