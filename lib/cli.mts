import { readFileSync, writeFileSync } from "node:fs";
import { compareRetest, verifyChain, type Report } from "./chain.mjs";
import { runEvidence } from "./evidence";

const [cmd, file, ...rest] = process.argv.slice(2);
const flag = (n: string) => rest.includes(`--${n}`);
const opt = (n: string) => (rest.includes(`--${n}`) ? rest[rest.indexOf(`--${n}`) + 1] : undefined);
const load = (p: string): Report => JSON.parse(readFileSync(p, "utf8"));

function show(report: Report, out?: string) {
  const checks = report.records.filter((r) => r.kind === "check");
  const failed = checks.filter((r) => r.data.status === "failed");
  console.log(`\n${report.target ?? report.records[0].data.url}  score ${report.score}  ${checks.filter((r) => r.data.status === "passed").length} passed, ${failed.length} failed${report.slow ? "  [slow-network mode]" : ""}`);
  for (const f of report.findings ?? []) console.log(`\n[${f.severity}] ${f.title}\n  ${f.evidence}\n\n  Repair prompt:\n${String(f.repair).split("\n").map((l: string) => `    ${l}`).join("\n")}`);
  console.log(`\nrun ${report.runId}\nhead ${report.head}`);
  if (out) { writeFileSync(out, JSON.stringify(report, null, 2)); console.log(`report saved to ${out}  (verify offline: npx vibeproof verify ${out})`); }
}

if (cmd === "scan" && file) {
  const { report } = await runEvidence({ url: file, slow: flag("slow") });
  show(report, opt("out") ?? "vibeproof-report.json");
} else if (cmd === "retest" && file) {
  const original = load(file), v = verifyChain(original);
  if (!v.ok) { console.error(`original report is not trustworthy: ${v.reason}`); process.exit(2); }
  const s = original.records[0].data; // same URL, same mode: the retest must execute the same test
  const { report } = await runEvidence({ url: s.url, slow: s.slow, link: { runId: original.runId!, head: v.head } });
  const out = opt("out") ?? "vibeproof-retest.json", only = opt("check") ? [Number(opt("check"))] : undefined;
  show(report, out);
  const r = compareRetest(original, report, only);
  console.log(`\n${r.fixVerified ? "✔" : "✘"} ${r.status}: ${r.reason}`);
  process.exit(r.fixVerified ? 0 : 1);
} else { console.error("usage: vibeproof scan <url> [--slow] [--out f] [--allow-local]\n       vibeproof retest <report.json> [--check <id>] [--out f] [--allow-local]\n       vibeproof verify <report.json> [--original <orig.json>] [--check <id>] [--head <hash>]"); process.exit(2); }
