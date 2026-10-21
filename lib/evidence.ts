import { randomUUID } from "node:crypto";
import { buildChain, reportOf, type Report } from "./chain.mjs";
import { scan } from "./scan";

/** One run -> hash-chained evidence. `link` ties a retest to the original run's head hash; slow-network mode and URL must match the original. */
export async function runEvidence(o: { url: string; slow?: boolean; link?: { runId: string; head: string } | null; runId?: string }) {
  const runId = o.runId ?? randomUUID();
  const result = await scan(o.url, { slow: o.slow });
  const fix = new Map(result.findings.map((f) => [f.id, f.copy]));
  const records = buildChain({ runId, url: o.url, slow: o.slow, link: o.link, statusCode: result.statusCode, checks: result.checklist.map((c) => ({ ...c, fix: fix.get(c.id) })) });
  const report: Report = reportOf(records, { target: result.url, score: result.score, slow: !!o.slow, findings: result.findings });
  return { result, records, report };
}
