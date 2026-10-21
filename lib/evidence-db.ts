import { sql } from "./db";
import { reportOf, type ChainRecord, type Report } from "./chain.mjs";

export async function saveEvidence(records: ChainRecord[]) {
  await sql`INSERT INTO evidence_log (run_id, seq, ts, kind, prev, data, hash)
    SELECT r.run_id, r.seq, r.ts, r.kind, r.prev, r.data, r.hash FROM jsonb_to_recordset(${JSON.stringify(records.map((r) => ({ ...r, run_id: r.runId })))}::jsonb) AS r(run_id uuid, seq int, ts text, kind text, prev text, data jsonb, hash text)`;
}

/** Exportable report for one of the user's runs; `null` if it is not theirs. Verify it offline with `npx vibeproof verify`. */
export async function loadReport(id: string, uid: string): Promise<(Report & { slow: boolean; url: string }) | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [scan] = await sql`SELECT url, slow, findings, score FROM scans WHERE id = ${id} AND firebase_uid = ${uid}`;
  if (!scan) return null;
  const rows = await sql`SELECT run_id AS "runId", seq, ts, kind, prev, data, hash FROM evidence_log WHERE run_id = ${id} ORDER BY seq`;
  return reportOf(rows as ChainRecord[], { target: scan.url, score: scan.score, slow: scan.slow, findings: scan.findings }) as Report & { slow: boolean; url: string };
}
