#!/usr/bin/env node
// `verify` is dependency-free and offline. `scan` / `retest` load the TypeScript scanner through tsx.
import { readFileSync } from "node:fs";
import { compareRetest, verifyChain } from "../lib/chain.mjs";

const [cmd, file, ...rest] = process.argv.slice(2);
const opt = (n) => (rest.includes(`--${n}`) ? rest[rest.indexOf(`--${n}`) + 1] : undefined);

if (cmd === "verify" && file) {
  const load = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch (e) { console.error(`cannot read ${p}: ${e.message}`); process.exit(2); } };
  const report = load(file), v = verifyChain(report, opt("head"));
  if (!v.ok) {
    console.log(`✘ TAMPERED: ${v.reason}`);
    console.log(`  first bad record: #${v.at}`);
    process.exit(1);
  }
  console.log(`✔ chain intact: ${v.records} records, head ${v.head}`);
  console.log("  (pin the head hash somewhere you trust and pass --head to also detect a fully rewritten file)");
  if (report.records[0].data.retestOf) {
    if (!opt("original")) console.log(`  retest of run ${report.records[0].data.retestOf.runId} (head ${report.records[0].data.retestOf.head.slice(0, 16)}…): pass --original <report.json> to confirm "Fix Verified"`);
    else { const r = compareRetest(load(opt("original")), report, opt("check") ? [Number(opt("check"))] : undefined); console.log(`${r.fixVerified ? "✔" : "✘"} ${r.status}: ${r.reason}`); process.exit(r.fixVerified ? 0 : 1); }
  }
} else if ((cmd === "scan" || cmd === "retest") && file) {
  if (rest.includes("--allow-local")) process.env.VIBEPROOF_ALLOW_LOCAL = "1";
  const { register } = await import("tsx/esm/api");
  register();
  await import("../lib/cli.mts");
} else {
  console.error("usage: vibeproof verify <report.json> [--original <orig.json>] [--check <id>] [--head <hash>]\n       vibeproof scan <url> [--slow] [--out f] [--allow-local]\n       vibeproof retest <report.json> [--check <id>] [--out f] [--allow-local]");
  process.exit(2);
}
