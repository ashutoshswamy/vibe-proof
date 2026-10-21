import { posix } from "node:path";
import { Readable } from "node:stream";
import zlib from "node:zlib";
import { findSecrets, type Verdict } from "./scanner";

const UA = "VibeProof/1.0 verification bot";
const MAX_KEPT = 150 * 1024 * 1024;
const MAX_TEXT = 1_000_000;

export function parseRepo(value: string) {
  try {
    const u = new URL(value);
    if (u.hostname.toLowerCase().replace(/^www\./, "") !== "github.com") return undefined;
    const [owner, name] = u.pathname.split("/").filter(Boolean);
    const repo = name?.replace(/\.git$/, "");
    return owner && repo && /^[\w.-]+$/.test(owner) && /^[\w.-]+$/.test(repo) ? { owner, repo } : undefined;
  } catch { return undefined; }
}

async function api(path: string) {
  const token = process.env.GITHUB_TOKEN;
  const response = await fetch(`https://api.github.com${path}`, { headers: { accept: "application/vnd.github+json", "user-agent": UA, ...(token ? { authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(15_000) });
  if (response.status === 404) throw new Error("GitHub repository URL not found or private");
  if (response.status === 403 || response.status === 429) throw new Error("Rate limit reached on the GitHub API; try again later");
  if (!response.ok) throw new Error("GitHub repository URL could not be read");
  return response.json();
}

type File = { path: string; size: number; text?: string };

const cstr = (b: Buffer) => b.toString("utf8").replace(/\0[\s\S]*$/, "");
const skipBody = (path: string, size: number) => /(^|\/)(?:node_modules|\.git|dist|build|\.next|vendor|coverage|\.venv|__pycache__)\//.test(path) || size > MAX_TEXT || /(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|\.min\.(?:js|css)|\.map)$/.test(path);

/** Streams the branch archive and keeps only small text files, so repo size does not decide whether a scan works. Nothing is cloned or executed. */
async function readRepo(owner: string, repo: string, branch: string) {
  const response = await fetch(`https://codeload.github.com/${owner}/${repo}/tar.gz/refs/heads/${encodeURIComponent(branch)}`, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(40_000) }).catch(() => undefined);
  if (!response || !response.ok || !response.body) throw new Error("GitHub repository URL could not be downloaded");
  const source = Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream).pipe(zlib.createGunzip());
  const deadline = Date.now() + 25_000;
  const files: File[] = [];
  let buf: Buffer = Buffer.alloc(0), longPath: string | undefined, keptBytes = 0, partial = false;
  let body: { path: string; size: number; type: string; keep: boolean; chunks: Buffer[]; got: number; total: number } | undefined;
  try {
    for await (const chunk of source as AsyncIterable<Buffer>) {
      if (Date.now() > deadline || keptBytes > MAX_KEPT) { partial = true; break; }
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        if (body) {
          const take = Math.min(buf.length, body.total - body.got);
          if (body.keep && body.got < body.size) body.chunks.push(buf.subarray(0, Math.min(take, body.size - body.got)));
          body.got += take;
          buf = buf.subarray(take);
          if (body.got < body.total) break;
          const data = Buffer.concat(body.chunks);
          if (body.type === "x") { const m = data.toString("utf8").match(/\d+ path=([^\n]+)\n/); if (m) longPath = m[1]; }
          else if (body.type === "L") longPath = cstr(data);
          else if (body.keep) { const f = files[files.length - 1]; if (!data.subarray(0, 8000).includes(0)) { f.text = data.toString("utf8"); keptBytes += data.length; } }
          body = undefined;
          continue;
        }
        if (buf.length < 512) break;
        const header = buf.subarray(0, 512);
        if (header.every((byte) => byte === 0)) return { files, partial };
        const size = parseInt(cstr(header.subarray(124, 136)).trim() || "0", 8);
        const type = String.fromCharCode(header[156]);
        const total = Math.ceil(size / 512) * 512;
        buf = buf.subarray(512);
        if (type === "x" || type === "L") { body = { path: "", size, type, keep: true, chunks: [], got: 0, total }; continue; }
        if (type === "g" || (type !== "0" && type !== "\0")) { body = { path: "", size, type, keep: false, chunks: [], got: 0, total }; continue; }
        const prefix = cstr(header.subarray(345, 500)), name = cstr(header.subarray(0, 100));
        const path = (longPath ?? (prefix ? `${prefix}/${name}` : name)).split("/").slice(1).join("/");
        longPath = undefined;
        files.push({ path, size });
        body = { path, size, type, keep: !skipBody(path, size), chunks: [], got: 0, total };
      }
    }
  } catch (error) {
    if (!files.length) throw new Error("GitHub repository URL could not be downloaded");
    partial = true;
    void error;
  } finally { source.destroy(); }
  return { files, partial };
}

/** Tag text from a JSX/HTML opening tag, tracking braces so arrow functions do not end the tag early. */
function tagsOf(text: string, names: string[]) {
  const out: string[] = [];
  const re = new RegExp(`<(?:${names.join("|")})(?=[\\s/>])`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let depth = 0, quote = "", i = m.index + 1;
    for (; i < text.length && i < m.index + 2500; i++) {
      const ch = text[i];
      if (quote) { if (ch === quote && text[i - 1] !== "\\") quote = ""; continue; }
      if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      else if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === ">" && depth <= 0) break;
    }
    out.push(text.slice(m.index, i + 1));
  }
  return out;
}

const pass = (reason: string): Verdict => ({ status: "passed", reason: `Source: ${reason}` });
const fail = (reason: string, fix: string): Verdict => ({ status: "failed", reason: `Source: ${reason}`, fix });
const skip = (reason: string): Verdict => ({ status: "not_testable", reason: `Source: ${reason}` });
const list = (items: string[], max = 3) => items.slice(0, max).join(", ") + (items.length > max ? ` and ${items.length - max} more` : "");
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const isTest = (p: string) => /(^|\/)(?:tests?|__tests__|__mocks__|spec|e2e|fixtures?|mocks?|cypress|playwright|stories|examples?|samples?|demos?|benchmarks?|bench)(\/|$)|\.(?:test|spec|stories)\.|_test\.go$|(^|\/)test_[^/]+\.py$/i.test(p);
const isDoc = (p: string) => /\.(?:md|mdx|txt|rst)$|(^|\/)docs?\//i.test(p);
const isCode = (p: string) => /\.(?:[cm]?[jt]sx?|py|rb|go|php|java|kt|vue|svelte|astro)$/i.test(p);
const isMarkup = (p: string) => /\.(?:[jt]sx|vue|svelte|astro|html?|php|erb)$/i.test(p);
const dbCall = /\bsql`|\.query\(|prisma\.|supabase\s*\.from|\.from\(["'`]|\bdb\.(?:select|insert|update|delete|query|execute)|\.collection\(|\.find(?:Many|Unique|First|One|ById)\(|mongoose|\.execute\(/;
const authCall = /requireUser|requireAuth|getServerSession|getSession|\bauth\(\)|currentUser|verifyIdToken|getUser\(|getToken|authorization|session|withAuth|isAuthenticated|jwt\.verify|cookies\(\)|clerk|login_required|Depends\(get_current/i;
const bodyRead = /request\.json\(\)|req\.json\(\)|req\.body|request\.formData|req\.formData|request\.text\(\)/;

export async function repoInfo({ owner, repo }: { owner: string; repo: string }) {
  return (await api(`/repos/${owner}/${repo}`)) as { default_branch: string; homepage?: string };
}

export async function checkRepo({ owner, repo }: { owner: string; repo: string }, meta: { default_branch: string; homepage?: string }) {
  const branch: string = meta.default_branch;
  const [{ files, partial }, runs] = await Promise.all([readRepo(owner, repo, branch), api(`/repos/${owner}/${repo}/actions/runs?per_page=1&branch=${encodeURIComponent(branch)}`).catch(() => undefined)]);
  const paths = new Set(files.map((f) => f.path));
  const text = files.filter((f): f is File & { text: string } => f.text !== undefined);
  const has = (re: RegExp) => files.filter((f) => re.test(f.path));
  const code = text.filter((f) => isCode(f.path) && !isTest(f.path));
  const markup = text.filter((f) => isMarkup(f.path) && !isTest(f.path));
  const css = text.filter((f) => /\.(?:css|scss|sass|less)$/.test(f.path));
  const nonTest = text.filter((f) => !isTest(f.path) && !isDoc(f.path));
  const all = text.map((f) => f.text).join("\n");
  const find = (re: RegExp) => text.find((f) => re.test(f.path))?.text ?? "";

  const manifests = text.filter((f) => /(^|\/)package\.json$/.test(f.path) && !/node_modules/.test(f.path) && !isTest(f.path));
  const pkgs = manifests.flatMap((f) => { try { return [JSON.parse(f.text) as { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }]; } catch { return []; } });
  const rootPkg = (() => { try { return JSON.parse(find(/^package\.json$/)) as { scripts?: Record<string, string> }; } catch { return {} as { scripts?: Record<string, string> }; } })();
  const reqs = text.filter((f) => /(^|\/)requirements[^/]*\.txt$/.test(f.path)).flatMap((f) => f.text.split("\n").map((l) => l.split(/[=<>~\[ ;]/)[0].trim().toLowerCase()).filter(Boolean));
  const depMap = Object.assign({}, ...pkgs.flatMap((p) => [p.dependencies ?? {}, p.devDependencies ?? {}])) as Record<string, string>;
  const deps = new Set([...Object.keys(depMap), ...reqs]);
  const anyDep = (re: RegExp) => [...deps].find((d) => re.test(d));
  const scripts = rootPkg.scripts ?? {};
  const nextApp = "next" in { ...(pkgs[0]?.dependencies ?? {}), ...(pkgs[0]?.devDependencies ?? {}) } && manifests[0]?.path === "package.json";
  const c: Record<number, Verdict> = {};

  /* Functionality */
  const deadHref = markup.filter((f) => /href\s*=\s*(?:["']\s*#?\s*["']|\{\s*["']#?["']\s*\}|["']\s*javascript:)/i.test(f.text)).map((f) => f.path);
  const routes = new Set<string>();
  for (const f of files) {
    const app = f.path.match(/^(?:src\/)?app\/(?:(.*)\/)?page\.(?:[jt]sx?|mdx)$/), pg = f.path.match(/^(?:src\/)?pages\/(.+)\.(?:[jt]sx?|mdx)$/);
    if (app) routes.add(`/${(app[1] ?? "").split("/").filter((s) => s && !/^\(.*\)$/.test(s)).join("/")}`);
    else if (pg && !/^(?:_|api\/)/.test(pg[1])) routes.add(`/${pg[1].replace(/(?:^|\/)index$/, "")}`);
  }
  const esc = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const segment = (v: string) => (/^\[\[\.\.\./.test(v) ? "(?:/.*)?" : /^\[\.\.\./.test(v) ? "/.+" : /^\[.*\]$/.test(v) ? "/[^/]+" : `/${esc(v)}`);
  const routeRes = [...routes].map((r) => new RegExp(`^${r.split("/").filter(Boolean).map(segment).join("")}/?$`));
  const deadRoutes = !routes.size ? [] : markup.flatMap((f) => [...f.text.matchAll(/href\s*=\s*["'](\/[^"'#?{}$ ]*)["']/g)].map((m) => m[1]).filter((h) => !/^\/(?:api|_next)\b|\.\w+$/.test(h) && !routeRes.some((re) => re.test(h)) && !paths.has(`public${h}`)).map((h) => `${h} in ${f.path}`));
  c[1] = deadHref.length || deadRoutes.length ? fail(`${deadHref.length ? `Empty or javascript: links in ${list(deadHref)}` : ""}${deadHref.length && deadRoutes.length ? "; " : ""}${deadRoutes.length ? `links to routes that do not exist: ${list([...new Set(deadRoutes)])}` : ""}.`, "Point every link at a real route and remove href=\"#\" placeholders.") : markup.length ? pass(`${plural(markup.length, "markup file")} checked for empty links and links to missing routes.`) : skip("No markup files found.");
  const authLib = anyDep(/next-auth|^@auth\/|^@clerk|supabase|firebase|passport|lucia|better-auth|auth0|kinde|devise/);
  const reset = /sendPasswordResetEmail|resetPasswordForEmail|forgot[-_ ]?password|reset[-_ ]?password|requestPasswordReset|forgotPassword|password_reset/i.test(all);
  const signOut = /signOut|logout|sign_out|log_out/i.test(all);
  c[3] = !authLib ? skip("No authentication library found in dependencies.") : reset && signOut ? pass(`${authLib} auth with sign-out and password reset code found. The flows still need a live test.`) : fail(`${authLib} auth found but ${[!reset && "no password reset", !signOut && "no sign-out"].filter(Boolean).join(" or ")} in the code.`, "Add password reset and sign-out flows.");
  const verbs = new Set<string>();
  for (const f of code) { for (const m of f.text.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b/g)) verbs.add(m[1]); for (const m of f.text.matchAll(/\b(?:app|router)\.(get|post|put|patch|delete)\(/g)) verbs.add(m[1].toUpperCase()); }
  c[4] = verbs.has("GET") && verbs.has("POST") && verbs.has("DELETE") && (verbs.has("PUT") || verbs.has("PATCH")) ? pass("API handlers for create, read, update and delete exist. Behavior needs an end-to-end test.") : skip(`Handlers found for ${[...verbs].join(", ") || "no HTTP verbs"}; full CRUD not detected.`);
  const loadingUi = has(/(^|\/)loading\.[jt]sx?$/).length > 0 || /isLoading|isPending|<Suspense|[Ss]keleton|[Ss]pinner|loading\s*(?:\?|&&|\|\|)/.test(markup.map((f) => f.text).join("\n"));
  const errorUi = has(/(^|\/)error\.[jt]sx?$/).length > 0 || /ErrorBoundary|isError|setError|role=["']alert/.test(markup.map((f) => f.text).join("\n"));
  c[6] = loadingUi && errorUi ? pass("Loading and error handling UI found in source. Empty states need a visual check.") : markup.length >= 3 ? fail(`No ${[!loadingUi && "loading", !errorUi && "error"].filter(Boolean).join(" or ")} state found in ${plural(markup.length, "markup file")}.`, "Add loading, empty and error states to every screen that fetches data.") : skip("Too little UI code to judge states.");
  const unfinished = nonTest.filter((f) => isCode(f.path) && /\b(?:TODO|FIXME)\b/.test(f.text)).map((f) => f.path);
  const lorem = markup.filter((f) => /lorem ipsum/i.test(f.text)).map((f) => f.path);
  c[8] = unfinished.length || lorem.length ? fail(`${unfinished.length ? `TODO or FIXME in ${plural(unfinished.length, "file")} (${list(unfinished)})` : ""}${unfinished.length && lorem.length ? "; " : ""}${lorem.length ? `lorem ipsum in ${list(lorem)}` : ""}.`, "Finish or remove unfinished TODOs and placeholder copy before launch.") : pass(`No TODO, FIXME or lorem ipsum in ${plural(nonTest.length, "file")}.`);

  /* UI */
  c[9] = /name=["']viewport["']|export const viewport|width=device-width|\b(?:sm|md|lg):[a-z]|@media[^{]*(?:min|max)-width/.test(all) ? pass("Viewport setting or responsive rules found in source. Real layouts need a visual check.") : skip("No viewport or responsive rules found.");
  const publicDir = [...paths].some((p) => p.startsWith("public/"));
  const missingAssets = !publicDir ? [] : markup.flatMap((f) => [...f.text.matchAll(/(?:src|href)\s*=\s*["']\/([^"'?#{}$ ]+\.(?:png|jpe?g|svg|webp|gif|ico|css|js|woff2?|mp4|webm))["']/g)].map((m) => m[1]).filter((a) => !paths.has(`public/${a}`) && !paths.has(a)).map((a) => `/${a}`));
  c[13] = missingAssets.length ? fail(`Referenced files missing from public/: ${list([...new Set(missingAssets)])}.`, "Add the missing files to public/ or fix the paths.") : publicDir ? pass("Every public asset referenced by markup exists in public/.") : skip("No public/ directory to resolve asset paths against.");
  c[14] = /\bdark:[a-z]|prefers-color-scheme|next-themes|data-theme|color-scheme/.test(all) ? pass("Dark mode support found in source.") : skip("No dark mode support found. Fine if the site does not need it.");
  c[16] = has(/(^|\/)(?:not-found\.[jt]sx?|404\.(?:[jt]sx?|html))$/).length || /NotFound|notFound\(\)/.test(all) ? pass("A custom 404 page exists in source.") : nextApp ? fail("Next.js app has no not-found page, so unknown URLs show the framework default.", "Add app/not-found.tsx with a link back to the homepage.") : skip("No framework detected that needs a custom 404 file.");

  /* Security */
  const secretFiles = nonTest.flatMap((f) => {
    const hits = findSecrets(f.text);
    const hard = f.text.match(/(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*["'`]([A-Za-z0-9_\-/+]{20,})["'`]/i);
    if (hard && !/process\.env|import\.meta\.env|os\.environ/.test(hard[0]) && !/your|example|placeholder|xxxx|changeme|\*{3}/i.test(hard[1])) hits.push("hardcoded credential");
    return hits.length ? [`${f.path} (${hits[0]})`] : [];
  });
  c[17] = secretFiles.length ? fail(`Secrets in source: ${list(secretFiles)}.`, "Revoke the exposed credentials, load them from environment variables and rewrite git history if the repo is public.") : pass(`${plural(text.length, "text file")} scanned for keys, tokens and private keys. None found.${partial ? " The archive was only partly read (size or time limit), so later files were skipped." : ""}`);
  const envFiles = has(/(^|\/)\.env(?!\.(?:example|sample|template|defaults)$)[^/]*$/);
  const gitignore = find(/^\.gitignore$/);
  const publicSecrets = [...new Set(nonTest.flatMap((f) => [...f.text.matchAll(/\bNEXT_PUBLIC_[A-Z0-9_]*(?:SECRET|PRIVATE|SERVICE_ROLE|PASSWORD)[A-Z0-9_]*/g)].map((m) => m[0])))];
  c[18] = envFiles.length ? fail(`Environment file committed: ${list(envFiles.map((f) => f.path))}.`, "Remove the file from git, rotate every value in it and add .env* to .gitignore.") : publicSecrets.length ? fail(`Secret exposed to the browser through a public variable: ${list(publicSecrets)}.`, "Rename it without the NEXT_PUBLIC_ prefix and read it only on the server.") : !/^\s*\.env\b/m.test(gitignore) && files.length ? fail(".gitignore does not exclude .env files.", "Add .env* to .gitignore (keep a .env.example).") : pass("No .env file committed, .gitignore excludes them and no secret uses a public prefix.");
  const apiRoute = /(^|\/)(?:app\/api\/.+\/route|pages\/api\/.+|api\/.+|routes\/.+|server\/.+|controllers\/.+)\.[cm]?[jt]s$|(^|\/)(?:views|routes|api)[^/]*\.py$/;
  const apiFiles = code.filter((f) => apiRoute.test(f.path));
  const validator = anyDep(/^(zod|joi|yup|valibot|ajv|class-validator|express-validator|pydantic|marshmallow|cerberus|superstruct)$/);
  const bodyRoutes = apiFiles.filter((f) => bodyRead.test(f.text));
  const unvalidated = bodyRoutes.filter((f) => !/safeParse|\.parse\(|\.validate\(|validateSync|Joi\.|z\.object|typeof\s+[\w.]+\s*[!=]==|isinstance|BaseModel/.test(f.text)).map((f) => f.path);
  c[19] = !bodyRoutes.length ? skip("No API routes reading a request body found.") : unvalidated.length ? fail(`${plural(unvalidated.length, "route")} read a request body with no schema or type check (${list(unvalidated)}).`, `Validate every request body on the server${validator ? ` with ${validator}` : " with zod or similar"} before using it.`) : pass(`All ${plural(bodyRoutes.length, "route")} reading a request body validate or type-check it.`);
  const dbRoutes = apiFiles.filter((f) => dbCall.test(f.text));
  const unguarded = dbRoutes.filter((f) => !authCall.test(f.text)).map((f) => f.path);
  c[20] = !dbRoutes.length ? skip("No API routes that touch a database found.") : unguarded.length ? fail(`${plural(unguarded.length, "database-backed route")} with no authentication check (${list(unguarded)}). Ignore if they are intentionally public.`, "Verify the user on the server at the top of every route that reads or writes data.") : pass(`All ${plural(dbRoutes.length, "database-backed route")} reference an authentication check. Correctness still needs two-account tests.`);
  const paramRoutes = dbRoutes.filter((f) => /params|searchParams|req\.query|req\.params/.test(f.text) && authCall.test(f.text));
  const unscoped = paramRoutes.filter((f) => !/user_?id|uid|owner|created_by|tenant|org_?id|firebase_uid|session\.user|\.eq\(["']user/i.test(f.text)).map((f) => f.path);
  c[21] = !paramRoutes.length ? skip("No routes that look up records by an ID from the request.") : unscoped.length ? fail(`${plural(unscoped.length, "route")} look up records by request ID without filtering by the current user (${list(unscoped)}).`, "Add the signed-in user's ID to the query so users can only read their own records.") : pass("Routes that look up records by ID also filter by the current user. Confirm with two accounts.");
  const sqlText = text.filter((f) => /\.(?:sql|prisma)$/.test(f.path) || /migrat/i.test(f.path)).map((f) => f.text).join("\n");
  const created = (sqlText.match(/create table/gi) ?? []).length, rls = (sqlText.match(/enable row level security/gi) ?? []).length;
  c[22] = created && (/supabase|auth\.uid\(\)/i.test(sqlText) || anyDep(/supabase/)) ? (rls < created ? fail(`${plural(created, "table")} created but only ${rls} with row level security enabled.`, "Enable RLS on every table and add per-user policies.") : pass(`RLS enabled on all ${plural(created, "table")} in SQL. Policies still need a live test.`)) : skip("No Supabase tables found in SQL files.");
  const adminFiles = code.filter((f) => /(^|\/)admin(\/|\.)/i.test(f.path));
  const guardedByMiddleware = text.some((f) => /(^|\/)(?:middleware|proxy)\.[jt]s$/.test(f.path) && /admin/i.test(f.text));
  const openAdmin = guardedByMiddleware ? [] : adminFiles.filter((f) => !authCall.test(f.text) && !/role|isAdmin|is_admin|permission/i.test(f.text)).map((f) => f.path);
  c[23] = !adminFiles.length ? skip("No admin routes found in source.") : openAdmin.length ? fail(`Admin files with no authentication or role check: ${list(openAdmin)}.`, "Require an admin role on the server for every admin route and action.") : pass(`${plural(adminFiles.length, "admin file")} found, all guarded by an auth or role check. Verify with a non-admin account.`);
  const limiter = anyDep(/rate-?limit|throttl|arcjet|slowapi|bottleneck/) ?? has(/rate-?limit/i)[0]?.path;
  c[24] = limiter ? pass(`Rate limiting found (${limiter}).`) : skip("No rate-limiting library or module found in the repo.");
  const lock = has(/(^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|poetry\.lock|Pipfile\.lock|uv\.lock)$/);
  const unpinned = Object.entries(depMap).filter(([, v]) => v === "*" || v === "latest").map(([k]) => k);
  c[25] = unpinned.length ? fail(`Unpinned dependency versions: ${list(unpinned)}.`, "Pin every dependency to a version range and commit a lockfile.") : manifests.length && !lock.length ? fail("No lockfile committed, so dependency versions are not pinned.", "Commit your lockfile and run npm audit in CI.") : manifests.length || reqs.length ? pass(`Lockfile committed${has(/^\.github\/dependabot\.ya?ml$|^renovate\.json5?$/).length ? " and automated dependency updates configured" : ""}. Run npm audit for known vulnerabilities.`) : skip("No package manifest found.");
  const logLeaks = code.filter((f) => /console\.(?:log|info|debug|error|warn)\([^)\n]*(?:password|token|secret|authorization|req\.headers|apiKey|api_key|privateKey)/i.test(f.text) || /json\(\s*\{[^}]*(?:err|error|e)\w*\.stack/.test(f.text)).map((f) => f.path);
  c[26] = logLeaks.length ? fail(`Sensitive values logged or returned in ${list(logLeaks)}.`, "Remove secrets and tokens from logs and never return stack traces to clients.") : pass(`No sensitive values logged and no stack traces returned in ${plural(code.length, "code file")}.`);

  /* Backend */
  const migrations = has(/migrat|alembic|drizzle|(^|\/)schema\.(?:sql|prisma)$|(^|\/)db\/.*\.sql$/i);
  c[27] = migrations.length ? pass(`Schema or migration files found (${list(migrations.map((f) => f.path))}). The applied production state needs database access.`) : skip("No migration or schema files found. If you use a database, commit your schema.");
  c[28] = !sqlText ? skip("No SQL or Prisma schema files read.") : /primary key|foreign key|references|create (?:unique )?index|@@index|@relation|@id/i.test(sqlText) ? pass("Schema defines keys, relations or indexes.") : fail("Schema files define no keys, constraints or indexes.", "Add primary keys, foreign keys and indexes on filtered columns.");
  c[30] = /\bunique\b|on conflict|upsert|idempoten/i.test(sqlText + code.map((f) => f.text).join("\n")) ? pass("Unique constraints, upserts or idempotency handling found in source.") : skip("No unique constraints or upsert handling found.");
  c[31] = /\bBEGIN\b|\$transaction|\.transaction\(|FOR UPDATE|withTransaction|db\.batch|START TRANSACTION/.test(sqlText + code.map((f) => f.text).join("\n")) ? pass("Transaction handling found in source.") : skip("No transaction handling found.");
  const uploadFiles = code.filter((f) => /multer|formidable|busboy|uploadthing|get\(["']file["']\)|storage\.from\(|\.upload\(/.test(f.text));
  const unchecked = uploadFiles.filter((f) => !/maxFileSize|file\.size|\.size\s*[><]|mimetype|\.type\s*(?:===|!==|\.startsWith|\.includes)|fileFilter|limits\s*:|allowedTypes|allowedMime/.test(f.text)).map((f) => f.path);
  c[32] = !uploadFiles.length ? skip("No file upload code found.") : unchecked.length ? fail(`Upload code without size or type checks: ${list(unchecked)}.`, "Enforce a maximum size and an allowed type list on the server for every upload.") : pass("Upload code checks file size or type. Access rules need a live test.");
  const unhandled = code.filter((f) => /await\s+(?:fetch|axios\.(?:get|post|put|patch|delete)|got)\(/.test(f.text) && !/\btry\s*\{|\.catch\(|except\b/.test(f.text)).map((f) => f.path);
  c[34] = unhandled.length ? fail(`Outbound requests with no error handling in ${list(unhandled)}.`, "Wrap third-party calls in try/catch with a timeout and show a fallback state on failure.") : code.some((f) => /await\s+(?:fetch|axios)/.test(f.text)) ? pass("Files making outbound requests include error handling. Timeouts and retries need a fault test.") : skip("No outbound HTTP calls found.");

  /* Performance */
  const bigImages = files.filter((f) => /\.(?:png|jpe?g|gif|bmp|tiff?)$/i.test(f.path) && !/node_modules/.test(f.path) && f.size > 500_000);
  c[36] = bigImages.length ? fail(`Images over 500 KB committed: ${list(bigImages.map((f) => `${f.path} (${Math.round(f.size / 1024)} KB)`))}.`, "Resize and compress these images, or convert them to WebP or AVIF.") : has(/\.(?:png|jpe?g|webp|avif)$/i).length ? pass("No committed image is over 500 KB.") : skip("No image files in the repo.");
  const heavy = anyDep(/^(moment|lodash|jquery|core-js)$/);
  c[37] = heavy ? fail(`Heavy dependency ${heavy} in package.json.`, "Replace it with a smaller alternative (date-fns, lodash-es, native APIs).") : skip("No oversized dependencies found. Bundle size needs a build.");
  const nPlusOne = code.filter((f) => /(?:for\s*\([^)]*\)|for\s+\w+\s+in\b|while\s*\([^)]*\)|\.map\(\s*async|\.forEach\(\s*async)[\s\S]{0,400}?await\s+[\w.]*(?:sql`|query\(|prisma\.|supabase\s*\.from|findUnique|findFirst|findOne)/.test(f.text)).map((f) => f.path);
  c[38] = nPlusOne.length ? fail(`Possible N+1: database call inside a loop in ${list(nPlusOne)}.`, "Fetch the rows in one query with a join, IN clause or include, then map in memory.") : dbRoutes.length || code.some((f) => dbCall.test(f.text)) ? pass("No database call inside a loop found. Slow queries need logs or EXPLAIN.") : skip("No database queries found.");

  /* SEO */
  c[43] = /export const metadata|generateMetadata|<title>|<Head>|react-helmet|useHead|useSeoMeta/.test(all) && /description/i.test(all) ? pass("Page title and description metadata are defined in source.") : skip("No page metadata found in source.");
  c[44] = /alternates|rel=["']canonical/.test(all) ? pass("Canonical URL is set in source.") : skip("No canonical URL found in source.");
  const robots = has(/(^|\/)robots\.(?:txt|ts|js)$/).length > 0, sitemap = has(/(^|\/)sitemap[^/]*\.(?:xml|ts|js)$/).length > 0 || !!anyDep(/next-sitemap|sitemap/);
  c[45] = robots && sitemap ? pass("robots and sitemap files or generators found in source.") : skip(`Missing in source: ${[!robots && "robots.txt", !sitemap && "sitemap"].filter(Boolean).join(", ")}.`);
  c[46] = /openGraph|og:image|opengraph-image|twitter:card|twitter\s*:/.test(all) ? pass("Open Graph or Twitter card metadata found in source.") : skip("No Open Graph metadata found in source.");
  c[48] = /ld\+json|schema\.org/.test(all) ? pass("Structured data (JSON-LD) found in source.") : skip("No structured data found in source.");
  c[50] = has(/(^|\/)(?:favicon\.ico|icon\.(?:png|svg|ico|[jt]sx?)|apple-icon\.[a-z]+)$/).length ? pass("Favicon or app icon file found.") : skip("No favicon file found in the repo.");

  /* Accessibility */
  const clickable = markup.filter((f) => tagsOf(f.text, ["div", "span", "li", "td", "p"]).some((t) => /\bonClick\b/.test(t) && !/\brole=|\btabIndex|\bonKey(?:Down|Up|Press)\b/.test(t))).map((f) => f.path);
  c[51] = clickable.length ? fail(`Clickable div or span without role, tabIndex or key handler in ${list(clickable)}.`, "Use a real <button> or add role, tabIndex and a keyboard handler.") : markup.length ? pass("No clickable non-interactive elements found in markup. A keyboard walkthrough still needs a browser.") : skip("No markup files found.");
  const styleText = [...css, ...markup].map((f) => f.text).join("\n");
  const outlineOff = /outline\s*:\s*(?:none|0)\b|\boutline-none\b/.test(styleText), focusStyle = /:focus-visible|:focus\b|focus-visible:|focus:ring|focus:outline|focus:border|focus-within/.test(styleText);
  c[52] = outlineOff && !focusStyle ? fail("Outlines are removed and no :focus style replaces them.", "Add a visible :focus-visible style to links, buttons and inputs.") : focusStyle ? pass("Focus styles are defined in source.") : skip("No focus rules or outline resets found.");
  const unlabeled = markup.filter((f) => tagsOf(f.text, ["input", "textarea", "select"]).some((t) => !/type=["']?(?:hidden|submit|button|image|reset)/.test(t)) && !/<label|htmlFor|aria-label|<Label|aria-labelledby/.test(f.text)).map((f) => f.path);
  const hasInputs = markup.some((f) => tagsOf(f.text, ["input", "textarea", "select"]).length);
  c[53] = unlabeled.length ? fail(`Form fields with no label in ${list(unlabeled)}.`, "Give every field a <label htmlFor> or an aria-label. Placeholders are not labels.") : hasInputs ? pass("Files with form fields also include labels.") : skip("No form fields found in markup.");
  const imgTags = markup.flatMap((f) => tagsOf(f.text, ["img", "Image"]).map((t) => [f.path, t] as const));
  const noAlt = [...new Set(imgTags.filter(([, t]) => !/\balt\s*=/.test(t) && !/\{\s*\.\.\./.test(t)).map(([p]) => p))];
  c[54] = noAlt.length ? fail(`Images without alt in ${list(noAlt)}.`, 'Describe each informative image in alt text and use alt="" for decorative ones.') : imgTags.length ? pass(`All ${plural(imgTags.length, "image tag")} have alt attributes. Whether the text is meaningful needs review.`) : skip("No image tags found in markup.");
  const animated = /@keyframes|\banimate-|framer-motion|motion\/react|gsap|animation\s*:/.test(styleText + all), reduced = /prefers-reduced-motion|motion-reduce|motion-safe|useReducedMotion|reducedMotion/.test(styleText + all);
  c[58] = animated && !reduced ? fail("Animation is used but prefers-reduced-motion is never handled.", "Wrap animation in @media (prefers-reduced-motion: no-preference) or disable it under reduce.") : reduced ? pass("Reduced-motion handling found in source.") : skip("No animation found in source.");

  /* Testing and code quality */
  const tests = files.filter((f) => isTest(f.path) && /\.(?:[cm]?[jt]sx?|py|rb|go)$/.test(f.path));
  const runner = anyDep(/^(jest|vitest|mocha|ava|pytest|rspec|@playwright\/test|cypress)$/);
  c[60] = tests.length ? pass(`${plural(tests.length, "test file")} found${runner ? ` (${runner})` : ""}. Coverage of important logic needs a review.`) : fail("No test files found.", "Add unit tests for the core logic (auth, payments, data handling).");
  const integration = tests.filter((f) => /integration|api|route|db|e2e/i.test(f.path));
  c[61] = !tests.length ? fail("No tests found, so API and database flows are not covered.", "Add integration tests that call your API routes against a test database.") : integration.length ? pass(`${plural(integration.length, "integration-style test file")} found.`) : skip("Tests exist but none look like API or database integration tests.");
  const e2e = anyDep(/^(@playwright\/test|playwright|cypress|puppeteer|webdriverio|testcafe|selenium-webdriver)$/) ?? has(/(^|\/)(?:playwright|cypress)\.config\./)[0]?.path;
  c[62] = e2e ? pass(`End-to-end framework found (${e2e}).`) : fail("No end-to-end test framework found.", "Add Playwright or Cypress tests for signup, login and your main user journey.");
  const testText = text.filter((f) => isTest(f.path));
  c[63] = !tests.length ? fail("No tests, so invalid input and unauthorized access are untested.", "Add tests for invalid payloads and for 401 and 403 responses.") : testText.some((f) => /\b(?:401|403|400|422)\b|unauthori[sz]ed|forbidden|invalid|rejects|toThrow/i.test(f.text)) ? pass("Tests cover invalid input or unauthorized access cases.") : fail("Tests exist but none cover invalid input or unauthorized access.", "Add test cases for malformed input and 401 or 403 responses.");
  const exts = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".vue", ".svelte", ".astro"];
  const exists = (p: string) => paths.has(p) || exts.some((e) => paths.has(p + e)) || exts.some((e) => paths.has(`${p}/index${e}`));
  const brokenImports = code.filter((f) => /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/.test(f.path)).flatMap((f) => [...f.text.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)["']((?:\.{1,2}\/|@\/|~\/)[^"'?]+)["']/g)].map((m) => m[1]).filter((spec) => {
    if (spec.startsWith("@/") || spec.startsWith("~/")) return !["", "src/"].some((base) => exists(posix.normalize(base + spec.slice(2))));
    return !exists(posix.normalize(posix.join(posix.dirname(f.path), spec)));
  }).map((spec) => `${f.path} imports ${spec}`));
  c[64] = brokenImports.length || deadRoutes.length ? fail(`${brokenImports.length ? `Imports that resolve to no file: ${list(brokenImports)}` : ""}${brokenImports.length && deadRoutes.length ? "; " : ""}${deadRoutes.length ? `links to missing routes: ${list([...new Set(deadRoutes)])}` : ""}.`, "Fix or remove every import and link that points at a file or route that does not exist.") : pass(`Every relative import in ${plural(code.length, "code file")} resolves to a file${routes.size ? " and every internal link matches a route" : ""}.`);
  const aiLeftovers = code.filter((f) => /\/\/\s*\.\.\.\s*(?:rest|existing|same|other|remaining)|not implemented|implementation (?:goes )?here|your code here|\/\/\s*add your/i.test(f.text)).map((f) => f.path);
  c[65] = aiLeftovers.length ? fail(`Placeholder or stub code left in ${list(aiLeftovers)}.`, "Finish or delete the stubbed functions and review generated code for wrong assumptions.") : skip("No stub markers found. AI-generated code still needs a human review.");
  const run = runs?.workflow_runs?.[0] as { conclusion: string | null; status: string; name: string } | undefined;
  const ci = run?.status === "completed" ? run.conclusion : undefined;
  const missingScripts = ["build", "lint"].filter((k) => !scripts[k]);
  c[59] = ci === "success" ? pass(`Latest CI run "${run!.name}" on ${branch} succeeded.`) : ci === "failure" ? fail(`Latest CI run "${run!.name}" on ${branch} failed.`, "Open the failed workflow run on GitHub, fix the build, type or lint error and push.") : manifests.length && missingScripts.length ? fail(`package.json has no ${missingScripts.join(" or ")} script.`, "Add build and lint scripts and run them in CI.") : skip(`${manifests.length ? "build and lint scripts exist" : "No package.json"}, but no CI result is available. Run them locally or add a workflow.`);

  /* Deployment */
  c[67] = ci === "success" ? pass(`CI builds ${branch} successfully in a clean environment.`) : ci === "failure" ? fail(`CI run on ${branch} failed.`, "Fix the failing workflow so a clean build succeeds before deploying.") : skip("No CI run to confirm a clean-environment build.");
  const envExample = has(/(^|\/)\.env\.(?:example|sample|template)$/);
  c[68] = envExample.length ? pass(`Required variables are documented in ${envExample[0].path}. Production values need checking in your host.`) : skip("No .env.example documenting required variables.");
  const local = nonTest.filter((f) => !/\.(?:md|mdx|txt|json|ya?ml|toml|env[^/]*)$|(^|\/)(?:\.env|docker|Dockerfile|Makefile)/.test(f.path) && !/(^|\/)(?:next|vite|webpack|jest|vitest|playwright|cypress)\.config\./.test(f.path) && /["'`]https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d{2,5}/.test(f.text) && !/process\.env|NODE_ENV|import\.meta\.env/.test(f.text.match(/.{0,80}https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d{2,5}.{0,40}/)?.[0] ?? "")).map((f) => f.path);
  c[70] = local.length ? fail(`Hardcoded localhost URLs in ${list(local)}.`, "Read API and callback URLs from environment variables instead of hardcoding localhost.") : skip("No hardcoded localhost URLs found. Provider callback URLs need checking in their dashboards.");
  const corsAny = code.filter((f) => /Access-Control-Allow-Origin["'`]?\s*[,:]\s*["'`]\*|cors\(\s*\)|origin\s*:\s*(?:true|["'`]\*["'`])/.test(f.text)).map((f) => f.path);
  c[71] = corsAny.length ? fail(`Wildcard or open CORS in ${list(corsAny)}.`, "Allow only an explicit list of trusted origins.") : code.some((f) => /cors|Access-Control/i.test(f.text)) ? pass("CORS is configured without a wildcard. OAuth redirect URIs and email settings need provider dashboards.") : skip("No CORS configuration found in source.");
  const keyFiles = has(/\.(?:pem|p12|pfx|key|keystore|jks)$|(^|\/)id_(?:rsa|ed25519)$|service-?account[^/]*\.json$|firebase-adminsdk[^/]*\.json$|(^|\/)credentials\.json$/i);
  const npmrcToken = text.filter((f) => /(^|\/)\.npmrc$/.test(f.path) && /_authToken\s*=\s*[A-Za-z0-9]/.test(f.text));
  c[72] = keyFiles.length || npmrcToken.length ? fail(`Credential files committed: ${list([...keyFiles, ...npmrcToken].map((f) => f.path))}.`, "Delete them from git history, rotate the credentials and load them from secret storage.") : pass("No private keys, service-account files or tokens are committed.");
  const monitor = anyDep(/sentry|datadog|bugsnag|rollbar|logrocket|newrelic|raygun|honeybadger|highlight/);
  c[73] = monitor ? pass(`Error monitoring dependency found (${monitor}).`) : skip("No error-monitoring dependency found in the repo.");
  const deploy = has(/^(?:vercel\.json|netlify\.toml|Dockerfile|fly\.toml|render\.yaml|railway\.json|\.github\/workflows\/.+)$/);
  c[74] = skip(`${deploy.length ? `Deploy config found (${list(deploy.map((f) => f.path))}). ` : "No deploy config found. "}Confirm in your host dashboard that a previous deployment can be restored.`);

  /* Legal and launch */
  c[75] = has(/(^|\/)(?:privacy|terms)[^/]*$|(^|\/)(?:privacy|terms)\//i).length ? pass("A privacy or terms page exists in source.") : skip("No privacy or terms page found in source.");
  const tracker = (all + [...deps].join(" ")).match(/googletagmanager|gtag\(|react-ga|mixpanel|posthog|amplitude|segment|hotjar|fbq\(|clarity\.ms|doubleclick/i)?.[0];
  const consent = /cookiebot|onetrust|osano|termly|iubenda|cookieyes|cookie-?consent|cookie-?banner|klaro|usercentrics|CookieBanner|ConsentBanner/i.test(all + [...deps].join(" "));
  c[76] = tracker && !consent ? fail(`Tracking code (${tracker}) with no cookie consent mechanism in source.`, "Add a consent banner and load analytics only after opt-in where the law requires it.") : tracker ? pass(`Tracking code (${tracker}) alongside a consent mechanism.`) : pass("No cookie-setting analytics or ad trackers in source.");
  c[77] = tracker && !consent ? fail(`${tracker} is wired in without a consent gate.`, "Gate analytics behind consent or use a cookieless analytics tool.") : tracker ? skip(`${tracker} found with consent code. Confirm it only loads after opt-in.`) : skip("No consent-dependent analytics found in source.");
  c[78] = /mailto:|href=["']\/contact|contact(?:-us)?\/page|tel:/i.test(all) || has(/(^|\/)contact/i).length ? pass("A contact email, phone link or contact page exists in source.") : skip("No contact link or page found in source.");
  const mail = anyDep(/^(resend|nodemailer|@sendgrid\/mail|postmark|mailgun|@aws-sdk\/client-ses|emailjs)/);
  c[79] = skip(mail ? `Email library ${mail} found. Send a real signup and reset email and check inbox placement, SPF and DKIM.` : "No email library found. Email delivery needs a real send if the app emails users.");
  const stripe = anyDep(/^(?:stripe|@stripe\/.+)$/);
  const webhook = code.filter((f) => /webhook/i.test(f.path));
  c[80] = stripe ? (webhook.some((f) => /constructEvent|stripe-signature|verifyWebhook|webhooks\.construct/.test(f.text)) ? pass("Stripe webhook handler verifies signatures. Test success, failure and refund flows with test cards.") : fail("Stripe is used but no webhook handler verifies signatures.", "Add a webhook route that verifies the Stripe signature before updating orders or access.")) : skip(anyDep(/paddle|lemonsqueezy|razorpay|paypal/) ? "Payment provider found. Test success, failure and webhook flows." : "No payment library found. Likely not applicable.");
  const sample = nonTest.filter((f) => isCode(f.path) || isMarkup(f.path)).filter((f) => !/seed|fixture|mock|sample|example|demo|story|stories/i.test(f.path) && /john doe|jane doe|test@(?:test|example)|admin@(?:admin|example)|password123|foo@bar/i.test(f.text)).map((f) => f.path);
  c[81] = sample.length ? fail(`Test accounts or sample data in ${list(sample)}.`, "Remove test accounts, sample records and fake contact details from production code.") : pass("No test accounts or sample data found in application code.");

  const homepage = meta.homepage && /^https?:\/\//i.test(meta.homepage) ? (meta.homepage as string) : undefined;
  return { verdicts: c, homepage, url: `https://github.com/${owner}/${repo}`, fileCount: files.length, readCount: text.length };
}
