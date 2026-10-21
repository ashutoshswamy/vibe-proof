import { NextResponse } from "next/server";
import { loadReport } from "@/lib/evidence-db";
import { requireUser } from "@/lib/request-auth";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request);
    const report = await loadReport((await params).id, user.uid);
    if (!report?.records.length) return NextResponse.json({ error: "Report not found" }, { status: 404 });
    return new NextResponse(JSON.stringify(report, null, 2), { headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="vibeproof-${report.runId}.json"` } });
  } catch { return NextResponse.json({ error: "Authentication or database request failed" }, { status: 401 }); }
}
