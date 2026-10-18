import { NextResponse } from "next/server";
import { runLoadTest } from "@/lib/loadtest";
import { enforceRateLimit } from "@/lib/rate-limit";
import { requireUser } from "@/lib/request-auth";

export const maxDuration = 20;

function clientIp(request: Request) {
  return request.headers.get("x-real-ip") || request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() || "unknown";
}

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    await enforceRateLimit(`loadtest-user:${user.uid}`, 3);
    await enforceRateLimit(`loadtest-ip:${clientIp(request)}`, 6);
    await enforceRateLimit(`loadtest-user-day:${user.uid}`, 15, 1440);
    const length = Number(request.headers.get("content-length") ?? 0);
    if (length > 2048) return NextResponse.json({ error: "Request is too large" }, { status: 413 });
    if (request.headers.get("content-type")?.split(";", 1)[0].trim() !== "application/json") return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || !("url" in body) || typeof body.url !== "string" || !body.url.trim()) return NextResponse.json({ error: "A URL is required" }, { status: 400 });
    if (!("confirmAuthorized" in body) || body.confirmAuthorized !== true) return NextResponse.json({ error: "Confirm you own or have permission to test this site" }, { status: 400 });
    let host: string;
    try { host = new URL(body.url.trim()).hostname.toLowerCase(); } catch { return NextResponse.json({ error: "Enter a valid URL" }, { status: 400 }); }
    await enforceRateLimit(`loadtest-host:${host}`, 1, 2);
    const concurrency = "concurrency" in body && typeof body.concurrency === "number" ? body.concurrency : undefined;
    const durationMs = "durationMs" in body && typeof body.durationMs === "number" ? body.durationMs : undefined;
    const result = await runLoadTest(body.url.trim(), { concurrency, durationMs });
    return NextResponse.json(result);
  } catch (error) {
    console.error("load test failed", error);
    const message = error instanceof Error ? error.message : "Load test failed";
    const status = message.startsWith("Rate limit") ? 429 : message.includes("URL") || message.includes("network") || message.includes("Private") ? 400 : 500;
    return NextResponse.json({ error: status === 500 ? "Load test service unavailable" : message }, { status });
  }
}
