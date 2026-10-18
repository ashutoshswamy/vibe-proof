import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

function getAdminApp() {
  if (getApps().length) return getApps()[0];
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not configured");
  return initializeApp({ credential: cert(JSON.parse(raw)) });
}

export async function verifyFirebaseToken(token: string) {
  return getAuth(getAdminApp()).verifyIdToken(token, true);
}
