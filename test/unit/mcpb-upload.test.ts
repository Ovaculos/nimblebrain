/**
 * Tests asserting CORRECT behavior for .mcpb bundle upload fixes.
 * These FAIL against the current (buggy) code and PASS after fixes.
 *
 * Covers PR #170 review issues:
 * 1. Path traversal in handleBundleUpload filename
 * 3a. Uninstall by path: server name resolution (path-derived ≠ manifest)
 * 3b. Uninstall by path: workspace.json filter must handle {path} entries
 * 4. .mcpb branch must call resolveUserConfig (workspace credentials)
 * 5. Missing MPAK_WORKSPACE / UPJACK_ROOT in .mcpb env
 * 6. Server name collision on install (path-derived ≠ manifest-derived)
 *
 * Fix 2 (SDK dep blocker) is a PR comment, not a code change — no test.
 */

import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { deriveServerName } from "../../src/bundles/paths.ts";

// ---------------------------------------------------------------------------
// Fix 1: Path traversal — uploaded filename must strip directory components
//
// handleBundleUpload does: join(bundlesDir, sanitizeFilename(filename))
// sanitizeFilename only strips control chars / quotes, so "../../etc/foo.mcpb"
// passes through unchanged → written path escapes bundlesDir.
//
// Fix introduces an exported helper `safeBundleFilename` that the handler
// uses to derive on-disk filename. Helper applies path.basename so all
// directory components are stripped.
// ---------------------------------------------------------------------------

describe("Fix 1: path traversal in handleBundleUpload", () => {
	it("safeBundleFilename strips traversal components", async () => {
		const handlersModule = await import("../../src/api/handlers.ts");
		const safeBundleFilename = (
			handlersModule as unknown as { safeBundleFilename?: (s: string) => string }
		).safeBundleFilename;

		// CORRECT: helper must be exported by handlers.ts
		expect(typeof safeBundleFilename).toBe("function");
		// CORRECT: traversal components stripped to plain filename
		expect(safeBundleFilename!("../../etc/cron.daily/evil.mcpb")).toBe(
			"evil.mcpb",
		);
	});

	it("safeBundleFilename strips absolute path components", async () => {
		const handlersModule = await import("../../src/api/handlers.ts");
		const safeBundleFilename = (
			handlersModule as unknown as { safeBundleFilename?: (s: string) => string }
		).safeBundleFilename;

		expect(typeof safeBundleFilename).toBe("function");
		expect(safeBundleFilename!("/tmp/secrets/payload.mcpb")).toBe(
			"payload.mcpb",
		);
	});

	it("joined path with safeBundleFilename stays inside bundlesDir", async () => {
		const handlersModule = await import("../../src/api/handlers.ts");
		const safeBundleFilename = (
			handlersModule as unknown as { safeBundleFilename?: (s: string) => string }
		).safeBundleFilename;

		expect(typeof safeBundleFilename).toBe("function");
		const bundlesDir = "/home/.nimblebrain/workspaces/ws_dev/bundles";
		const result = join(bundlesDir, safeBundleFilename!("../../evil.mcpb"));
		expect(result.startsWith(bundlesDir)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Fix 3: Uninstall workspace.json filter must handle {path} entries
//
// uninstallBundleFromWorkspaceViaCtx filters workspace.json bundles with:
//   ws.bundles.filter((b) => !("name" in b && b.name === name))
// This only removes {name} entries. {path} entries are never matched because
// the target could be a path string, not a name string.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Fix 3a: uninstall by path — server name must come from manifest, not path
//
// uninstallBundleFromWorkspaceViaCtx calls deriveServerName(name) where `name`
// can be a `.mcpb` path string. For a path like "/uploads/echo.mcpb",
// deriveServerName("/uploads/echo.mcpb") = "echo-mcpb". But the source was
// registered under deriveServerName(manifest.name) = "echo".
// → registry lookup misses, uninstall reports "no bundle found".
// ---------------------------------------------------------------------------

describe("Fix 3a: uninstall by .mcpb path resolves to manifest-derived name", () => {
	it("path-as-name derived must equal manifest-derived name", () => {
		// Current uninstall: deriveServerName(name) where name = the path string
		const uninstallDerived = deriveServerName("/uploads/echo.mcpb");
		// Actual registered: deriveServerName(manifest.name) = "echo"
		const registeredAs = deriveServerName("echo");
		// CORRECT: uninstall must resolve to the manifest-derived registered name
		expect(uninstallDerived).toBe(registeredAs);
	});
});

describe("Fix 3b: uninstall workspace.json filter handles {path} entries", () => {
	/**
	 * Replicates the CURRENT (buggy) filter from uninstallBundleFromWorkspaceViaCtx.
	 * It only matches by name — path entries slip through.
	 */
	function currentFilter(
		bundles: Array<{ name?: string; path?: string }>,
		target: string,
	): Array<{ name?: string; path?: string }> {
		return bundles.filter((b) => !("name" in b && b.name === target));
	}

	it("removing a path-based bundle must actually remove the {path} entry", () => {
		const bundles = [
			{ name: "@acme/hello" },
			{ path: "/uploads/custom.mcpb" },
			{ name: "@acme/world" },
		];

		// Uninstalling the path-based bundle by its path
		const result = currentFilter(bundles, "/uploads/custom.mcpb");

		// CORRECT: should have 2 entries (path entry removed)
		expect(result).toHaveLength(2);
		expect(
			result.some((b) => "path" in b && b.path === "/uploads/custom.mcpb"),
		).toBe(false);
	});

	it("removing a named bundle still works", () => {
		const bundles = [
			{ name: "@acme/hello" },
			{ path: "/uploads/custom.mcpb" },
			{ name: "@acme/world" },
		];

		// Uninstalling a named bundle — this already works in current code
		const result = currentFilter(bundles, "@acme/hello");

		expect(result).toHaveLength(2);
		expect(
			result.some((b) => "name" in b && b.name === "@acme/hello"),
		).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Fix 5: .mcpb spawn env must include MPAK_WORKSPACE and UPJACK_ROOT
//
// The named-bundle branch in startBundleSource sets:
//   MPAK_WORKSPACE: bundleDataDir, UPJACK_ROOT: bundleDataDir
// The .mcpb branch omits these — bundles that depend on them break silently.
//
// Uses mock.module to intercept McpSource construction and capture spawn env.
// ---------------------------------------------------------------------------

let capturedSpawnEnv: Record<string, string> | undefined;
let capturedResolveUserConfigOpts:
	| { bundleName: string; userConfigSchema: unknown; wsId: string }
	| undefined;
let capturedPrepareServerOpts: { workspaceDir: string; userConfig?: unknown } | undefined;

// validateMcpb ships in mpak-sdk@>=0.7.0 (mpak#94). Until that version is
// published + dep-bumped, mock it here so the .mcpb branch is testable.
mock.module("@nimblebrain/mpak-sdk", () => ({
	validateMcpb: async (_path: string) => ({
		valid: true,
		manifest: testManifest,
		errors: [],
	}),
}));

mock.module("../../src/config/workspace-credentials.ts", () => ({
	resolveUserConfig: async (opts: {
		bundleName: string;
		userConfigSchema: unknown;
		wsId: string;
		workDir: string;
	}) => {
		capturedResolveUserConfigOpts = {
			bundleName: opts.bundleName,
			userConfigSchema: opts.userConfigSchema,
			wsId: opts.wsId,
		};
		return { api_key: "from-workspace-creds" };
	},
	friendlyMpakConfigError: (err: unknown) => err,
	getWorkspaceCredentials: async () => ({}),
	clearAllWorkspaceCredentials: async () => {},
}));

mock.module("../../src/tools/mcp-source.ts", () => ({
	McpSource: class MockMcpSource {
		name: string;
		constructor(name: string, config: { type: string; spawn?: { env?: Record<string, string> } }) {
			this.name = name;
			if (config?.type === "stdio" && config.spawn?.env) {
				capturedSpawnEnv = { ...config.spawn.env };
			}
		}
		async start() {}
		async stop() {}
		async tools() {
			return [];
		}
		async execute() {
			return { content: [], isError: true as const };
		}
	},
}));

mock.module("../../src/bundles/mpak.ts", () => ({
	getMpak: () => ({
		prepareServer: async (
			_ref: unknown,
			opts: { workspaceDir: string; userConfig?: unknown },
		) => {
			capturedPrepareServerOpts = opts;
			return {
				command: "node",
				args: ["index.js"],
				env: { MPAK_SDK_VAR: "from-sdk" },
				cwd: "/tmp/nb-test-mcpb-env",
				name: "echo",
			};
		},
		bundleCache: {
			getBundleManifest: () => null,
		},
	}),
}));

const tmpCwd = "/tmp/nb-test-mcpb-env";
const testManifest = {
	name: "echo",
	version: "1.0.0",
	description: "Test bundle",
	user_config: {
		api_key: { type: "string", title: "API Key", required: true },
	},
	server: {
		type: "node",
		mcp_config: {
			command: "node",
			args: ["index.js"],
			env: { ECHO_API_KEY: "${user_config.api_key}" },
		},
	},
};

async function runStartBundleSourceForMcpb() {
	const { startBundleSource } = await import("../../src/bundles/startup.ts");
	const { ToolRegistry } = await import("../../src/tools/registry.ts");
	const { NoopEventSink } = await import("../../src/adapters/noop-events.ts");

	const registry = new ToolRegistry();
	const sink = new NoopEventSink();
	const ref = { path: "/test/echo.mcpb" };

	await startBundleSource(ref, registry, sink, undefined, {
		wsId: "ws_test",
		workDir: "/tmp/nb-workdir",
		dataDir: "/tmp/nb-workdir/data/echo",
	});
}

describe("Fix 5: .mcpb spawn env includes MPAK_WORKSPACE and UPJACK_ROOT", () => {
	beforeEach(() => {
		capturedSpawnEnv = undefined;
		capturedResolveUserConfigOpts = undefined;
		capturedPrepareServerOpts = undefined;
		mkdirSync(tmpCwd, { recursive: true });
		writeFileSync(join(tmpCwd, "manifest.json"), JSON.stringify(testManifest));
	});

	afterEach(() => {
		rmSync(tmpCwd, { recursive: true, force: true });
	});

	it("spawn env must include MPAK_WORKSPACE and UPJACK_ROOT", async () => {
		await runStartBundleSourceForMcpb();

		expect(capturedSpawnEnv).toBeDefined();
		// CORRECT: both env vars must be set to the data dir
		expect(capturedSpawnEnv!.MPAK_WORKSPACE).toBe("/tmp/nb-workdir/data/echo");
		expect(capturedSpawnEnv!.UPJACK_ROOT).toBe("/tmp/nb-workdir/data/echo");
	});
});

// ---------------------------------------------------------------------------
// Fix 4: .mcpb branch must call resolveUserConfig and pass userConfig
//
// The named-bundle branch resolves workspace credentials via resolveUserConfig
// before calling prepareServer. The .mcpb branch skips this entirely → bundles
// declaring user_config never see workspace-stored credentials, and the SDK's
// missing-required check fires even when creds are configured.
// ---------------------------------------------------------------------------

describe("Fix 4: .mcpb branch resolves workspace credentials", () => {
	beforeEach(() => {
		capturedSpawnEnv = undefined;
		capturedResolveUserConfigOpts = undefined;
		capturedPrepareServerOpts = undefined;
		mkdirSync(tmpCwd, { recursive: true });
		writeFileSync(join(tmpCwd, "manifest.json"), JSON.stringify(testManifest));
	});

	afterEach(() => {
		rmSync(tmpCwd, { recursive: true, force: true });
	});

	it("resolveUserConfig must be called with manifest name and user_config schema", async () => {
		await runStartBundleSourceForMcpb();

		expect(capturedResolveUserConfigOpts).toBeDefined();
		// Must use manifest-derived bundle name, not the file path
		expect(capturedResolveUserConfigOpts!.bundleName).toBe("echo");
		expect(capturedResolveUserConfigOpts!.wsId).toBe("ws_test");
		// Must thread the manifest's user_config schema for credential resolution
		expect(capturedResolveUserConfigOpts!.userConfigSchema).toEqual(
			testManifest.user_config,
		);
	});

	it("resolved userConfig must be passed to prepareServer", async () => {
		await runStartBundleSourceForMcpb();

		expect(capturedPrepareServerOpts).toBeDefined();
		// CORRECT: resolved creds must reach the SDK's prepareServer
		expect(capturedPrepareServerOpts!.userConfig).toEqual({
			api_key: "from-workspace-creds",
		});
	});
});

// ---------------------------------------------------------------------------
// Fix 4 (continued): .mcpb branch must require opts.wsId
//
// The named-bundle branch hard-errors when wsId is missing (workspace-scoped
// credential resolution requires it). The .mcpb branch must do the same —
// silently defaulting would pool credentials across tenants.
// ---------------------------------------------------------------------------

describe("Fix 4 (continued): .mcpb branch requires opts.wsId", () => {
	beforeEach(() => {
		capturedSpawnEnv = undefined;
		mkdirSync(tmpCwd, { recursive: true });
		writeFileSync(join(tmpCwd, "manifest.json"), JSON.stringify(testManifest));
	});

	afterEach(() => {
		rmSync(tmpCwd, { recursive: true, force: true });
	});

	it("startBundleSource for .mcpb throws when wsId missing", async () => {
		const { startBundleSource } = await import("../../src/bundles/startup.ts");
		const { ToolRegistry } = await import("../../src/tools/registry.ts");
		const { NoopEventSink } = await import("../../src/adapters/noop-events.ts");

		const registry = new ToolRegistry();
		const sink = new NoopEventSink();
		const ref = { path: "/test/echo.mcpb" };

		// CORRECT: must throw because workspace-scoped credentials cannot resolve
		// without wsId. Currently passes silently — credentials never resolve.
		await expect(
			startBundleSource(ref, registry, sink, undefined, {
				workDir: "/tmp/nb-workdir",
			}),
		).rejects.toThrow(/workspace/i);
	});
});

// ---------------------------------------------------------------------------
// Fix 5 (continued): protected .mcpb spawn env includes internalEnv
//
// Named/local branches inject NB_INTERNAL_TOKEN + NB_HOST_URL into spawn env
// when ref.protected is true and opts.internalEnv is provided. The .mcpb
// branch never threads internalEnv → protected bundles cannot reach the host.
// ---------------------------------------------------------------------------

describe("Fix 5 (continued): protected .mcpb gets internalEnv", () => {
	beforeEach(() => {
		capturedSpawnEnv = undefined;
		mkdirSync(tmpCwd, { recursive: true });
		writeFileSync(join(tmpCwd, "manifest.json"), JSON.stringify(testManifest));
	});

	afterEach(() => {
		rmSync(tmpCwd, { recursive: true, force: true });
	});

	it("spawn env must include NB_INTERNAL_TOKEN and NB_HOST_URL when ref.protected", async () => {
		const { startBundleSource } = await import("../../src/bundles/startup.ts");
		const { ToolRegistry } = await import("../../src/tools/registry.ts");
		const { NoopEventSink } = await import("../../src/adapters/noop-events.ts");

		const registry = new ToolRegistry();
		const sink = new NoopEventSink();
		const ref = { path: "/test/echo.mcpb", protected: true };

		await startBundleSource(ref, registry, sink, undefined, {
			wsId: "ws_test",
			workDir: "/tmp/nb-workdir",
			dataDir: "/tmp/nb-workdir/data/echo",
			internalEnv: {
				NB_INTERNAL_TOKEN: "secret-token",
				NB_HOST_URL: "http://localhost:27247",
			},
		});

		expect(capturedSpawnEnv).toBeDefined();
		// CORRECT: protected .mcpb must receive host-comm credentials
		expect(capturedSpawnEnv!.NB_INTERNAL_TOKEN).toBe("secret-token");
		expect(capturedSpawnEnv!.NB_HOST_URL).toBe("http://localhost:27247");
	});
});

// ---------------------------------------------------------------------------
// Fix 6: Server name collision — path-derived ≠ manifest-derived
//
// workspace-ops.ts serverNameFromRef uses deriveServerName(ref.path) for path
// refs. But startBundleSource registers .mcpb bundles under
// deriveServerName(manifest.name). These differ because the path includes
// the ".mcpb" extension: deriveServerName("echo.mcpb") → "echo-mcpb",
// but deriveServerName("echo") → "echo".
//
// installBundleInWorkspace pre-computes the server name from the path for its
// duplicate check, but the actual registered name comes from the manifest.
// The duplicate check uses the wrong name → silent collision.
// ---------------------------------------------------------------------------

describe("Fix 6: .mcpb server name must come from manifest, not file path", () => {
	it("path-derived name must equal manifest-derived name for .mcpb", () => {
		// serverNameFromRef({path: "/uploads/echo.mcpb"}) calls
		// deriveServerName("/uploads/echo.mcpb")
		const pathDerived = deriveServerName("/uploads/echo.mcpb");

		// startBundleSource registers under deriveServerName(manifest.name)
		// where manifest.name = "echo"
		const manifestDerived = deriveServerName("echo");

		// CORRECT: these must be equal so the duplicate check works
		// Currently: pathDerived = "echo-mcpb", manifestDerived = "echo"
		expect(pathDerived).toBe(manifestDerived);
	});

	it("scoped name path-derived must equal manifest-derived", () => {
		const pathDerived = deriveServerName("/uploads/@acme/my-tool.mcpb");
		const manifestDerived = deriveServerName("my-tool");

		// Both should resolve to "my-tool"
		expect(pathDerived).toBe(manifestDerived);
	});
});

// ---------------------------------------------------------------------------
// Fix 6 (continued): installBundleInWorkspace returns dataDir from manifest
//
// installBundleInWorkspace currently computes dataDir from
// `bundleNameFromRef(ref) = ref.path` for path refs. For .mcpb,
// `deriveBundleDataDir("/uploads/echo.mcpb")` produces a non-portable
// path-derived dir. After fix, dataDir comes from manifest name.
// ---------------------------------------------------------------------------

describe("Fix 6 (continued): install returns manifest-derived dataDir", () => {
	beforeEach(() => {
		capturedSpawnEnv = undefined;
		mkdirSync(tmpCwd, { recursive: true });
		writeFileSync(join(tmpCwd, "manifest.json"), JSON.stringify(testManifest));
	});

	afterEach(() => {
		rmSync(tmpCwd, { recursive: true, force: true });
	});

	it("install with .mcpb path returns dataDir derived from manifest, not path", async () => {
		const { installBundleInWorkspace } = await import(
			"../../src/bundles/workspace-ops.ts"
		);
		const { ToolRegistry } = await import("../../src/tools/registry.ts");
		const { NoopEventSink } = await import("../../src/adapters/noop-events.ts");

		const registry = new ToolRegistry();
		const sink = new NoopEventSink();

		const result = await installBundleInWorkspace(
			"ws_test",
			{ path: "/uploads/echo.mcpb" },
			registry,
			sink,
			undefined,
			{ workDir: "/tmp/nb-workdir" },
		);

		// CORRECT: serverName from manifest
		expect(result.serverName).toBe("echo");
		// CORRECT: dataDir from manifest name, portable across re-uploads
		expect(result.dataDir).toBe(
			join("/tmp/nb-workdir/workspaces/ws_test/data", "echo"),
		);
		// Negative: must NOT contain path components
		expect(result.dataDir).not.toContain("uploads");
		expect(result.dataDir).not.toContain("mcpb");
	});
});
