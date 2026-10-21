# VibeProof

Pre-launch verification for vibe-coded apps. Scan a live site or a public GitHub repo against 82 launch checks across 10 areas: functionality, UI/UX, security, backend, performance, SEO, accessibility, testing, deployment, and legal/launch readiness. Every finding comes with evidence and a copyable fix prompt.

## What it does

- **Site scan**: fetches the URL and checks HTTPS, redirects, headers, CSP, CORS, markup, SEO, accessibility, robots/sitemap, exposed files, linked pages and assets, and secrets in client code.
- **Browser pass**: renders the page in headless Chromium to check layout overflow at three widths, tap targets, focus, contrast, broken images and fonts, and console errors. If the browser fails or runs out of time, the static scan still returns.
- **GitHub repo review**: paste a public repo URL. The default branch is read without cloning or running anything, and checked for committed secrets, unprotected routes, broken imports and missing tests. If the repo lists a website, the live site is scanned too and results are merged.
- **Stress test**: a short, capped burst of requests (max 8 concurrent, 8 seconds, 100 requests) that reports latency percentiles and errors. You must confirm you're authorized to test the target.
- **Reports**: each scan is saved with a score, findings and all 82 checks. Checks come back as passed, failed, or Manual when they need source access, credentials, provider settings or a human.
- **Lighthouse (optional)**: adds performance, layout shift, contrast and console results via PageSpeed Insights.

## Limits

Sign-in with Google is required, scan targets on private networks are rejected, and scans and stress tests are rate limited per user, IP and host. VibeProof is a bounded HTTP, HTML and browser check, not a security certification, compliance guarantee, or full red-team scan.

## Stack

Next.js 16, React 19, Tailwind 4, Firebase Auth, Neon Postgres, Playwright.

## Tamper-evident evidence, offline verify, retests, slow-network mode

- **Chain**: every run is logged as `start → 82 check records → end`; each record stores the SHA-256 of the previous one (`lib/chain.mjs`). On the web app it is saved to the append-only `evidence_log` table (UPDATE/DELETE blocked by trigger), but the DB is not the proof: download the report (**Download proof report**) and check it yourself.
- **Verify offline** (no server, no DB): `npx vibeproof verify report.json [--head <pinned hash>]`. Names the first tampered record, or detects truncation. Pin the head hash somewhere you trust to also catch a fully rewritten file.
- **Retest**: `npx vibeproof retest report.json --check 30 --allow-local` (CLI) or **Retest this fix** (web). It re-runs the same URL and mode, links to the original head hash, and shows **Fix Verified** only if the link, the test fingerprint (URL, slow mode, checklist) and the original failure all check out: `npx vibeproof verify retest.json --original report.json --check 30`.
- **Slow-network mode** (`--slow`, or the checkbox): Chromium only talks to a reverse proxy inside the runner (`lib/slow.ts`) that adds 900 ms to every request and replays a state-changing request 120 ms later. A signup that creates two accounts fails check 30 and gets a repair prompt. A normal scan marks check 30 manual.
- **CLI**: `npx vibeproof scan <url> [--slow] [--out f] [--allow-local]`. Demo target: `npm run demo` (buggy) or `node scripts/demo-site.mjs --fixed`, then `--allow-local` scans `http://127.0.0.1:4000`.
- Apply `db/schema.sql` to add `evidence_log` and the new `scans` columns (`db/reset.sql` already includes them).
