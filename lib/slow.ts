import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { launch } from "./browser";
import { validTarget, type Verdict } from "./scanner";

/* Slow-network mode. Chromium talks ONLY to a proxy run by this process; the proxy adds latency to every request and,
   when armed, replays a state-changing request a moment later (the double click / retry an impatient user on a slow
   connection produces). It is a reverse proxy pinned to one validated origin, so it cannot be pointed elsewhere. */

export const DELAY_MS = 900;
const DUPE_GAP_MS = 120;
const BUDGET_MS = 35_000;
const REJECTED = /already|exists|taken|duplicate|registered|in use|unique|conflict/i;

type Exchange = { method: string; path: string; copy: 1 | 2; status: number; body: string; at: number };
const pass = (reason: string): Verdict => ({ status: "passed", reason });
const skip = (reason: string): Verdict => ({ status: "not_testable", reason });

export async function startSlowProxy(origin: string, delayMs = DELAY_MS) {
  const { target, address } = await validTarget(origin);
  const log: Exchange[] = [];
  let routed = 0, armed = false, proxyOrigin = "";
  const textual = /text\/|json|javascript|xml/i;
  const back = (s: string) => s.split(proxyOrigin).join(target.origin);
  const fwd = (s: string) => s.split(target.origin).join(proxyOrigin);

  const upstream = (req: http.IncomingMessage, body: Buffer) => new Promise<{ status: number; headers: http.IncomingHttpHeaders; buf: Buffer }>((resolve, reject) => {
    const headers = { ...req.headers, host: target.host, "accept-encoding": "identity", "content-length": String(body.length) } as unknown as Record<string, string>;
    delete headers.connection;
    if (headers.origin) headers.origin = back(headers.origin);
    if (headers.referer) headers.referer = back(headers.referer);
    const r = (target.protocol === "https:" ? https : http).request({ hostname: address, port: target.port || undefined, path: req.url, method: req.method, headers, servername: target.hostname, timeout: 15_000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c)).on("end", () => resolve({ status: res.statusCode ?? 502, headers: res.headers, buf: Buffer.concat(chunks) })).on("error", reject);
    });
    r.on("timeout", () => r.destroy(new Error("upstream timed out"))).on("error", reject).end(body);
  });

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c)).on("end", async () => {
      routed++;
      const body = Buffer.concat(chunks);
      const mutating = !["GET", "HEAD", "OPTIONS"].includes(req.method ?? "GET");
      const dupe = armed && mutating;
      if (dupe) armed = false; // one duplicated submit per arming
      await new Promise((r) => setTimeout(r, delayMs));
      try {
        const copies = dupe ? [upstream(req, body), new Promise((r) => setTimeout(r, DUPE_GAP_MS)).then(() => upstream(req, body))] : [upstream(req, body)];
        const results = await Promise.all(copies.map((p) => p.catch(() => undefined)));
        results.forEach((r, i) => mutating && r && log.push({ method: req.method!, path: req.url!, copy: (i + 1) as 1 | 2, status: r.status, body: r.buf.toString("utf8", 0, 2000), at: Date.now() }));
        const first = results[0] ?? results[1];
        if (!first) { res.writeHead(502).end("upstream failed"); return; }
        const headers = { ...first.headers };
        let out = first.buf;
        if (textual.test(String(headers["content-type"] ?? ""))) out = Buffer.from(fwd(out.toString("utf8")));
        if (typeof headers.location === "string") headers.location = fwd(headers.location);
        if (headers["set-cookie"]) headers["set-cookie"] = headers["set-cookie"].map((c) => c.replace(/;\s*domain=[^;]*/i, "").replace(/;\s*secure/i, ""));
        delete headers["content-encoding"]; delete headers["transfer-encoding"]; delete headers["content-security-policy"];
        headers["content-length"] = String(out.length);
        res.writeHead(first.status, headers).end(out);
      } catch { if (!res.headersSent) res.writeHead(502); res.end(); }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  proxyOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin: proxyOrigin, log, delayMs, routed: () => routed, arm: () => { armed = true; }, close: () => { server.closeAllConnections(); server.close(); } };
}

const SIGNUP_LINK = /sign ?up|register|create (?:an )?account|join|get started|start free/i;

/** Finds a form that creates an account: a password field plus an email or name field, not a login form. */
const findForm = `(() => {
  const forms = [...document.forms].filter((f) => f.querySelector('input[type=password]') && f.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select').length >= 2);
  const score = (f) => (f.querySelectorAll('input[type=password]').length > 1 ? 2 : 0) + (/sign ?up|regist|create|join/i.test(f.textContent + f.action + f.id + f.className) ? 2 : 0) - (/log ?in|sign ?in/i.test(f.textContent + f.action + f.id) && !/sign ?up|regist|create/i.test(f.textContent + f.action + f.id) ? 3 : 0);
  const f = forms.sort((a, b) => score(b) - score(a))[0];
  if (!f || score(f) < 0) return null;
  f.setAttribute('data-vp-form', '1'); return true;
})()`;

export async function slowChecks(url: string): Promise<Record<number, Verdict>> {
  let browser: Awaited<ReturnType<typeof launch>> | undefined, proxy: Awaited<ReturnType<typeof startSlowProxy>> | undefined;
  const timer = new Promise<Record<number, Verdict>>((resolve) => setTimeout(() => resolve({ 30: skip("Slow-network signup test ran out of time.") }), BUDGET_MS).unref?.());
  const run = async (): Promise<Record<number, Verdict>> => {
    const start = new URL(url);
    proxy = await startSlowProxy(start.origin);
    browser = await launch();
    const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false, userAgent: "VibeProof/1.0 verification bot (slow network)" });
    const proxied = new URL(proxy.origin).host;
    await context.route("**/*", (route) => (new URL(route.request().url()).host === proxied ? route.continue() : route.abort())); // nothing reaches the network except through the proxy
    const page = await context.newPage();
    const go = (u: string) => page.goto(proxy!.origin + new URL(u).pathname + new URL(u).search, { waitUntil: "load", timeout: 20_000 });
    await go(url);
    let found = await page.evaluate(findForm);
    if (!found) {
      const href = await page.evaluate((src) => { const re = new RegExp(src, "i"); return [...document.querySelectorAll("a[href]")].find((a) => re.test(a.textContent ?? "") || re.test(a.getAttribute("href") ?? ""))?.getAttribute("href") ?? null; }, SIGNUP_LINK.source);
      if (href) { await go(new URL(href, page.url()).toString().replace(proxy.origin, start.origin)).catch(() => undefined); found = await page.evaluate(findForm); }
    }
    if (!found) return { 30: skip("Slow-network mode found no signup form (a form with a password field) to submit twice.") };

    const rand = Math.random().toString(36).slice(2, 10);
    const email = `vibeproof+${rand}@example.com`;
    const form = page.locator("[data-vp-form]");
    for (const input of await form.locator("input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=file]), textarea").all()) {
      const type = (await input.getAttribute("type")) ?? "text", name = `${await input.getAttribute("name")} ${await input.getAttribute("id")} ${await input.getAttribute("placeholder")}`;
      try {
        if (type === "checkbox" || type === "radio") await input.check({ timeout: 1500 });
        else if (type === "password") await input.fill(`Vp!${rand}Aa1`, { timeout: 1500 });
        else if (type === "email" || /e-?mail/i.test(name)) await input.fill(email, { timeout: 1500 });
        else if (type === "tel") await input.fill("5555550100", { timeout: 1500 });
        else if (type === "number") await input.fill("30", { timeout: 1500 });
        else await input.fill(/user/i.test(name) ? `vp_${rand}` : "VibeProof Test", { timeout: 1500 });
      } catch { /* optional or hidden field */ }
    }
    proxy.log.length = 0;
    proxy.arm();
    const submit = form.locator("[type=submit], button:not([type=button])").first();
    if (await submit.count()) await submit.click({ timeout: 3000 }); else await form.locator("input").first().press("Enter");
    for (let i = 0; i < 40 && proxy.log.filter((e) => e.copy === 2).length === 0; i++) await page.waitForTimeout(250);
    await page.waitForTimeout(600);

    const first = proxy.log.find((e) => e.copy === 1), second = proxy.log.find((e) => e.copy === 2 && e.path === first?.path);
    const net = `${proxy.routed()} browser requests were routed through the slow-network proxy (+${proxy.delayMs} ms each)`;
    if (!first || !second) return { 30: skip(`${net}, but the signup submit sent no duplicable POST/PUT request.`) };
    const ok = (e: Exchange) => e.status < 400;
    if (!ok(first)) return { 30: skip(`${net}, but the site rejected the test signup (${first.status}), so duplicate handling could not be observed.`) };
    const where = `${first.method} ${first.path.split("?")[0]}`;
    if (ok(first) && ok(second) && !REJECTED.test(second.body)) return { 30: { status: "failed", reason: `${net}. Signup was submitted twice ${DUPE_GAP_MS} ms apart (a double click or retry on a slow connection) and both ${where} requests succeeded (${first.status} and ${second.status}) for ${email}, so two accounts were created. A normal-speed scan never sends the second request.`, fix: "Make signup idempotent: UNIQUE constraint on the normalized email, one atomic INSERT ... ON CONFLICT insert (no check-then-insert), return 409 for the second request, disable the submit button while pending and honour an Idempotency-Key." } };
    return { 30: pass(`${net}. Signup submitted twice ${DUPE_GAP_MS} ms apart; the second ${where} was rejected (${second.status}), so no duplicate account was created.`) };
  };
  try { return await Promise.race([run(), timer]); }
  catch (error) { return { 30: skip(`Slow-network signup test could not run (${error instanceof Error ? error.message.slice(0, 120) : "error"}).`) }; }
  finally { proxy?.close(); await browser?.close().catch(() => undefined); }
}
