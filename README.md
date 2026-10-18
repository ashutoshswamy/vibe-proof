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
