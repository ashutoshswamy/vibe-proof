import { createHash } from "node:crypto";
import { sql } from "@/lib/db";

export async function enforceRateLimit(key: string, maxRequests: number, windowMinutes = 1) {
  const hashedKey = createHash("sha256").update(key).digest("hex");
  const rows = await sql`
    WITH inserted AS (
      INSERT INTO rate_limit_events (key_hash) VALUES (${hashedKey}) RETURNING id
    ), counted AS (
      SELECT COUNT(*)::int AS count FROM rate_limit_events
      WHERE key_hash = ${hashedKey} AND created_at >= now() - make_interval(mins => ${windowMinutes})
    )
    SELECT inserted.id, counted.count FROM inserted CROSS JOIN counted
  `;
  const count = Number(rows[0]?.count ?? 0);
  if (count > maxRequests) {
    await sql`DELETE FROM rate_limit_events WHERE id = ${rows[0].id}`;
    throw new Error(windowMinutes > 1 ? `Rate limit exceeded; try again in ${windowMinutes} minutes` : "Rate limit exceeded; try again in a minute");
  }
  if (Math.random() < 0.02) await sql`DELETE FROM rate_limit_events WHERE created_at < now() - interval '1 day'`;
}
