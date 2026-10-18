import { chromium, type Page } from "playwright-core";
import { validTarget, type Verdict } from "@/lib/scanner";

/* Real-browser pass: renders the page in Chromium and judges what raw HTML cannot (layout, taps, focus, contrast, console).
   Returns verdicts keyed by checklist id. Any failure to launch or time out returns {} so the static scan still ships. */

const BUDGET_MS = 25_000;
const pass = (reason: string): Verdict => ({ status: "passed", reason });
const fail = (reason: string, fix: string): Verdict => ({ status: "failed", reason, fix });
const skip = (reason: string): Verdict => ({ status: "not_testable", reason });
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const list = (items: string[], max = 3) => items.slice(0, max).join(", ") + (items.length > max ? ` and ${items.length - max} more` : "");

async function launch() {
  if (process.env.VERCEL) {
    const sparticuz = (await import("@sparticuz/chromium")).default;
    return chromium.launch({ args: sparticuz.args, executablePath: await sparticuz.executablePath(), headless: true });
  }
  return chromium.launch();
}

/* Runs in the page. Selectors are visible, enabled, interactive elements. */
const INTERACTIVE = 'a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[tabindex]:not([tabindex="-1"])';

export async function browserChecks(url: string): Promise<Record<number, Verdict>> {
  let browser: Awaited<ReturnType<typeof launch>> | undefined;
  const timer = new Promise<Record<number, Verdict>>((resolve) => setTimeout(() => resolve({}), BUDGET_MS).unref?.());
  const run = async () => {
    browser = await launch();
    const out: Record<number, Verdict> = {};
    const origin = new URL(url).origin;
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: "block", acceptDownloads: false, userAgent: "VibeProof/1.0 verification bot (browser)" });
    // ponytail: DNS is checked per host before each request, not pinned; a rebinding host could slip past. Pin via a proxy if that matters.
    const hostOk = new Map<string, Promise<boolean>>();
    let mutating = 0;
    await context.route("**/*", async (route) => {
      const req = route.request();
      const u = new URL(req.url());
      if (!/^https?:$/.test(u.protocol)) return route.continue();
      if (req.method() !== "GET" && req.method() !== "HEAD" && req.method() !== "OPTIONS") { mutating++; return route.abort(); }
      if (!hostOk.has(u.hostname)) hostOk.set(u.hostname, validTarget(u.toString()).then(() => true, () => false));
      return (await hostOk.get(u.hostname)) ? route.continue() : route.abort();
    });
    await context.addInitScript("window.__name = (f) => f"); // bundlers (esbuild keepNames) inject __name into evaluate callbacks
    const page = await context.newPage();
    const consoleErrors: string[] = [], failedReqs: string[] = [];
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 120)); });
    page.on("pageerror", (e) => consoleErrors.push(e.message.slice(0, 120)));
    page.on("response", (r) => { if (r.status() >= 400 && r.url().startsWith(origin)) failedReqs.push(`${new URL(r.url()).pathname} (${r.status()})`); });
    await page.goto(url, { waitUntil: "load", timeout: 15_000 });
    await page.waitForTimeout(800);

    /* console + failed requests (66) */
    const issues = [...consoleErrors.map((e) => `console: ${e}`), ...failedReqs.map((r) => `request: ${r}`)];
    out[66] = issues.length ? fail(`${plural(issues.length, "error")} while the page loaded in a browser: ${list(issues, 2)}.`, "Open the browser console and network tab, fix the failing request or exception, then redeploy.") : pass("No console errors or failed same-origin requests while the page loaded.");

    /* broken images and fonts (13) */
    await page.evaluate(() => scrollTo(0, document.body.scrollHeight)); await page.waitForTimeout(400); await page.evaluate(() => scrollTo(0, 0));
    const brokenImgs = await page.evaluate(() => [...document.images].filter((i) => i.complete && i.naturalWidth === 0 && i.currentSrc).map((i) => i.currentSrc.slice(0, 80)));
    const badFonts = await page.evaluate(() => [...document.fonts].filter((f) => f.status === "error").map((f) => f.family));
    if (brokenImgs.length || badFonts.length) out[13] = fail(`${brokenImgs.length ? `${plural(brokenImgs.length, "image")} failed to render (${list(brokenImgs, 2)})` : ""}${brokenImgs.length && badFonts.length ? "; " : ""}${badFonts.length ? `font failed to load: ${list(badFonts)}` : ""}.`, "Fix the asset paths or restore the missing files in the production build.");

    /* overflow at three widths (9, 10) */
    const overflow: string[] = [];
    for (const [name, width, height] of [["mobile 360px", 360, 740], ["tablet 768px", 768, 1024], ["desktop 1280px", 1280, 800]] as const) {
      await page.setViewportSize({ width, height }); await page.waitForTimeout(250);
      const bad = await page.evaluate(() => {
        const w = innerWidth;
        if (document.documentElement.scrollWidth <= w + 1) return null;
        const off = [...document.body.querySelectorAll("*")].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.right > w + 1; }).slice(0, 2).map((el) => el.tagName.toLowerCase() + (el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/)[0] : ""));
        return off.join(", ") || "document";
      });
      if (bad) overflow.push(`${name} (${bad})`);
    }
    out[9] = overflow.length ? fail(`Layout breaks at ${list(overflow)}.`, "Use responsive widths and wrap or scroll wide content so nothing exceeds the viewport.") : pass("Rendered at 360, 768 and 1280px with no layout breakage.");
    out[10] = overflow.length ? fail(`Horizontal overflow at ${list(overflow)}.`, "Find the element wider than the viewport (images, tables, fixed widths) and constrain it with max-width: 100% or overflow handling.") : pass("No horizontal overflow at 360, 768 or 1280px.");

    /* tap targets and text size on a phone (11) */
    await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(250);
    const small = await page.evaluate((sel) => {
      const vis = (el: Element) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
      const tiny = [...document.querySelectorAll(sel)].filter(vis).filter((el) => !(el.tagName === "A" && getComputedStyle(el).display === "inline")).filter((el) => { // inline text links are exempt from the WCAG target-size rule
        const r = el.getBoundingClientRect(); return r.width < 24 || r.height < 24; }).length;
      const text = [...document.querySelectorAll("p,li,span,a,button,label,td")].filter((el) => vis(el) && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim())).filter((el) => parseFloat(getComputedStyle(el).fontSize) < 12).length;
      return { tiny, text };
    }, INTERACTIVE);
    out[11] = small.tiny || small.text ? fail(`${small.tiny ? `${plural(small.tiny, "tap target")} under 24x24px` : ""}${small.tiny && small.text ? "; " : ""}${small.text ? `${plural(small.text, "text element")} under 12px` : ""} on a 390px phone.`, "Make buttons and links at least 44x44px on touch screens and keep body text at 14px or larger.") : pass("Tap targets are 24px or larger and text is 12px or larger at 390px.");
    await page.setViewportSize({ width: 1280, height: 800 });

    /* dark mode (14) */
    const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor + getComputedStyle(document.documentElement).backgroundColor);
    const light = await bg(); await page.emulateMedia({ colorScheme: "dark" }); await page.waitForTimeout(250);
    if (light !== (await bg())) out[14] = pass("Page restyles itself when the system switches to dark mode.");
    await page.emulateMedia({ colorScheme: "light" });

    /* contrast (55) */
    const contrast = await page.evaluate(() => {
      const parse = (c: string) => { const m = c.match(/[\d.]+/g)?.map(Number); return m && m.length >= 3 ? { r: m[0], g: m[1], b: m[2], a: m[3] ?? 1 } : undefined; };
      const lum = ({ r, g, b }: { r: number; g: number; b: number }) => { const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      let checked = 0, low = 0; const samples: string[] = [];
      for (const el of document.body.querySelectorAll("*")) {
        if (checked >= 200) break;
        if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim())) continue;
        const s = getComputedStyle(el), r = el.getBoundingClientRect();
        if (!r.width || !r.height || s.visibility === "hidden" || s.display === "none" || +s.opacity < 1) continue;
        const fg = parse(s.color); if (!fg) continue;
        let bgc, node: Element | null = el, skipEl = false;
        while (node) { const ns = getComputedStyle(node); if (ns.backgroundImage !== "none") { skipEl = true; break; } const p = parse(ns.backgroundColor); if (p && p.a > 0.95) { bgc = p; break; } node = node.parentElement; }
        if (skipEl) continue;
        bgc ??= { r: 255, g: 255, b: 255, a: 1 };
        const a = lum(fg), b = lum(bgc), ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        const big = parseFloat(s.fontSize) >= 24 || (parseFloat(s.fontSize) >= 18.66 && +s.fontWeight >= 700);
        checked++;
        if (ratio < (big ? 3 : 4.5)) { low++; if (samples.length < 2) samples.push(`"${(el.textContent ?? "").trim().slice(0, 24)}" ${ratio.toFixed(1)}:1`); }
      }
      return { checked, low, samples };
    });
    if (contrast.checked) out[55] = contrast.low ? fail(`${plural(contrast.low, "text element")} below WCAG contrast (${contrast.samples.join(", ")}).`, "Raise text contrast to at least 4.5:1 (3:1 for large text) against its background.") : pass(`${plural(contrast.checked, "text element")} sampled; all meet WCAG AA contrast.`);

    /* keyboard order and focus visibility (51, 52) */
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const total = await page.locator(INTERACTIVE).count();
    const seen = new Set<string>(); let invisible = 0, stuck = false;
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      const h = await page.evaluateHandle(() => (document.activeElement === document.body ? null : document.activeElement));
      const el = h.asElement(); if (!el) continue;
      const id = await el.evaluate((e) => e.tagName + ":" + (e.textContent ?? "").trim().slice(0, 20) + ":" + Math.round(e.getBoundingClientRect().x) + "," + Math.round(e.getBoundingClientRect().y));
      if (seen.has(id)) { stuck = i < 3 && seen.size < Math.min(total, 3); break; }
      seen.add(id);
      const [focused, unfocused] = await el.evaluate((e) => { const st = () => { const s = getComputedStyle(e); return [s.outlineStyle, s.outlineWidth, s.boxShadow, s.backgroundColor, s.borderColor, s.color, s.textDecorationLine].join("|"); }; const a = st(); (e as HTMLElement).blur(); const b = st(); (e as HTMLElement).focus(); return [a, b]; });
      if (focused === unfocused) invisible++;
    }
    out[51] = total && !seen.size ? fail("Pressing Tab never moved focus to any element.", "Make interactive controls real links, buttons or inputs so the keyboard can reach them.") : stuck ? fail("Keyboard focus got trapped on one element.", "Remove focus traps so Tab moves through the page in order.") : seen.size ? pass(`Tab reached ${plural(seen.size, "element")} in order.`) : skip("No interactive elements to tab through.");
    out[52] = !seen.size ? skip("No focusable elements to check.") : invisible > seen.size / 2 ? fail(`${invisible} of ${seen.size} tabbed elements show no visible focus change.`, "Add a visible :focus-visible outline or ring to links, buttons and inputs.") : pass(`${seen.size - invisible} of ${seen.size} tabbed elements show a visible focus indicator.`);

    /* click buttons and menus (1, 12) */
    await page.goto(url, { waitUntil: "load", timeout: 15_000 });
    const dead = await probeClicks(page, origin, false), menus = await probeClicks(page, origin, true);
    out[1] = dead.tried ? (dead.dead.length ? fail(`${plural(dead.dead.length, "button")} did nothing when clicked (${list(dead.dead)}).`, "Wire each button to a handler, link or form action, or remove it. Placeholder buttons look broken to users.") : pass(`${plural(dead.tried, "button")} clicked; each changed the page or sent a request.`)) : skip("No safe buttons to click on this page.");
    out[12] = menus.tried ? (menus.dead.length ? fail(`${plural(menus.dead.length, "menu or toggle")} did not open (${list(menus.dead)}).`, "Make sure menu and dropdown triggers toggle aria-expanded and reveal their panel.") : pass(`${plural(menus.tried, "menu or toggle")} opened and responded to a click.`)) : skip("No menus or dropdown triggers found to test.");
    if (mutating) out[1] = out[1].status === "failed" ? out[1] : { ...out[1], reason: `${out[1].reason} ${plural(mutating, "write request")} blocked during testing.` };
    return out;
  };
  try { return await Promise.race([run(), timer]); }
  catch (error) { console.error("browser checks failed", error instanceof Error ? error.message : error); return {}; }
  finally { await browser?.close().catch(() => undefined); }
}

const SNAP = () => location.href + document.body.innerHTML.length + [...document.querySelectorAll("[aria-expanded],[data-state],dialog,[role=dialog],[role=menu]")].map((e) => (e.getAttribute("aria-expanded") ?? "") + (e.getAttribute("data-state") ?? "") + ((e as HTMLElement).offsetHeight ?? 0)).join();

/** Clicks up to 8 buttons (or aria menu triggers) and reports those with no visible effect. Never submits forms or follows other origins. */
async function probeClicks(page: Page, origin: string, menus: boolean) {
  const sel = menus ? '[aria-haspopup]:not([aria-haspopup=false]),[aria-expanded],[data-state=closed]' : 'button:not([type=submit]):not([aria-expanded]):not([aria-haspopup]),[role=button]:not([aria-expanded])';
  const handles = await page.locator(sel).elementHandles();
  const dead: string[] = []; let tried = 0;
  for (const h of handles) {
    if (tried >= 8) break;
    const info = await h.evaluate((el: Element) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); const label = ((el.textContent ?? "").trim() || el.getAttribute("aria-label") || el.id || el.tagName).slice(0, 24); return { ok: r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && !(el as HTMLButtonElement).disabled && !el.closest("form") && !/delete|remove|buy|pay|purchase|subscribe|sign ?out|log ?out|checkout|order/i.test(label), label }; }).catch(() => undefined);
    if (!info?.ok) continue;
    tried++;
    const before = await page.evaluate(SNAP);
    let requests = 0; const count = () => { requests++; }; page.on("request", count);
    await h.click({ timeout: 2000, trial: false }).catch(() => undefined);
    await page.waitForTimeout(350);
    page.off("request", count);
    if (!page.url().startsWith(origin)) { await page.goBack().catch(() => undefined); continue; }
    const after = await page.evaluate(SNAP);
    if (before === after && !requests) dead.push(info.label);
  }
  return { tried, dead };
}
