import type { DecodedIdToken } from "firebase-admin/auth";
import { verifyFirebaseToken } from "./firebase-admin";

export async function requireUser(request: Request): Promise<DecodedIdToken> {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) throw new Error("Missing Firebase bearer token");
  return verifyFirebaseToken(header.slice(7));
}
