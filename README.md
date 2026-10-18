# VibeProof

Website verification for the vibe-coding era. Firebase Auth protects the app; Neon Postgres stores users and scan reports.

## Setup

1. Create a Firebase Web app and enable Google sign-in.
2. Create a Firebase service account with Admin SDK access.
3. Create a Neon database and run [`db/schema.sql`](./db/schema.sql) in Neon SQL Editor.
4. Copy `.env.example` to `.env.local` and fill in Firebase Web config, service-account JSON, and `DATABASE_URL`.
5. Start the app:

```bash
npm run dev
```

The app signs users in with Firebase, verifies their ID token on the server, fetches the submitted URL, checks live headers/markup, and persists the report in Neon.

Each scan now stores all 82 pre-deployment checklist items in `scans.checks`. URL-observable checks are marked `passed` or `failed`; checks requiring browser automation, source access, credentials, provider settings, or human review are marked `not_testable` with a reason.

To erase and recreate the VibeProof tables manually, run [`db/reset.sql`](./db/reset.sql). This is destructive and is never run by the app.

## Verification scope

The scanner checks HTTPS, redirects, CSP, HTML language, empty links, form actions, image alt text, and obvious policy language. It is a bounded HTTP/HTML check, not a security certification or full browser red-team scan.

## Checks

```bash
npm run lint
npx next build --webpack
```

## Scan checks

Each scan evaluates all 82 checklist items against the submitted URL. Checks that can be observed from outside (HTTP, headers, HTML, linked pages and assets, robots/sitemap, secrets in client code, exposed files, CORS, SEO, accessibility markup) get a passed or failed result with evidence. Checks that need source access, accounts, a database or a real browser are marked Manual with instructions.

Optional: set `PAGESPEED_API_KEY` in `.env.local` to also run Lighthouse (performance, layout shift, color contrast, console errors) through the PageSpeed Insights API.
