type F = { id?: number; title: string; area: string; copy: string; evidence: string };

/** Paste-ready prompt for a coding agent. Check 30 (duplicate submissions) gets a purpose-written one. */
export function repairPrompt(f: F, url: string) {
  const head = `Fix this issue found by VibeProof on ${url}\n\nProblem: ${f.title} (${f.area})\nEvidence: ${f.evidence}\n`;
  if (f.id === 30) return `${head}
Root cause: the signup handler is check-then-insert (look up the email, then create the user). Under slow responses the same request arrives twice (double click, retry, flaky mobile network) and both pass the lookup before either insert lands, so two accounts are created.

Do this:
1. Add a UNIQUE constraint/index on the normalized (lowercased, trimmed) email column in a migration. Dedupe existing rows first.
2. Create the user with one atomic statement (INSERT ... ON CONFLICT (email) DO NOTHING RETURNING id, or catch the unique-violation error). Never SELECT then INSERT.
3. On conflict return 409 with "An account with this email already exists", not a second success.
4. Client: disable the submit button and show a pending state while the request is in flight; send an Idempotency-Key header and honour it on the server.
5. Add a test that fires two concurrent signup POSTs with the same email and asserts exactly one account and one 2xx.

Then run \`vibeproof retest <original-report.json>\` (same slow-network test) to confirm.`;
  return `${head}\nRequired fix: ${f.copy}\n\nMake the smallest change that resolves this, do not refactor unrelated code, and explain what you changed. Then rerun VibeProof's retest to confirm.`;
}
