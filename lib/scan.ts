import { checkRepo, parseRepo, repoInfo } from "@/lib/repo";
import { checkUrl, report, type Verdict } from "@/lib/scanner";

const rank = { failed: 2, passed: 1, not_testable: 0 } as const;

function merge(parts: (Verdict | undefined)[]): Verdict | undefined {
  const found = parts.filter((v): v is Verdict => !!v);
  if (found.length < 2) return found[0];
  const status = found.reduce((best, v) => (rank[v.status] > rank[best] ? v.status : best), "not_testable" as Verdict["status"]);
  const same = found.filter((v) => v.status === status);
  return { status, reason: same.map((v) => v.reason).join(" "), fix: same.map((v) => v.fix).filter(Boolean).join(" ") || undefined };
}

/** Accepts a site URL or a public GitHub repository URL. */
export async function scan(input: string) {
  const repo = parseRepo(input);
  if (!repo) return report(...(await checkUrl(input).then((r) => [r.url, r.verdicts, r.statusCode] as const)));
  const meta = await repoInfo(repo);
  const homepage = meta.homepage && /^https?:\/\//i.test(meta.homepage) ? meta.homepage : undefined;
  const [source, site] = await Promise.all([checkRepo(repo, meta), homepage ? checkUrl(homepage).catch(() => undefined) : undefined]);
  const verdicts: Record<number, Verdict> = {};
  for (let id = 1; id <= 82; id++) {
    const v = merge([site?.verdicts[id], source.verdicts[id]]);
    if (v) verdicts[id] = v;
    else if (!site) verdicts[id] = { status: "not_testable", reason: "Needs the deployed site. Set the repository's website URL on GitHub, or scan the site URL directly." };
  }
  return report(source.url, verdicts, site?.statusCode);
}
