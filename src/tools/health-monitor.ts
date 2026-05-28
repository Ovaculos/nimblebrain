import type { EventSink } from "../engine/types.ts";
import type { McpSource } from "./mcp-source.ts";

export type HealthRecordState = "healthy" | "restarting" | "dead";

export interface BundleHealth {
  name: string;
  state: HealthRecordState;
  uptime: number | null;
  restartCount: number;
}

interface BundleRecord {
  source: McpSource;
  state: HealthRecordState;
  restartCount: number;
}

const MAX_RESTARTS = 5;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_CHECK_INTERVAL_MS = 30_000;

/**
 * Reported HealthMonitor transition for the BundleInstance underlying a
 * source. `crashed` and `dead` map to `lifecycle.recordCrash` /
 * `recordDead`; `running` maps to `recordRecovery`. The single shape
 * pushes the per-method switch + source→instance lookup into the
 * caller (`startServer`) so HealthMonitor stays unaware of lifecycle
 * internals — useful when the caller wants to inject a different
 * backing system (tests, alternative observability paths).
 */
export type HealthMonitorTransition = "crashed" | "running" | "dead";

export interface HealthMonitorOptions {
  checkIntervalMs?: number;
  baseDelayMs?: number;
  /**
   * Propagate a detected health transition back to `BundleInstance.state`
   * via the bundle lifecycle. Without this hook the URL bundle path
   * (which funnels through `recordConnectionStateChange`) still works,
   * but stdio subprocess crashes leave the user-facing state stuck at
   * `running`. Hook is no-op safe; the caller is responsible for the
   * source → instance resolution (returning early if the source doesn't
   * back any BundleInstance, e.g. shared or in-process platform sources).
   * See issue #194 for the operator log story this enables.
   */
  reportSourceTransition?: (source: McpSource, to: HealthMonitorTransition) => void;
}

/**
 * Monitors MCP subprocess health and auto-restarts dead bundles
 * with exponential backoff.
 */
export class HealthMonitor {
  private records: BundleRecord[];
  private timer: ReturnType<typeof setInterval> | null = null;
  private checkIntervalMs: number;
  private baseDelayMs: number;
  private reportSourceTransition: HealthMonitorOptions["reportSourceTransition"];

  constructor(
    sources: McpSource[],
    private eventSink: EventSink,
    opts: HealthMonitorOptions = {},
  ) {
    this.checkIntervalMs = opts.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    this.baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.reportSourceTransition = opts.reportSourceTransition;
    this.records = sources.map((source) => ({
      source,
      state: "healthy" as HealthRecordState,
      restartCount: 0,
    }));
  }

  /** Start the periodic health check loop. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.check(), this.checkIntervalMs);
  }

  /** Stop the periodic health check loop. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Run a single health check across all bundles. */
  async check(): Promise<void> {
    const tasks = this.records.map((record) => this.checkOne(record));
    await Promise.all(tasks);
  }

  /** Get per-bundle health info. */
  getStatus(): BundleHealth[] {
    return this.records.map((r) => ({
      name: r.source.name,
      state: r.state,
      uptime: r.source.uptime(),
      restartCount: r.restartCount,
    }));
  }

  private async checkOne(record: BundleRecord): Promise<void> {
    // Dead is terminal — no more restart attempts
    if (record.state === "dead") return;

    // Skip if source is alive
    if (record.source.isAlive()) return;

    const remote = isRemoteSource(record.source);

    // Source is down — emit crashed event
    this.eventSink.emit({
      type: "run.error",
      data: {
        source: record.source.name,
        event: "bundle.crashed",
        ...(remote ? { remote: true } : {}),
      },
    });

    // Propagate to BundleInstance.state on first detection only. The
    // `record.state === "healthy"` guard distinguishes the first failure
    // from subsequent sweeps that find us in "restarting" — we don't want
    // to report crashed on every poll cycle while a restart is pending.
    if (record.state === "healthy") {
      this.reportSourceTransition?.(record.source, "crashed");
    }

    // Check if we've exhausted restart attempts
    if (record.restartCount >= MAX_RESTARTS) {
      record.state = "dead";
      this.eventSink.emit({
        type: "run.error",
        data: {
          source: record.source.name,
          event: "bundle.dead",
          ...(remote ? { remote: true } : {}),
        },
      });
      this.reportSourceTransition?.(record.source, "dead");
      return;
    }

    // Attempt restart with exponential backoff
    record.state = "restarting";
    const delay = this.baseDelayMs * 2 ** record.restartCount;
    record.restartCount++;

    this.eventSink.emit({
      type: "run.error",
      data: {
        source: record.source.name,
        event: "bundle.restarting",
        attempt: record.restartCount,
        delayMs: delay,
        ...(remote ? { remote: true } : {}),
      },
    });

    await sleep(delay);

    let ok: boolean;
    if (remote) {
      // Remote sources: reconnect via transport stop+start cycle
      ok = await this.reconnectRemote(record.source);
    } else {
      // Stdio sources: restart subprocess
      ok = await record.source.restart();
    }

    if (ok) {
      record.state = "healthy";
      this.eventSink.emit({
        type: "run.error",
        data: {
          source: record.source.name,
          event: "bundle.recovered",
          ...(remote ? { remote: true } : {}),
        },
      });
      this.reportSourceTransition?.(record.source, "running");
    } else {
      // Restart failed — check again on next cycle (might hit max)
      record.state = "restarting";
    }
  }

  /** Reconnect a remote source via transport-level stop+start. */
  private async reconnectRemote(source: McpSource): Promise<boolean> {
    try {
      await source.stop();
      await source.start();
      return true;
    } catch (err) {
      console.error("[health-monitor] reconnect failed:", err);
      return false;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Duck-type check for remote sources. If McpSource has isRemote(), use it.
 * Otherwise fall back to checking for a remoteConfig property.
 */
function isRemoteSource(source: McpSource): boolean {
  const s = source as unknown as { isRemote?: () => boolean };
  if (typeof s.isRemote === "function") {
    return s.isRemote();
  }
  return false;
}
