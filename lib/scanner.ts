import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import zlib from "node:zlib";
import { createChecklist, type CheckStatus } from "@/lib/checklist";
import { browserChecks } from "@/lib/browser";

export type ScanFinding = { title: string; area: string; severity: "High" | "Medium" | "Low"; copy: string; evidence: string };
export type Verdict = { status: CheckStatus; reason: string; fix?: string };
type Res = { url: URL; status: number; headers: http.IncomingHttpHeaders; body: string; bytes: number; truncated: boolean; ms: number; chain: string[] };

const UA = "VibeProof/1.0 verification bot";
const MAX_REQUESTS = 90;

/* ---------- network (every hop is SSRF-checked and pinned to the resolved address) ---------- */

const blocked = new BlockList();
for (const [net, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) blocked.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["64:ff9b::", 96]] as const) blocked.addSubnet(net, bits, "ipv6");

function privateAddress(address: string) {
  const mapped = address.toLowerCase().match(/^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/);
  if (mapped) address = mapped[1] ?? [parseInt(mapped[2], 16) >> 8, parseInt(mapped[2], 16) & 255, parseInt(mapped[3], 16) >> 8, parseInt(mapped[3], 16) & 255].join(".");
  const family = isIP(address);
  return family === 0 || blocked.check(address, family === 4 ? "ipv4" : "ipv6");
}

export async function validTarget(value: string) {
  if (value.length > 2048) throw new Error("URL is too long");
  const target = new URL(value);
  if (!/^https?:$/.test(target.protocol)) throw new Error("URL must use http or https");
  if (target.username || target.password) throw new Error("URLs with credentials are not allowed");
  const addresses = isIP(target.hostname) ? [{ address: target.hostname }] : await lookup(target.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => privateAddress(address))) throw new Error("Private network targets are not allowed");
  return { target, address: addresses[0].address };
}

export function pingOnce(target: URL, address: string, headers: Record<string, string>, maxBytes: number) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; buf: Buffer; truncated: boolean; ms: number }>((resolve, reject) => {
    const transport = target.protocol === "https:" ? https : http;
    const started = Date.now();
    const req = transport.request({ hostname: address, port: target.port || undefined, path: `${target.pathname}${target.search}`, method: "GET", headers: { host: target.host, "user-agent": UA, accept: "text/html,application/xhtml+xml,*/*;q=0.8", "accept-encoding": "gzip, br", ...headers }, servername: target.hostname, family: isIP(address) }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0, truncated = false, done = false;
      const finish = () => { if (!done) { done = true; resolve({ status: res.statusCode ?? 0, headers: res.headers, buf: Buffer.concat(chunks), truncated, ms: Date.now() - started }); } };
      res.on("data", (chunk: Buffer) => { if (truncated) return; chunks.push(chunk); size += chunk.length; if (size > maxBytes) { truncated = true; req.destroy(); finish(); } });
      res.on("end", finish); res.on("close", finish); res.on("error", finish);
    });
    req.setTimeout(10_000, () => req.destroy(new Error("Target request timed out")));
    req.on("error", reject);
    req.end();
  });
}

function decode(raw: { headers: http.IncomingHttpHeaders; buf: Buffer }) {
  const type = String(raw.headers["content-type"] ?? "");
  if (!/text|json|javascript|xml|svg|css/i.test(type)) return "";
  const enc = String(raw.headers["content-encoding"] ?? "");
  try {
    const buf = enc === "gzip" ? zlib.gunzipSync(raw.buf, { finishFlush: zlib.constants.Z_SYNC_FLUSH }) : enc === "br" ? zlib.brotliDecompressSync(raw.buf) : raw.buf;
    return buf.toString("utf8");
  } catch { return ""; }
}

function crawler() {
  let requests = 0;
  async function get(url: string, o: { follow?: boolean; headers?: Record<string, string>; maxBytes?: number } = {}): Promise<Res> {
    const chain: string[] = [];
    let current = url;
    for (let hop = 0; hop < 6; hop++) {
      if (++requests > MAX_REQUESTS) throw new Error("Request budget exhausted");
      const { target, address } = await validTarget(current);
      const raw = await pingOnce(target, address, o.headers ?? {}, o.maxBytes ?? 1_500_000);
      const location = raw.headers.location;
      if (o.follow && raw.status >= 300 && raw.status < 400 && location) { current = new URL(location, target).toString(); chain.push(current); continue; }
      return { url: target, status: raw.status, headers: raw.headers, body: decode(raw), bytes: raw.buf.length, truncated: raw.truncated, ms: raw.ms, chain };
    }
    throw new Error("Too many redirects");
  }
  const safe = (url: string, o?: Parameters<typeof get>[1]) => get(url, o).catch(() => undefined);
  return { get, safe };
}

async function pool<T, R>(items: T[], fn: (item: T) => Promise<R>, size = 8) {
  const out: R[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } }));
  return out;
}

async function lighthouse(url: string) {
  const key = process.env.PAGESPEED_API_KEY;
  if (!key) return undefined;
  const api = new URL("https://www.googleapis.com/pagespeedonline/v5/runPagespeed");
  api.searchParams.set("url", url); api.searchParams.set("strategy", "mobile"); api.searchParams.set("key", key);
  for (const c of ["performance", "accessibility", "best-practices", "seo"]) api.searchParams.append("category", c);
  try {
    const response = await fetch(api, { signal: AbortSignal.timeout(45_000) });
    return response.ok ? (await response.json()).lighthouseResult as { categories: Record<string, { score: number | null }>; audits: Record<string, { score: number | null }> } : undefined;
  } catch { return undefined; }
}

/* ---------- html helpers ---------- */

const tags = (html: string, name: string) => html.match(new RegExp(`<(?:${name})\\b[^>]*>`, "gi")) ?? [];
const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"))?.slice(1).find((v) => v !== undefined);
const hasAttr = (tag: string, name: string) => new RegExp(`\\s${name}(?:\\s|=|>|/)`, "i").test(tag);
const strip = (s: string) => s.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const meta = (html: string, key: string) => { const t = tags(html, "meta").find((m) => new RegExp(`(?:name|property)\\s*=\\s*["']${key}["']`, "i").test(m)); return t ? attr(t, "content") : undefined; };
const header = (res: Res | undefined, name: string) => { const v = res?.headers[name]; return Array.isArray(v) ? v.join(", ") : v; };
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const kb = (n: number) => `${Math.round(n / 1024)} KB`;
const list = (items: string[], max = 4) => items.slice(0, max).join(", ") + (items.length > max ? ` and ${items.length - max} more` : "");

const pass = (reason: string): Verdict => ({ status: "passed", reason });
const fail = (reason: string, fix: string): Verdict => ({ status: "failed", reason, fix });
const skip = (reason: string): Verdict => ({ status: "not_testable", reason });

export const secretPatterns: [string, RegExp][] = [
  ["AWS access key", /AKIA[0-9A-Z]{16}/],
  ["Stripe live secret key", /\b[sr]k_live_[0-9a-zA-Z]{16,}/],
  ["API secret key (sk-...)", /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ["SendGrid key", /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/],
  ["Private key block", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
];
export function findSecrets(text: string) {
  const hits = secretPatterns.flatMap(([label, re]) => { const m = text.match(re); return m ? [`${label} (${m[0].slice(0, 6)}...)`] : []; });
  for (const jwt of text.match(/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g) ?? []) {
    try { if (JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString()).role === "service_role") { hits.push("Supabase service_role JWT"); break; } } catch { /* not a JWT */ }
  }
  return hits;
}

const sensitive: [string, RegExp][] = [
  ["/.env", /^[A-Z][A-Z0-9_]*\s*=/m], ["/.env.local", /^[A-Z][A-Z0-9_]*\s*=/m], ["/.env.production", /^[A-Z][A-Z0-9_]*\s*=/m],
  ["/.git/HEAD", /^ref: refs\//], ["/.git/config", /\[core\]/], ["/package.json", /"(?:dependencies|devDependencies|scripts)"/], ["/.DS_Store", /Bud1/],
];

/* ---------- the 82 checks ---------- */

export async function checkUrl(value: string) {
  const net = crawler();
  const rand = Math.random().toString(36).slice(2, 10);
  new URL(value);
  let page: Res;
  try { page = await net.get(value, { follow: true }); } catch (error) { throw new Error(`Could not reach URL: ${error instanceof Error ? error.message : "request failed"}`); }
  if (!/html/i.test(String(page.headers["content-type"] ?? ""))) throw new Error("URL did not return an HTML page");
  const base = page.url, origin = base.origin, secure = base.protocol === "https:";
  const visual = browserChecks(base.toString());
  const html = page.body, text = strip(html);
  const resolve = (href: string | undefined) => { try { const u = href ? new URL(href, base) : undefined; if (u) u.hash = ""; return u && /^https?:$/.test(u.protocol) ? u : undefined; } catch { return undefined; } };

  const anchors = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].map((m) => ({ inner: m[2], tag: `<a${m[1]}>`, href: attr(`<a${m[1]}>`, "href"), label: strip(m[2]) || attr(`<a${m[1]}>`, "aria-label") || attr(`<a${m[1]}>`, "title") || "" }));
  const emptyLinks = anchors.filter((a) => a.href === undefined ? false : !a.href.trim() || a.href.trim() === "#" || a.href.trim().toLowerCase().startsWith("javascript:"));
  const internal = [...new Map(anchors.flatMap((a) => { const u = resolve(a.href); return u && u.origin === origin && u.pathname !== base.pathname && !/\.(?:png|jpe?g|gif|svg|webp|pdf|zip|ico|css|js)$/i.test(u.pathname) ? [[u.pathname + u.search, u.toString()] as const] : []; })).values()].slice(0, 8);
  const assetUrls = (items: (string | undefined)[], limit: number) => [...new Set(items.flatMap((i) => { const u = resolve(i); return u && u.origin === origin ? [u.toString()] : []; }))].slice(0, limit);
  const scriptSrc = assetUrls(tags(html, "script").map((t) => attr(t, "src")), 8);
  const styleHref = assetUrls(tags(html, "link").filter((t) => /rel\s*=\s*["']?stylesheet/i.test(t)).map((t) => attr(t, "href")), 5);
  const imgTags = tags(html, "img");
  const imageSrc = assetUrls(imgTags.map((t) => attr(t, "src")), 12);
  const iconHref = assetUrls(tags(html, "link").filter((t) => /rel\s*=\s*["'][^"']*icon/i.test(t)).map((t) => attr(t, "href")), 2);
  const ogImage = assetUrls([meta(html, "og:image")], 1);

  const probePaths = { robots: "/robots.txt", sitemap: "/sitemap.xml", favicon: "/favicon.ico", notFound: `/vibeproof-${rand}`, admin: "/admin", ...Object.fromEntries(sensitive.map(([p]) => [p, p])), h1: "/health", h2: "/healthz", h3: "/api/health", h4: "/api/healthz" };
  const probeEntries = Object.entries(probePaths);
  const [probeRes, pageRes, scriptRes, styleRes, imageRes, iconRes, ogRes, httpVariant, cors, lh] = await Promise.all([
    pool(probeEntries, ([, p]) => net.safe(`${origin}${p}`, { maxBytes: 150_000 })),
    pool(internal, (u) => net.safe(u, { follow: true, maxBytes: 600_000 })),
    pool(scriptSrc, (u) => net.safe(u, { maxBytes: 1_200_000 })),
    pool(styleHref, (u) => net.safe(u, { maxBytes: 800_000 })),
    pool(imageSrc, (u) => net.safe(u, { maxBytes: 800_000 })),
    pool(iconHref, (u) => net.safe(u, { maxBytes: 100_000 })),
    pool(ogImage, (u) => net.safe(u, { maxBytes: 100_000 })),
    secure ? net.safe(`http://${base.hostname}/`, { maxBytes: 20_000 }) : Promise.resolve(undefined),
    net.safe(base.toString(), { headers: { origin: "https://vibeproof-cors-test.invalid" }, maxBytes: 20_000 }),
    lighthouse(base.toString()),
  ]);
  const probe = Object.fromEntries(probeEntries.map(([k], i) => [k, probeRes[i]])) as Record<string, Res | undefined>;
  const pages = internal.map((url, i) => ({ url, res: pageRes[i] }));
  const scripts = scriptRes.map((res, i) => ({ url: scriptSrc[i], res }));
  const styles = styleRes.map((res, i) => ({ url: styleHref[i], res }));
  const images = imageRes.map((res, i) => ({ url: imageSrc[i], res }));
  const assets = [...scripts, ...styles, ...images, ...iconHref.map((url, i) => ({ url, res: iconRes[i] })), ...ogImage.map((url, i) => ({ url, res: ogRes[i] }))];
  const code = [html, ...scripts.map((s) => s.res?.body ?? "")].join("\n");
  const css = styles.map((x) => x.res?.body ?? "").join("\n") + (html.match(/<style\b[^>]*>[\s\S]*?<\/style>/gi) ?? []).join("\n");
  const sizeOf = (r?: Res) => Number(r?.headers["content-length"]) || r?.bytes || 0;
  const spa = probe.notFound?.status === 200;

  const c: Record<number, Verdict> = {};
  const manual = (id: number, reason: string) => { c[id] = skip(reason); };

  /* 1. Functionality & user flows */
  const refused = (x?: Res) => !!x && [401, 403, 429].includes(x.status);
  const brokenPages = pages.filter((p) => !p.res || (p.res.status >= 400 && !refused(p.res)));
  const brokenAssets = assets.filter((a) => !a.res || (a.res.status >= 400 && !refused(a.res)));
  const refusedCount = [...pages, ...assets].filter((x) => refused(x.res)).length;
  const refusedNote = refusedCount ? ` ${plural(refusedCount, "URL")} refused automated requests (401, 403 or 429) and could not be judged.` : "";
  c[1] = !anchors.length ? skip("No links found in the HTML. The page may render only in JavaScript.") : emptyLinks.length || brokenPages.length ? fail(`${emptyLinks.length ? `${plural(emptyLinks.length, "empty link")}` : ""}${emptyLinks.length && brokenPages.length ? " and " : ""}${brokenPages.length ? `${plural(brokenPages.length, "broken internal link")} (${list(brokenPages.map((p) => new URL(p.url).pathname))})` : ""} found.`, 'Point every link at a real route and remove href="#" or javascript: placeholders.') : pass(`${plural(anchors.length, "link")} read, ${plural(pages.length, "internal page")} fetched, none broken. Button click handlers were not exercised.${refusedNote}`);
  const formBlocks = html.match(/<form\b[^>]*>[\s\S]*?<\/form>/gi) ?? [];
  const unvalidated = formBlocks.filter((f) => { const fields = tags(f, "input|textarea|select").filter((t) => !/type\s*=\s*["']?(?:hidden|submit|button|checkbox|radio)/i.test(t)); return fields.length && !fields.some((t) => /\s(?:required|pattern|min|max|minlength|maxlength)(?:\s|=|>|\/)|type\s*=\s*["']?(?:email|url|number|tel|date)/i.test(t)); });
  c[2] = !formBlocks.length ? skip("No forms found on this page.") : unvalidated.length ? fail(`${plural(unvalidated.length, "form")} with fields but no HTML validation attributes (required, type, pattern, min/max).`, "Add required/type/pattern attributes and show inline success and error messages after submit.") : pass(`${plural(formBlocks.length, "form")} use HTML validation attributes. Submit and error states were not exercised.`);
  const loginUi = anchors.some((a) => /log\s?-?in|sign\s?-?in|\/login|\/signin/i.test(`${a.label} ${a.href}`)) || /type\s*=\s*["']password/i.test(html);
  const signupUi = anchors.some((a) => /sign\s?-?up|register|create account|\/signup|\/register/i.test(`${a.label} ${a.href}`));
  const resetUi = anchors.some((a) => /forgot|reset|\/reset/i.test(`${a.label} ${a.href}`)) || /forgot (?:your )?password/i.test(text);
  const loginLocal = /type\s*=\s*["']password/i.test(html) || anchors.some((a) => /log\s?-?in|sign\s?-?in|\/login|\/signin/i.test(`${a.label} ${a.href}`) && resolve(a.href)?.origin === origin);
  c[3] = !loginUi && !signupUi ? skip("No login or signup UI found on this page. Auth flows need an account to test.") : !resetUi && loginLocal ? fail("Login UI found but no password reset link.", "Add a Forgot password link and a working reset-by-email flow.") : pass("Login/signup UI found with a reset path. The flows themselves need a real account to exercise.");
  manual(4, "CRUD needs authenticated test data. Run it by hand or with an end-to-end test.");
  const searchUi = /type\s*=\s*["']search|role\s*=\s*["']search|name\s*=\s*["'](?:q|query|search)["']|rel\s*=\s*["']next["']|[?&]page=\d|aria-label\s*=\s*["']pagination/i.test(html);
  c[5] = searchUi ? pass("Search or pagination controls found in markup. Behavior was not exercised.") : skip("No search, filter or pagination UI found on this page.");
  manual(6, "Loading, empty and error states need the app running in a browser with real data.");
  const okPages = pages.filter((p) => p.res && p.res.status < 400);
  c[7] = !pages.length ? skip("No internal pages to load directly.") : brokenPages.length ? fail(`Direct load failed for ${list(brokenPages.map((p) => new URL(p.url).pathname))}.`, "Make every route resolve on a direct request (SPA fallback or server-rendered route).") : pass(`${plural(okPages.length, "internal URL")} loaded directly with a 2xx response. Back/refresh behavior was not exercised.`);
  const placeholder = text.match(/lorem ipsum|\bTODO\b|\bFIXME\b|coming soon|(?:your|insert) (?:text|title|content|company|logo) here|placeholder text|dummy (?:text|data)|\bTBD\b/i)?.[0];
  c[8] = placeholder || emptyLinks.length ? fail(`${placeholder ? `Found "${placeholder}" in page text` : ""}${placeholder && emptyLinks.length ? " and " : ""}${emptyLinks.length ? plural(emptyLinks.length, "placeholder link") : ""}.`, "Replace placeholder copy and dead buttons with real content before launch.") : pass("No placeholder copy or placeholder links found on the page.");

  /* 2. UI/UX & responsiveness */
  const viewport = meta(html, "viewport");
  const responsiveRules = (css.match(/@media[^{]*\(\s*(?:min|max)-width/g) ?? []).length;
  c[9] = !viewport ? fail("No <meta name=viewport> tag.", 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.') : pass(`Viewport meta present${responsiveRules ? ` and ${plural(responsiveRules, "responsive CSS rule")} found` : ""}. Real device sizes were not rendered.`);
  manual(10, "Overflow and overlap need a rendered layout. Check 320px, 768px and 1280px in browser dev tools.");
  c[11] = viewport && /user-scalable\s*=\s*(?:no|0)|maximum-scale\s*=\s*1(?:\.0)?(?:\D|$)/i.test(viewport) ? fail("Viewport blocks pinch zoom.", "Remove user-scalable=no and maximum-scale=1 from the viewport meta.") : skip("Tap-target size and readability need a rendered page. Pinch zoom is not blocked.");
  manual(12, "Modals, dropdowns and menus need interaction in a browser.");
  c[13] = brokenAssets.length ? fail(`${plural(brokenAssets.length, "asset")} failed to load: ${list(brokenAssets.map((a) => new URL(a.url).pathname))}.`, "Fix asset paths or restore the missing files in the production build.") : assets.length ? pass(`${plural(assets.length, "asset")} (scripts, styles, images, icons) loaded successfully.`) : skip("No same-origin assets found to load.");
  c[14] = /prefers-color-scheme|color-scheme|data-theme|\.dark\b/i.test(css + html) ? pass("Dark/light mode rules found in the page or CSS.") : skip("No dark mode detected. Fine if the site does not support it.");
  manual(15, "Long text, empty lists and large datasets need real data in a browser.");
  const nf = probe.notFound;
  const defaultNotFound = nf && nf.status === 404 && (strip(nf.body).length < 120 || /cannot get|nginx|apache|default backend/i.test(nf.body));
  c[16] = !nf || refused(nf) ? skip("The 404 probe could not be fetched or was refused by the server.") : nf.status === 200 ? fail("Unknown URLs return 200 instead of 404.", "Return a real 404 status with a designed not-found page for unknown routes.") : defaultNotFound ? fail("Unknown URLs show a bare default 404 page.", "Add a branded 404 page with a link back to the homepage.") : nf.status === 404 ? pass("Unknown URLs return 404 with a custom page.") : fail(`Unknown URL returned ${nf.status}.`, "Return a 404 status for unknown routes.");

  /* 3. Security & privacy */
  const secrets = findSecrets(code);
  c[17] = secrets.length ? fail(`Secret-looking values in client code: ${list(secrets)}.`, "Revoke these keys now, move them to server-side env vars and call the provider from an API route.") : pass(`Scanned the HTML and ${plural(scripts.length, "script")} for key, token and private-key patterns. None found.`);
  const envHits = ["/.env", "/.env.local", "/.env.production"].filter((p) => { const r = probe[p]; return r?.status === 200 && sensitive.find(([k]) => k === p)![1].test(r.body); });
  c[18] = envHits.length ? fail(`Environment file is publicly readable: ${envHits.join(", ")}.`, "Block dotfiles at the host, rotate every value in the file and keep it out of the deploy output.") : pass("/.env, /.env.local and /.env.production are not publicly served.");
  manual(19, "Server-side input validation needs authenticated API tests. Send malformed payloads and confirm rejection.");
  manual(20, "Authorization needs two accounts. Call protected API routes directly and confirm the server rejects them.");
  manual(21, "Cross-user access needs two accounts. Request user B's records while signed in as user A.");
  c[22] = skip(/supabase\.co/.test(code) ? "Supabase detected. Test RLS by querying each table with the anon key and confirming it only returns permitted rows." : "RLS needs database access. Test each table with a non-owner session where RLS applies.");
  const adminProbe = probe.admin;
  c[23] = !adminProbe ? skip("The /admin probe could not be fetched.") : spa ? skip("Site returns 200 for unknown routes, so /admin cannot be judged from outside. Confirm the server guards admin routes.") : adminProbe.status === 200 && !/type\s*=\s*["']password/i.test(adminProbe.body) ? fail("/admin returns 200 without a login form.", "Require authentication on the server for every admin route and API.") : pass(`/admin returns ${adminProbe.status}, so it is not openly served.`);
  const rateHeaders = Object.keys(page.headers).filter((h) => /ratelimit|retry-after/i.test(h));
  c[24] = rateHeaders.length ? pass(`Rate-limit headers observed (${rateHeaders.join(", ")}).`) : skip("No rate-limit headers observed. Confirm login, signup and API routes are throttled.");
  const cookies = ([] as string[]).concat(page.headers["set-cookie"] ?? []);
  const badCookies = cookies.filter((ck) => (secure && !/;\s*secure/i.test(ck)) || !/;\s*httponly/i.test(ck) || !/;\s*samesite/i.test(ck)).map((ck) => ck.split("=")[0]);
  const missingHeaders = [!header(page, "content-security-policy") && "Content-Security-Policy", secure && !header(page, "strict-transport-security") && "Strict-Transport-Security", !header(page, "x-content-type-options") && "X-Content-Type-Options", !header(page, "x-frame-options") && !/frame-ancestors/i.test(header(page, "content-security-policy") ?? "") && "clickjacking protection"].filter(Boolean) as string[];
  const oldJquery = code.match(/jquery[-.\/ v]*([12]\.\d+\.\d+|3\.[0-4]\.\d+)/i)?.[1];
  c[25] = badCookies.length || missingHeaders.length || oldJquery ? fail([badCookies.length && `cookies missing Secure/HttpOnly/SameSite: ${list(badCookies)}`, missingHeaders.length && `missing headers: ${list(missingHeaders)}`, oldJquery && `jQuery ${oldJquery} has known vulnerabilities`].filter(Boolean).join("; ") + ".", "Add the missing security headers at the host and set Secure, HttpOnly and SameSite on auth cookies. Run npm audit for dependencies.") : pass("Security headers present and cookies set safely. Run npm audit for dependency review.");
  const leaks = [/(?:^|[?&])(?:token|api_?key|password|secret|access_token)=[^&"'\s]{6,}/i.test(anchors.map((a) => a.href ?? "").join("\n")) && "secret-like query parameters in links", scripts.some((x) => /\/\/# sourceMappingURL=\S+\.map/.test(x.res?.body ?? "")) && "public source maps", /at \S+ \(.+:\d+:\d+\)|Traceback \(most recent|SQLSTATE|ECONNREFUSED/.test(nf?.body ?? "") && "stack trace on the error page", /\d+\.\d+/.test(header(page, "server") ?? "") && `server version in header (${header(page, "server")})`].filter(Boolean) as string[];
  c[26] = leaks.length ? fail(`Exposed: ${leaks.join("; ")}.`, "Disable production source maps, hide stack traces, strip server version headers and keep secrets out of URLs.") : pass("No secret-like URL parameters, public source maps, stack traces or server versions found.");

  /* 4. Backend & database */
  manual(27, "Production database and migrations need database access. Run migrations against production and compare schema.");
  manual(28, "Constraints, indexes and relationships need database access. Review the schema and EXPLAIN key queries.");
  manual(29, "Query edge cases need authenticated API tests with missing, invalid and unauthorized IDs.");
  manual(30, "Duplicate submissions need a form test. Double-click submit and confirm one record.");
  manual(31, "Concurrency needs a load test against shared records.");
  const fileInputs = tags(html, "input").filter((t) => /type\s*=\s*["']?file/i.test(t));
  c[32] = !fileInputs.length ? skip("No file upload control found on this page.") : fileInputs.some((t) => !hasAttr(t, "accept")) ? fail("File input has no accept attribute.", "Restrict file types client-side and enforce size, type and access rules on the server.") : skip("File input restricts types client-side. Server size, type and access limits need an upload test.");
  manual(33, "Backups and recovery need provider access. Confirm automated backups and test a restore.");
  manual(34, "Third-party failures need fault injection. Block each provider and confirm the UI recovers.");

  /* 5. Performance */
  const perf = lh?.categories.performance?.score;
  c[35] = perf == null ? skip("Set PAGESPEED_API_KEY to run a Lighthouse audit automatically, or run Lighthouse in Chrome.") : perf >= 0.8 ? pass(`Lighthouse mobile performance score ${Math.round(perf * 100)}/100.`) : fail(`Lighthouse mobile performance score ${Math.round(perf * 100)}/100.`, "Work through the Lighthouse opportunities: compress images, defer JavaScript and cut render-blocking requests.");
  const bigImages = images.filter((i) => i.res && sizeOf(i.res) > 300_000);
  c[36] = !images.length ? skip("No same-origin <img> files found to measure.") : bigImages.length ? fail(`${plural(bigImages.length, "image")} over 300 KB: ${list(bigImages.map((i) => `${new URL(i.url).pathname.split("/").pop()} (${kb(sizeOf(i.res))})`))}.`, "Resize images to their display size and serve WebP or AVIF through next/image or a CDN.") : pass(`${plural(images.length, "image")} measured, all under 300 KB.`);
  const jsBytes = scripts.reduce((sum, s) => sum + sizeOf(s.res), 0);
  c[37] = !scripts.length ? skip("No same-origin scripts found.") : jsBytes > 500_000 ? fail(`${kb(jsBytes)} of JavaScript transferred on first load.`, "Split bundles, lazy-load heavy libraries and remove unused dependencies.") : pass(`${kb(jsBytes)} of JavaScript across ${plural(scripts.length, "script")}.`);
  manual(38, "Slow queries and N+1 requests need database query logs or APM data.");
  const lazy = imgTags.filter((t) => /loading\s*=\s*["']lazy/i.test(t)).length;
  c[39] = !imgTags.length ? skip("No <img> tags found.") : imgTags.length <= 2 || lazy ? pass(`${lazy} of ${imgTags.length} images use native lazy loading.`) : fail(`None of ${imgTags.length} images use loading="lazy".`, 'Add loading="lazy" to below-the-fold images.');
  const noDims = imgTags.filter((t) => !(hasAttr(t, "width") && hasAttr(t, "height")) && !/aspect-ratio|style\s*=/.test(t));
  const cls = lh?.audits["cumulative-layout-shift"]?.score;
  c[40] = cls != null ? (cls >= 0.9 ? pass("Lighthouse reports a good Cumulative Layout Shift.") : fail("Lighthouse reports layout shift above the good threshold.", "Reserve space for images, embeds and late-loading fonts.")) : !imgTags.length ? skip("No images to check for reserved space.") : noDims.length > imgTags.length / 2 ? fail(`${noDims.length} of ${imgTags.length} images have no width and height.`, "Set width and height (or aspect-ratio) on every image to prevent layout shift.") : pass("Most images reserve space with width and height.");
  const weight = sizeOf(page) + jsBytes + styles.reduce((s, x) => s + sizeOf(x.res), 0) + images.reduce((s, x) => s + sizeOf(x.res), 0);
  c[41] = perf != null ? (perf >= 0.5 ? pass(`Lighthouse mobile run (throttled network and CPU) scored ${Math.round(perf * 100)}/100.`) : fail(`Lighthouse mobile run (throttled network and CPU) scored ${Math.round(perf * 100)}/100.`, "Reduce first-load weight and main-thread work for mid-range phones.")) : weight > 3_000_000 ? fail(`${kb(weight)} of HTML, JS, CSS and images on first load.`, "Cut first-load weight below 2 MB for mobile networks.") : skip(`First-load weight is ${kb(weight)}. A throttled mobile run needs Lighthouse or a real device.`);
  const staticNoCache = [...scripts, ...styles].filter((a) => a.res && !/max-age=\d{4,}|immutable/i.test(header(a.res, "cache-control") ?? ""));
  const compressed = /gzip|br|deflate/.test(header(page, "content-encoding") ?? "");
  const slow = page.ms > 1500;
  c[42] = !compressed || staticNoCache.length || slow ? fail([!compressed && "HTML is not compressed", staticNoCache.length && `${plural(staticNoCache.length, "static file")} without long-lived Cache-Control`, slow && `slow response (${page.ms} ms)`].filter(Boolean).join("; ") + ".", "Enable gzip/brotli, add Cache-Control: public, max-age=31536000, immutable to hashed assets and speed up the server response.") : pass(`HTML compressed, static assets cached, response in ${page.ms} ms.`);

  /* 6. SEO & social sharing */
  const title = strip(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  const description = meta(html, "description");
  const pageTitles = pages.flatMap((p) => p.res ? [strip(p.res.body.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "")] : []);
  const dupTitle = pageTitles.length > 0 && pageTitles.some((t) => t === title);
  c[43] = !title || !description || dupTitle ? fail([!title && "no <title>", !description && "no meta description", dupTitle && "title repeated on other pages"].filter(Boolean).join("; ") + ".", "Give every page a unique title (under 60 characters) and a meta description (under 160).") : pass(`Title and meta description present and unique across ${plural(pageTitles.length + 1, "page")}.`);
  const canonical = tags(html, "link").find((t) => /rel\s*=\s*["']canonical/i.test(t));
  const canonicalHref = canonical && attr(canonical, "href");
  c[44] = !canonicalHref ? fail("No canonical link.", 'Add <link rel="canonical"> with the absolute production URL.') : resolve(canonicalHref)?.host !== base.host ? fail(`Canonical points to ${canonicalHref}, a different host.`, "Point the canonical URL at this site's production domain.") : pass(`Canonical URL set to ${canonicalHref}.`);
  const robots = probe.robots, sitemap = probe.sitemap;
  const robotsOk = robots?.status === 200 && /user-agent/i.test(robots.body);
  const sitemapOk = (sitemap?.status === 200 && /<urlset|<sitemapindex/i.test(sitemap.body)) || /^sitemap:/im.test(robots?.body ?? "");
  c[45] = robotsOk && sitemapOk ? pass("robots.txt and a sitemap are present.") : fail(`${[!robotsOk && "robots.txt missing or invalid", !sitemapOk && "sitemap.xml missing or invalid"].filter(Boolean).join("; ")}.`, "Add /robots.txt (with a Sitemap: line) and /sitemap.xml.");
  const og = ["og:title", "og:description", "og:image"].filter((k) => !meta(html, k));
  const twitter = meta(html, "twitter:card");
  const ogImageOk = !ogImage.length || (ogRes[0] && ogRes[0].status < 400);
  c[46] = og.length || !twitter || !ogImageOk ? fail([og.length && `missing ${og.join(", ")}`, !twitter && "missing twitter:card", !ogImageOk && "og:image does not load"].filter(Boolean).join("; ") + ".", "Add Open Graph and Twitter card tags with a 1200x630 preview image that loads.") : pass("Open Graph and Twitter card tags are present and the preview image loads.");
  const noindex = /noindex/i.test(`${meta(html, "robots") ?? ""} ${header(page, "x-robots-tag") ?? ""}`);
  c[47] = noindex ? fail("Page is marked noindex.", "Remove noindex before launch so search engines can index the site.") : text.length < 150 ? fail(`Only ${text.length} characters of text in the server HTML. Content may render only in JavaScript.`, "Server-render or pre-render the main content so crawlers see it.") : pass(`${text.length} characters of readable text in the server HTML and indexing is allowed.`);
  const ld = [...html.matchAll(/<script\b[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  const ldBad = ld.filter((j) => { try { JSON.parse(j); return false; } catch { return true; } });
  c[48] = !ld.length ? skip("No structured data found. Add JSON-LD where it applies (organization, product, article).") : ldBad.length ? fail(`${plural(ldBad.length, "JSON-LD block")} is not valid JSON.`, "Fix the JSON-LD syntax and validate it with the Rich Results Test.") : pass(`${plural(ld.length, "JSON-LD block")} parsed as valid JSON.`);
  const finalHttps = secure && (!httpVariant || (httpVariant.status >= 300 && httpVariant.status < 400 && /^https:/i.test(header(httpVariant, "location") ?? "")));
  c[49] = !secure ? fail("Final URL uses http.", "Serve the site over HTTPS and redirect all http requests to https.") : !finalHttps ? fail(`http://${base.hostname}/ does not redirect to https (status ${httpVariant?.status}).`, "Redirect all http traffic to https at the host or CDN.") : pass(`HTTPS works with a valid certificate${page.chain.length ? `, reached after ${plural(page.chain.length, "redirect")}` : ""}, and http redirects to https.`);
  const faviconOk = iconRes.some((r) => r && r.status === 200) || (probe.favicon?.status === 200 && /image|octet/i.test(header(probe.favicon, "content-type") ?? ""));
  c[50] = faviconOk && title ? pass("Favicon loads and the page has a title.") : fail(`${!faviconOk ? "No favicon found." : "Page has no title."}`, "Add a favicon (link rel=icon or /favicon.ico) and a site title.");

  /* 7. Accessibility */
  const posTabindex = tags(html, "[a-z0-9]+").filter((t) => Number(attr(t, "tabindex")) > 0);
  c[51] = posTabindex.length ? fail(`${plural(posTabindex.length, "element")} with a positive tabindex break natural tab order.`, "Remove positive tabindex values and keep DOM order logical.") : skip("No tab-order problems in the markup. Full keyboard walkthrough needs a browser.");
  const outlineOff = /outline\s*:\s*(?:none|0)\b/.test(css);
  const focusRules = /:focus(?:-visible|-within)?/.test(css);
  c[52] = !css ? skip("No stylesheet found to inspect.") : outlineOff && !focusRules ? fail("CSS removes outlines and defines no :focus styles.", "Add a visible :focus-visible style to links, buttons and inputs.") : focusRules ? pass("Focus styles are defined in CSS.") : skip("No focus rules or outline resets found in CSS. Tab through the page to confirm focus is visible.");
  const fields = tags(html, "input|textarea|select").filter((t) => !/type\s*=\s*["']?(?:hidden|submit|button|image|reset)/i.test(t));
  const forIds = new Set([...html.matchAll(/<label\b[^>]*\sfor\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]));
  const wrapped = (html.match(/<label\b[^>]*>[\s\S]*?<\/label>/gi) ?? []).reduce((n, l) => n + tags(l, "input|textarea|select").length, 0);
  const unlabeled = Math.max(0, fields.filter((t) => !hasAttr(t, "aria-label") && !hasAttr(t, "aria-labelledby") && !hasAttr(t, "title") && !(attr(t, "id") && forIds.has(attr(t, "id")!))).length - wrapped);
  c[53] = !fields.length ? skip("No form fields found on this page.") : unlabeled ? fail(`${plural(unlabeled, "form field")} without a label.`, "Give every input a visible <label for> or an aria-label. Placeholders are not labels.") : pass(`All ${plural(fields.length, "form field")} have labels.`);
  const noAlt = imgTags.filter((t) => !hasAttr(t, "alt")), fileAlt = imgTags.filter((t) => /\.(?:png|jpe?g|gif|webp)$/i.test(attr(t, "alt") ?? ""));
  c[54] = !imgTags.length ? skip("No <img> tags found.") : noAlt.length || fileAlt.length ? fail(`${noAlt.length ? `${plural(noAlt.length, "image")} without alt` : ""}${noAlt.length && fileAlt.length ? "; " : ""}${fileAlt.length ? `${plural(fileAlt.length, "image")} with a filename as alt` : ""}.`, 'Describe each informative image in alt text and use alt="" for decorative ones.') : pass(`All ${plural(imgTags.length, "image")} have alt attributes. Whether the text is meaningful needs human review.`);
  const contrast = lh?.audits["color-contrast"]?.score;
  c[55] = contrast == null ? skip("Color contrast needs a rendered page. Set PAGESPEED_API_KEY or run Lighthouse in Chrome.") : contrast === 1 ? pass("Lighthouse found no color-contrast failures.") : fail("Lighthouse found text that fails WCAG contrast.", "Raise contrast to at least 4.5:1 for body text and 3:1 for large text.");
  const levels = [...html.matchAll(/<h([1-6])\b/gi)].map((m) => Number(m[1]));
  const h1s = levels.filter((l) => l === 1).length, jump = levels.some((l, i) => i > 0 && l - levels[i - 1] > 1);
  c[56] = !levels.length ? fail("No headings found.", "Structure the page with one h1 and nested h2/h3 headings.") : h1s !== 1 || jump ? fail(`${h1s === 0 ? "No h1" : h1s > 1 ? `${h1s} h1 elements` : ""}${h1s !== 1 && jump ? "; " : ""}${jump ? "heading levels skip" : ""}.`, "Use exactly one h1 and never skip a heading level.") : pass(`One h1 and a consistent hierarchy across ${plural(levels.length, "heading")}.`);
  const emptyButtons = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)].filter((m) => !strip(m[2]) && !attr(`<button${m[1]}>`, "aria-label") && !attr(`<button${m[1]}>`, "title") && !/<img[^>]+alt\s*=\s*["'][^"']+/i.test(m[2]));
  const emptyAnchors = anchors.filter((a) => !a.label && !/<img[^>]+alt\s*=\s*["'][^"']+/i.test(a.inner));
  const noLang = !/<html\b[^>]*\blang\s*=/i.test(html);
  c[57] = emptyButtons.length || emptyAnchors.length || noLang ? fail([emptyButtons.length && `${plural(emptyButtons.length, "button")} with no accessible name`, emptyAnchors.length && `${plural(emptyAnchors.length, "link")} with no accessible name`, noLang && "<html lang> missing"].filter(Boolean).join("; ") + ".", "Add aria-label to icon-only buttons and links, and declare the page language on <html>.") : pass("Buttons and links have accessible names and the page language is declared. A screen-reader pass still needs a human.");
  const animated = /@keyframes|animation\s*:|transition\s*:/.test(css);
  c[58] = !animated ? pass("No CSS animations or transitions found.") : /prefers-reduced-motion/.test(css) ? pass("prefers-reduced-motion rules are present.") : fail("CSS animates but never checks prefers-reduced-motion.", "Wrap animation in @media (prefers-reduced-motion: no-preference) or disable it under reduce.");

  /* 8. Testing & code quality */
  manual(59, "Build, type and lint results need the repo. Run npm run build, tsc --noEmit and npm run lint in CI.");
  manual(60, "Unit test coverage needs the repo. Run the test suite with coverage.");
  manual(61, "Integration tests need the repo and a test database.");
  manual(62, "End-to-end coverage needs the repo. Cover signup, login and the main user journey.");
  manual(63, "Invalid input and unauthorized access need authenticated tests against the API.");
  const deadAll = [...brokenPages.map((p) => new URL(p.url).pathname), ...brokenAssets.map((a) => new URL(a.url).pathname)];
  c[64] = deadAll.length ? fail(`${plural(deadAll.length, "dead route or missing asset")}: ${list(deadAll)}.`, "Fix or remove every link and asset reference that returns 404 or an error.") : pass(`${plural(pages.length + assets.length, "route and asset")} checked, none missing.`);
  const scaffold = /^(?:vite \+ react|create next app|react app|vite app|next\.js app|untitled|document|my app|home)$/i.test(title) || /generated by create next app|web site created using create-react-app/i.test(description ?? "") || /lovable|bolt\.new|v0\.dev/i.test(meta(html, "generator") ?? "");
  c[65] = scaffold ? fail(`Default scaffold metadata still present (title "${title}").`, "Replace template titles and descriptions and review generated code for assumptions.") : skip("AI-generated code needs human review. No scaffold defaults found in the page metadata.");
  const errorText = /application error: a (?:client|server)-side exception|unhandled runtime error|internal server error|hydration failed|something went wrong/i.exec(text)?.[0];
  const consoleScore = lh?.audits["errors-in-console"]?.score;
  c[66] = errorText ? fail(`Page shows an error message ("${errorText}").`, "Open the browser console and network tab, fix the failing request or exception, then redeploy.") : consoleScore === 0 ? fail("Lighthouse logged console errors on load.", "Open the browser console and fix every error on first load.") : consoleScore === 1 ? pass("Lighthouse logged no console errors on load.") : skip("Console errors need a browser. Open dev tools on first load and check the network tab. No error text in the HTML.");

  /* 9. Deployment & infrastructure */
  const devServer = /@vite\/client|\/_next\/webpack-hmr|react-refresh|webpack-dev-server|sockjs-node|__vite_ping/.test(code);
  c[67] = page.status >= 500 ? fail(`Deployed URL returns ${page.status}.`, "Check the build and runtime logs on your host, fix the error and redeploy.") : devServer ? fail("Development server code (HMR or Vite client) is being served.", "Deploy the output of a production build, not a dev server.") : pass(`Deployed site responds ${page.status} with production assets. A clean-environment build needs CI.`);
  const unset = code.match(/(?:href|src)=["'](?:undefined|null|\[object Object\])["']|["'](?:YOUR_[A-Z_]+|undefined\/api)["']/);
  c[68] = unset ? fail(`Unset environment placeholder found (${unset[0]}).`, "Set every NEXT_PUBLIC_/VITE_ variable in the production environment and rebuild.") : skip("Production env values cannot be read from outside. No unset placeholders found in the output.");
  const mixed = secure ? tags(html, "script|link|img|iframe|form|source|video|audio|embed").filter((t) => /\s(?:src|href|action)\s*=\s*["']http:\/\//i.test(t)) : [];
  c[69] = !secure ? fail("Site is not served over HTTPS.", "Enable HTTPS and redirect http to https.") : mixed.length ? fail(`${plural(mixed.length, "resource")} loaded over http (mixed content).`, "Load every script, image and stylesheet over https.") : finalHttps ? pass("DNS resolves, HTTPS works, http redirects to https and no mixed content found.") : fail("http does not redirect to https.", "Redirect http to https at the host or CDN.");
  const localhost = code.match(/["'`]https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d{2,5}[^"'`]*/)?.[0];
  c[70] = localhost ? fail(`Local URL in production output: ${localhost.slice(1, 60)}.`, "Point API and callback URLs at the production domain through env vars, then rebuild.") : skip("Callback URLs in provider dashboards cannot be read from outside. No localhost URLs found in the output.");
  const acao = header(cors, "access-control-allow-origin"), acac = header(cors, "access-control-allow-credentials");
  c[71] = acao && (acao === "https://vibeproof-cors-test.invalid" || (acao === "*" && /true/i.test(acac ?? ""))) ? fail(`Server reflects arbitrary origins in Access-Control-Allow-Origin${/true/i.test(acac ?? "") ? " with credentials" : ""}.`, "Allow only an explicit list of trusted origins, never reflect the Origin header.") : pass(`CORS does not reflect arbitrary origins${acao ? ` (Access-Control-Allow-Origin: ${acao})` : ""}. OAuth redirect URIs and email settings need provider dashboards.`);
  const exposed = sensitive.slice(3).filter(([p, re]) => probe[p]?.status === 200 && re.test(probe[p]!.body)).map(([p]) => p);
  const listing = Object.values(probe).some((r) => r?.status === 200 && /<title>index of \//i.test(r.body));
  c[72] = exposed.length || listing ? fail(`Sensitive files or listings are public: ${list([...exposed, ...(listing ? ["directory listing"] : [])])}.`, "Block these paths at the host and remove them from the deploy output.") : pass("/.git, /package.json, /.DS_Store and directory listings are not exposed.");
  const healthy = ["h1", "h2", "h3", "h4"].some((k) => probe[k]?.status === 200 && !/text\/html/i.test(header(probe[k], "content-type") ?? ""));
  const monitoring = code.match(/sentry|datadog|bugsnag|rollbar|logrocket|newrelic|raygun|honeybadger|highlight\.io/i)?.[0];
  c[73] = healthy || monitoring ? pass(`${healthy ? "Health endpoint responds" : ""}${healthy && monitoring ? " and " : ""}${monitoring ? `${monitoring} monitoring detected` : ""}.`) : skip("No health endpoint or browser monitoring SDK observed. Server logs and alerts need host access.");
  const host = header(page, "x-vercel-id") ? "Vercel" : header(page, "x-nf-request-id") ? "Netlify" : header(page, "cf-ray") ? "Cloudflare" : header(page, "fly-request-id") ? "Fly.io" : header(page, "x-amz-cf-id") ? "CloudFront" : undefined;
  c[74] = skip(`${host ? `Hosted on ${host}. ` : "Host not identified. "}Confirm in your dashboard that the previous deployment can be restored in one step.`);

  /* 10. Legal, analytics & launch readiness */
  const legalLinks = anchors.filter((a) => /privacy|terms|legal/i.test(`${a.label} ${a.href}`));
  c[75] = legalLinks.length ? pass(`Policy links found: ${list(legalLinks.map((a) => a.label || a.href || ""), 3)}.`) : fail("No privacy policy or terms link found on the page.", "Link a privacy policy and terms of service from the footer.");
  const trackers = code.match(/googletagmanager|google-analytics|gtag\(|fbevents|connect\.facebook\.net|hotjar|clarity\.ms|mixpanel|segment\.(?:com|io)|posthog|amplitude|fullstory|heap-?analytics|doubleclick/i)?.[0];
  const consent = /cookiebot|onetrust|osano|termly|iubenda|cookieyes|cookie-?consent|cookie-?banner|cc-window|didomi|usercentrics|klaro/i.test(code) || /cookies?[^.]{0,60}(?:accept|consent|agree)/i.test(text);
  c[76] = trackers && !consent ? fail(`Tracking detected (${trackers}) with no cookie consent mechanism.`, "Add a consent banner and load analytics only after opt-in where the law requires it.") : trackers ? pass(`Tracking detected (${trackers}) alongside a consent mechanism.`) : pass("No cookie-setting analytics or ad trackers detected.");
  c[77] = trackers && !consent ? fail(`${trackers} loads without a consent gate.`, "Gate analytics scripts behind consent or switch to a cookieless analytics tool.") : trackers ? skip(`${trackers} detected with consent UI. Confirm it only loads after opt-in.`) : pass("No consent-dependent analytics detected.");
  const contactPages = pages.filter((p) => p.res && p.res.status < 400 && /contact|support|help/i.test(p.url));
  const mailto = anchors.find((a) => /^mailto:[^@\s]+@[^@\s]+\.[^@\s]+/i.test(a.href ?? ""));
  c[78] = mailto || contactPages.length || anchors.some((a) => /^tel:/i.test(a.href ?? "")) ? pass(`Contact route found (${mailto ? mailto.href : contactPages[0]?.url ?? "tel link"}).`) : fail("No contact link, mailto or support page found.", "Add a visible contact email, form or support page.");
  manual(79, "Email delivery needs a real send. Trigger signup and reset emails and check inbox placement, SPF and DKIM.");
  const payments = code.match(/stripe|paddle|lemonsqueezy|razorpay|paypal|gumroad/i)?.[0];
  c[80] = skip(payments ? `${payments} detected. Test success, failure and webhook flows with test cards.` : "No payment integration detected. Likely not applicable.");
  const testData = (text + " " + (html.match(/value=["'][^"']*["']/gi) ?? []).join(" ")).match(/test@\S+|@example\.(?:com|org)|password123|\btest (?:user|account)\b|\bdemo (?:user|account)\b|john doe|jane doe|foo@bar|admin@admin/i)?.[0];
  c[81] = testData ? fail(`Test or sample data visible on the page ("${testData}").`, "Remove test accounts, sample records and fake contact details from production.") : pass("No test accounts or sample data found in the page.");
  const smokeBad = page.status >= 400 || brokenPages.length || errorText;
  c[82] = smokeBad ? fail(`Smoke test failed: ${[page.status >= 400 && `homepage returned ${page.status}`, brokenPages.length && `${plural(brokenPages.length, "linked page")} broken`, errorText && "error text on page"].filter(Boolean).join(", ")}.`, "Fix the failing page, redeploy and rerun the smoke test.") : pass(`Homepage returned ${page.status} in ${page.ms} ms and ${plural(okPages.length, "linked page")} loaded.`);

  // browser verdicts replace skips and passes; a static failure stays so its evidence is not lost
  for (const [id, v] of Object.entries(await visual)) if (c[Number(id)]?.status !== "failed") c[Number(id)] = v;
  return { verdicts: c, url: base.toString(), statusCode: page.status };
}

export async function scanUrl(value: string) {
  const r = await checkUrl(value);
  return report(r.url, r.verdicts, r.statusCode);
}

export function report(url: string, c: Record<number, Verdict>, statusCode?: number) {
  const checklist = createChecklist(Object.fromEntries(Object.entries(c).map(([id, v]) => [Number(id), { status: v.status, reason: v.reason }])));
  const high = new Set([17, 18, 23, 25, 26, 49, 67, 69, 71, 72, 81]);
  const low = new Set([14, 44, 46, 48, 50, 58, 65]);
  const findings: ScanFinding[] = checklist.filter((k) => k.status === "failed").map((k) => ({ title: k.title.replace(/\.$/, ""), area: k.section, severity: high.has(k.id) ? "High" : low.has(k.id) ? "Low" : "Medium", copy: c[k.id].fix ?? k.reason ?? "", evidence: k.reason ?? "" }));
  findings.sort((a, b) => ["High", "Medium", "Low"].indexOf(a.severity) - ["High", "Medium", "Low"].indexOf(b.severity));
  const score = Math.max(0, Math.round(100 - findings.reduce((sum, f) => sum + (f.severity === "High" ? 6 : f.severity === "Medium" ? 3 : 1.5), 0)));
  return { url, score, findings, checklist, statusCode, checkedAt: new Date().toISOString() };
}
