import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { requireUser } from "@/lib/request-auth";
import { enforceRateLimit } from "@/lib/rate-limit";
import { compareRetest, verifyChain } from "@/lib/chain.mjs";
import { runEvidence } from "@/lib/evidence";
import { loadReport, saveEvidence } from "@/lib/evidence-db";

export const maxDuration = 60;

function clientIp(request: Request) {
  return request.headers.get("x-real-ip") || request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() || "unknown";
}

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const rows = await sql`SELECT id, url, status, score, findings, checks, slow, head, retest_of AS "retestOf", checked_at AS "checkedAt" FROM scans WHERE firebase_uid = ${user.uid} ORDER BY checked_at DESC LIMIT 20`;
    return NextResponse.json(rows);
  } catch { return NextResponse.json({ error: "Authentication or database request failed" }, { status: 401 }); }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    await enforceRateLimit(`user:${user.uid}`, 10);
    await enforceRateLimit(`ip:${clientIp(request)}`, 30);
    const length = Number(request.headers.get("content-length") ?? 0);
    if (length > 8192) return NextResponse.json({ error: "Request is too large" }, { status: 413 });
    if (request.headers.get("content-type")?.split(";", 1)[0].trim() !== "application/json") return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || !("url" in body) || typeof body.url !== "string" || !body.url.trim()) return NextResponse.json({ error: "A URL is required" }, { status: 400 });
    const b = body as { slow?: unknown; retestOf?: unknown; checkId?: unknown };
    let url = body.url.trim(), slow = b.slow === true, link: { runId: string; head: string } | null = null, original = null as Awaited<ReturnType<typeof loadReport>>;
    if (typeof b.retestOf === "string") { // a retest re-executes the original run's exact test (same URL, same slow-network mode) and links to its head hash
      original = await loadReport(b.retestOf, user.uid);
      const valid = original && verifyChain(original);
      if (!original || !valid?.ok) return NextResponse.json({ error: original ? `Original evidence failed verification: ${valid && !valid.ok ? valid.reason : ""}` : "Original scan not found" }, { status: original ? 409 : 404 });
      url = original.records[0].data.url; slow = original.records[0].data.slow; link = { runId: original.runId!, head: valid.head };
    }
    const { result, records, report } = await runEvidence({ url, slow, link });
    const retest = original ? compareRetest(original, report, typeof b.checkId === "number" ? [b.checkId] : undefined) : undefined;
    await sql`INSERT INTO users (firebase_uid, email, display_name, photo_url) VALUES (${user.uid}, ${user.email ?? null}, ${user.name ?? null}, ${user.picture ?? null}) ON CONFLICT (firebase_uid) DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name, photo_url = EXCLUDED.photo_url, updated_at = now()`;
    const rows = await sql`INSERT INTO scans (id, firebase_uid, url, score, findings, checks, slow, head, retest_of) VALUES (${report.runId}, ${user.uid}, ${result.url}, ${result.score}, ${JSON.stringify(result.findings)}::jsonb, ${JSON.stringify(result.checklist)}::jsonb, ${slow}, ${report.head}, ${link ? link.runId : null}) RETURNING id, url, status, score, findings, checks, slow, head, retest_of AS "retestOf", checked_at AS "checkedAt"`;
    await saveEvidence(records);
    return NextResponse.json({ ...rows[0], statusCode: result.statusCode, retest }, { status: 201 });
  } catch (error) { console.error("scan failed", error); const message = error instanceof Error ? error.message : "Scan failed"; const status = message.startsWith("Rate limit") ? 429 : message.includes("URL") || message.includes("network") || message.includes("redirect") ? 400 : 500; return NextResponse.json({ error: status === 500 ? "Scan service unavailable" : message }, { status }); }
}
