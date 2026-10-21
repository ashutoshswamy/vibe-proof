// Tamper-evident evidence chain. Pure node:crypto, no deps, so `npx vibeproof verify` works offline.
// Each record hashes (seq, ts, runId, kind, prev, data); `prev` is the previous record's hash.
import { createHash } from "node:crypto";

export const GENESIS = "0".repeat(64);

const canon = (v) => (v && typeof v === "object" ? (Array.isArray(v) ? `[${v.map(canon).join(",")}]` : `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`) : JSON.stringify(v));
export const sha = (v) => createHash("sha256").update(typeof v === "string" ? v : canon(v)).digest("hex");
export const hashRecord = (r) => sha([r.seq, r.ts, r.runId, r.kind, r.prev, r.data]);

/** Appends one record to an in-memory chain. */
export function append(records, runId, kind, data, ts = new Date().toISOString()) {
  const r = { seq: records.length, ts, runId, kind, prev: records.length ? records.at(-1).hash : GENESIS, data };
  records.push({ ...r, hash: hashRecord(r) });
}

/** Fingerprint of "the same test": target, mode and the exact checklist that ran. */
export const testHash = (url, slow, checks) => sha({ url, slow: !!slow, checks: checks.map((c) => [c.id, c.title]) });

/** start -> one record per check -> end. `link` = { runId, head } of the original run for retests. */
export function buildChain({ runId, url, slow, checks, link, statusCode }) {
  const records = [];
  append(records, runId, "start", { url, slow: !!slow, testHash: testHash(url, slow, checks), retestOf: link ?? null, statusCode: statusCode ?? null });
  for (const c of checks) append(records, runId, "check", { id: c.id, section: c.section, title: c.title, status: c.status, reason: c.reason ?? "", fix: c.fix ?? null });
  append(records, runId, "end", { total: checks.length, failed: checks.filter((c) => c.status === "failed").length });
  return records;
}

export const reportOf = (records, extra = {}) => ({ format: "vibeproof-report/1", runId: records[0]?.runId, head: records.at(-1)?.hash, ...extra, records });

const label = (r) => (r.kind === "check" ? `check ${r.data?.id} "${r.data?.title}"` : r.kind);

/** Walks the chain. Returns { ok, records, head } or { ok:false, at, reason } naming the first bad record. */
export function verifyChain(report, expectedHead) {
  const recs = report?.records;
  if (!Array.isArray(recs) || !recs.length) return { ok: false, at: 0, reason: "report has no records" };
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    if (r.seq !== i) return { ok: false, at: i, reason: `record #${i}: sequence is ${r.seq} (record removed, inserted or reordered)` };
    if (r.runId !== recs[0].runId) return { ok: false, at: i, reason: `record #${i}: belongs to a different run` };
    if (hashRecord(r) !== r.hash) return { ok: false, at: i, reason: `record #${i} (${label(r)}): content does not match its hash (edited after it was logged)` };
    const want = i ? recs[i - 1].hash : GENESIS;
    if (r.prev !== want) return { ok: false, at: i ? i - 1 : 0, reason: `record #${i} does not link to record #${i - 1}: record #${i - 1} (${i ? label(recs[i - 1]) : "genesis"}) was rewritten or replaced` };
  }
  const head = recs.at(-1).hash;
  if (recs.at(-1).kind !== "end") return { ok: false, at: recs.length, reason: `chain ends at record #${recs.length - 1} without an end record (truncated; later records were deleted)` };
  if (report.head && report.head !== head) return { ok: false, at: recs.length - 1, reason: `report head ${report.head.slice(0, 12)}… does not match last record ${head.slice(0, 12)}…` };
  if (expectedHead && expectedHead !== head) return { ok: false, at: recs.length - 1, reason: `head ${head.slice(0, 12)}… differs from the pinned head ${expectedHead.slice(0, 12)}… (records were appended, removed or replaced)` };
  return { ok: true, records: recs.length, head };
}

/** "Fix Verified" only when the retest links to the original run's hash, runs the same test, and the original failures now pass. */
export function compareRetest(original, retest, only) {
  const no = (reason) => ({ fixVerified: false, status: "Not verified", reason, fixed: [], stillFailing: [] });
  const a = verifyChain(original), b = verifyChain(retest);
  if (!a.ok) return no(`original report is invalid: ${a.reason}`);
  if (!b.ok) return no(`retest report is invalid: ${b.reason}`);
  const s0 = original.records[0].data, s1 = retest.records[0].data;
  if (!s1.retestOf) return no("this run is not a retest (it carries no link to an original run)");
  if (s1.retestOf.runId !== original.records[0].runId || s1.retestOf.head !== a.head) return no(`retest links to ${String(s1.retestOf.head).slice(0, 12)}…, not the original head ${a.head.slice(0, 12)}…`);
  if (s0.testHash !== s1.testHash) return no("retest did not execute the same test (target, slow-network mode or checklist differ)");
  const status = (recs) => new Map(recs.filter((r) => r.kind === "check").map((r) => [r.data.id, r.data]));
  const was = status(original.records), now = status(retest.records);
  const targets = [...was.values()].filter((c) => c.status === "failed" && (!only || only.includes(c.id)));
  if (!targets.length) return no("the original run had no failed check to verify");
  const fixed = targets.filter((c) => now.get(c.id)?.status === "passed").map((c) => c.id);
  const stillFailing = targets.filter((c) => now.get(c.id)?.status !== "passed").map((c) => c.id);
  const fixVerified = !stillFailing.length;
  return { fixVerified, status: fixVerified ? "Fix Verified" : fixed.length ? "Partially fixed" : "Not fixed", reason: `${fixed.length ? `check ${fixed.join(", ")} failed in the original run and now passes (Fix Verified). ` : ""}${stillFailing.length ? `check ${stillFailing.join(", ")} still not passing.` : ""}`.trim(), fixed, stillFailing };
}
