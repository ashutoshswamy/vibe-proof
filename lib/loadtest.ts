import { pingOnce, validTarget } from "./scanner";

/**
 * A small, capped synthetic load check: enough concurrent requests to see latency
 * under load, never enough to be a denial-of-service tool. Hard ceilings below are
 * intentional and not configurable by the caller beyond the exposed, tighter bounds.
 */
export type LoadResult = {
  url: string;
  concurrency: number;
  duration: number;
  requests: number;
  succeeded: number;
  failed: number;
  errors: { message: string; count: number }[];
  statusCounts: Record<string, number>;
  latencyMs: { min: number; p50: number; p95: number; max: number; avg: number };
  requestsPerSecond: number;
  stoppedEarly: boolean;
};

const MAX_CONCURRENCY = 8;
const MAX_DURATION_MS = 8_000;
const MAX_REQUESTS = 100;
const MAX_RESPONSE_BYTES = 50_000;

function percentile(sorted: number[], p: number) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

export async function runLoadTest(value: string, options: { concurrency?: number; durationMs?: number } = {}) {
  const concurrency = Math.max(1, Math.min(MAX_CONCURRENCY, Math.round(options.concurrency ?? 5)));
  const duration = Math.max(1000, Math.min(MAX_DURATION_MS, Math.round(options.durationMs ?? 4000)));
  const { target, address } = await validTarget(value);

  const latencies: number[] = [];
  const statusCounts: Record<string, number> = {};
  const errorCounts = new Map<string, number>();
  let requests = 0, succeeded = 0, failed = 0;
  const deadline = Date.now() + duration;

  let consecutiveFailures = 0;
  let abort = false;

  async function worker() {
    while (!abort && Date.now() < deadline && requests < MAX_REQUESTS) {
      requests++;
      try {
        const res = await pingOnce(target, address, {}, MAX_RESPONSE_BYTES);
        latencies.push(res.ms);
        const bucket = `${Math.floor(res.status / 100)}xx`;
        statusCounts[bucket] = (statusCounts[bucket] ?? 0) + 1;
        if (res.status >= 200 && res.status < 400) { succeeded++; consecutiveFailures = 0; } else { failed++; consecutiveFailures++; }
      } catch (error) {
        failed++;
        consecutiveFailures++;
        const message = error instanceof Error ? error.message : "Request failed";
        errorCounts.set(message, (errorCounts.get(message) ?? 0) + 1);
      }
      // Back off instead of hammering a target that is already struggling.
      if (consecutiveFailures >= 10) abort = true;
    }
  }

  const started = Date.now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  const elapsed = (Date.now() - started) / 1000;

  const sorted = [...latencies].sort((a, b) => a - b);
  const result: LoadResult = {
    url: target.toString(),
    concurrency,
    duration,
    requests,
    succeeded,
    failed,
    errors: [...errorCounts.entries()].map(([message, count]) => ({ message, count })).sort((a, b) => b.count - a.count),
    statusCounts,
    latencyMs: {
      min: sorted[0] ?? 0,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      max: sorted[sorted.length - 1] ?? 0,
      avg: sorted.length ? Math.round(sorted.reduce((sum, n) => sum + n, 0) / sorted.length) : 0,
    },
    requestsPerSecond: elapsed > 0 ? Math.round((requests / elapsed) * 10) / 10 : 0,
    stoppedEarly: abort,
  };
  return result;
}
