import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { requireUser } from "@/lib/request-auth";
import { enforceRateLimit } from "@/lib/rate-limit";
import { scan } from "@/lib/scan";

export const maxDuration = 60;

function clientIp(request: Request) {
  return request.headers.get("x-real-ip") || request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() || "unknown";
}

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const rows = await sql`SELECT id, url, status, score, findings, checks, checked_at AS "checkedAt" FROM scans WHERE firebase_uid = ${user.uid} ORDER BY checked_at DESC LIMIT 20`;
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
    const result = await scan(body.url.trim());
    await sql`INSERT INTO users (firebase_uid, email, display_name, photo_url) VALUES (${user.uid}, ${user.email ?? null}, ${user.name ?? null}, ${user.picture ?? null}) ON CONFLICT (firebase_uid) DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name, photo_url = EXCLUDED.photo_url, updated_at = now()`;
    const rows = await sql`INSERT INTO scans (firebase_uid, url, score, findings, checks) VALUES (${user.uid}, ${result.url}, ${result.score}, ${JSON.stringify(result.findings)}::jsonb, ${JSON.stringify(result.checklist)}::jsonb) RETURNING id, url, status, score, findings, checks, checked_at AS "checkedAt"`;
    return NextResponse.json({ ...rows[0], statusCode: result.statusCode }, { status: 201 });
  } catch (error) { console.error("scan failed", error); const message = error instanceof Error ? error.message : "Scan failed"; const status = message.startsWith("Rate limit") ? 429 : message.includes("URL") || message.includes("network") || message.includes("redirect") ? 400 : 500; return NextResponse.json({ error: status === 500 ? "Scan service unavailable" : message }, { status }); }
}
