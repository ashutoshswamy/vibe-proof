"use client";

import { useCallback, useEffect, useState, type ComponentType } from "react";
import { GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signInWithRedirect, signOut, type User } from "@firebase/auth";
import { ArrowRight, ArrowUpRight, Check, ClockCounterClockwise, CaretDown, Copy, FileText, GearSix, Gauge, Hand, Lightning, Link, Scan, SignOut, SquaresFour, UsersThree, Warning, type IconProps } from "@phosphor-icons/react";
import { getFirebaseAuth } from "@/lib/firebase-client";
import { Landing } from "./landing";
import { ProofGrid } from "./proof-grid";
import { Brand, Credit, ThemeToggle } from "./ui";

type Finding = { title: string; area: string; severity: "High" | "Medium" | "Low"; copy: string; evidence: string };
type Check = { id: number; section: string; title: string; status: "passed" | "failed" | "not_testable"; reason?: string };
type Scan = { id: string; url: string; score: number; findings: Finding[]; checks?: Check[]; checkedAt: string; statusCode?: number };
type LoadResult = { url: string; concurrency: number; duration: number; requests: number; succeeded: number; failed: number; errors: { message: string; count: number }[]; statusCounts: Record<string, number>; latencyMs: { min: number; p50: number; p95: number; max: number; avg: number }; requestsPerSecond: number; stoppedEarly: boolean };

const icons: Record<string, ComponentType<IconProps>> = { grid: SquaresFour, scan: Scan, report: FileText, history: ClockCounterClockwise, settings: GearSix, arrow: ArrowRight, out: ArrowUpRight, copy: Copy, link: Link, signout: SignOut, team: UsersThree, check: Check, alert: Warning, caret: CaretDown, manual: Hand, stress: Lightning, gauge: Gauge };
const label = (value: string) => { const u = new URL(value); return u.hostname === "github.com" ? u.pathname.slice(1) : u.host; };
function Icon({ name }: { name: string }) { const Glyph = icons[name] ?? FileText; return <Glyph aria-hidden="true" className="icon" size={16} weight="regular" />; }

export default function Home() {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [returning, setReturning] = useState<boolean | null>(null);
  const [active, setActive] = useState("Overview");
  const [url, setUrl] = useState("");
  const [scan, setScan] = useState<Scan | null>(null);
  const [scans, setScans] = useState<Scan[]>([]);
  const [selected, setSelected] = useState(0);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");

  const token = useCallback(async () => { if (!user) throw new Error("Sign in required"); return user.getIdToken(); }, [user]);
  const loadScans = useCallback(async (currentUser: User) => { try { const response = await fetch("/api/scans", { headers: { Authorization: `Bearer ${await currentUser.getIdToken()}` } }); const body = await response.json(); if (!response.ok) throw new Error(body.error); setScans(body); if (body[0]) { setScan(body[0]); setUrl(body[0].url); } } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to load scans"); } }, []);
  useEffect(() => { let hint = false; try { hint = localStorage.getItem("vp-auth") === "1"; } catch { /* storage blocked */ } delete document.documentElement.dataset.auth; queueMicrotask(() => setReturning(hint)); }, []);
  useEffect(() => { try { return onAuthStateChanged(getFirebaseAuth(), (next) => { setUser(next); setAuthReady(true); try { if (next) localStorage.setItem("vp-auth", "1"); else localStorage.removeItem("vp-auth"); } catch { /* storage blocked */ } if (next) void loadScans(next); }); } catch { queueMicrotask(() => { setAuthReady(true); setError("Firebase is not configured. Copy .env.example to .env.local and add your project keys."); }); } }, [loadScans]);
  async function runScan(event: React.FormEvent) { event.preventDefault(); setError(""); setRunning(true); try { const response = await fetch("/api/scans", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${await token()}` }, body: JSON.stringify({ url }) }); const body = await response.json(); if (!response.ok) throw new Error(body.error); setScan(body); setScans((current) => [body, ...current.filter((item) => item.id !== body.id)]); setSelected(0); } catch (cause) { setError(cause instanceof Error ? cause.message : "Scan failed"); } finally { setRunning(false); } }

  async function signIn() { setError(""); const provider = new GoogleAuthProvider(); try { await signInWithPopup(getFirebaseAuth(), provider); } catch (cause) { const code = (cause as { code?: string }).code; if (code === "auth/popup-blocked") { try { await signInWithRedirect(getFirebaseAuth(), provider); return; } catch (redirectCause) { setError(redirectCause instanceof Error ? redirectCause.message : "Sign-in failed"); return; } } if (code !== "auth/popup-closed-by-user" && code !== "auth/cancelled-popup-request") setError(cause instanceof Error ? cause.message : "Sign-in failed"); } }
  if (!authReady && returning === true) return <div className="boot"><Brand /><p>Loading secure workspace…</p></div>;
  if (!user) return <Landing onSignIn={signIn} error={error} />;

  const findings = scan?.findings ?? [];
  const current = findings[selected] ?? findings[0];
  const checks = scan?.checks ?? [];
  const passed = checks.filter((c) => c.status === "passed").length, failed = checks.filter((c) => c.status === "failed").length, manual = checks.length - passed - failed;
  const pct = (n: number) => (checks.length ? Math.max(4, Math.round((n / checks.length) * 100)) : 0);
  return <main className="shell"><aside className="sidebar"><Brand /><div className="workspace"><Icon name="team" />Mainframe Hustlers</div><nav aria-label="Main navigation"><p className="nav-label">Workspace</p>{["Overview", "New scan", "Stress test", "Reports", "History"].map((item, index) => <button key={item} className={`nav-item ${active === item ? "active" : ""}`} onClick={() => setActive(item)}><Icon name={index === 0 ? "grid" : index === 1 ? "scan" : index === 2 ? "stress" : index === 3 ? "report" : "history"} /><span className="nav-text">{item}</span>{item === "Reports" && <span className="nav-count">{scans.length}</span>}</button>)}<p className="nav-label nav-label-lower">Manage</p><button className={`nav-item ${active === "Settings" ? "active" : ""}`} onClick={() => setActive("Settings")}><Icon name="settings" /><span className="nav-text">Settings</span></button></nav><div className="sidebar-bottom"><div className="profile"><span className="avatar">{(user.displayName ?? user.email ?? "U").slice(0, 2).toUpperCase()}</span><div><strong>{user.displayName ?? user.email}</strong><small>Firebase account</small></div><button className="signout" aria-label="Sign out" onClick={() => signOut(getFirebaseAuth())}><Icon name="signout" /></button></div></div></aside>
    <section className="main-panel"><header className="topbar"><div className="crumb"><span>Workspace</span><b>/</b><strong>{active}</strong></div><ThemeToggle /></header>{active !== "Overview" && <PagePanel active={active} user={user} scans={scans} url={url} setUrl={setUrl} running={running} error={error} onScan={runScan} onSelect={(next) => { setScan(next); setUrl(next.url); setActive("Overview"); }} onSignOut={() => signOut(getFirebaseAuth())} />}<div className={`content ${active !== "Overview" ? "content-hidden" : ""}`}><div className="intro-row"><div><h1>Make your site <em>vibe-proof.</em></h1><p className="intro">Find what breaks. Understand the risk. Verify the fix.</p></div><button className="ghost-button" onClick={() => setActive("History")}><Icon name="history" /> {scans.length} saved scans</button></div>
      <section className="scan-card"><div className="scan-card-copy"><div className="pulse-ring"><Icon name="scan" /></div><div><h2>Start a new verification</h2><p>Fetches your staging page, checks headers and markup, saves evidence.</p></div></div><form className="url-form" onSubmit={runScan}><label htmlFor="url">Site URL or GitHub repo</label><div className="input-wrap"><Icon name="link" /><input id="url" type="url" required placeholder="https://your-site.com or https://github.com/you/repo" value={url} onChange={(e) => setUrl(e.target.value)} /><button disabled={running}>{running ? "Scanning…" : "Run check"}<Icon name="arrow" /></button></div><small>Public GitHub repos get a source review. Only scan sites you own or have permission to test.</small></form></section>
      {error && <p className="error-message page-error">{error}</p>}{scan ? <><div className="section-heading"><div><span className="label">Latest scan, {new Date(scan.checkedAt).toLocaleString()}</span><h2>{label(scan.url)}</h2></div><div className="score" style={{ "--score": scan.score, "--tone": scan.score >= 80 ? "var(--accent)" : "var(--amber)" } as React.CSSProperties}><strong>{scan.score}</strong><span>/ 100<br /><small>{scan.score >= 80 ? "Ready to ship" : "Needs review"}</small></span></div></div><div className="result-top">{checks.length ? <ProofGrid title="Scan result" meta={`${checks.length} checks in ${new Set(checks.map((c) => c.section)).size} areas`} checks={checks.map((c) => ({ id: c.id, section: c.section, title: c.title, reason: c.reason, status: c.status === "not_testable" ? "manual" : c.status }))} idle="Hover or tap a square to read the evidence for that check." /> : null}<div className="metric-grid"><Metric label="PASSED" state={`${passed} of ${checks.length}`} value={`${passed}`} width={`${pct(passed)}%`} note="Verified from the live URL" good /><Metric label="FAILED" state={failed ? "Fix first" : "Clear"} value={`${failed}`} width={`${pct(failed)}%`} note={`${findings.filter((f) => f.severity === "High").length} high risk`} good={!failed} /><Metric label="MANUAL" state="Needs a human" value={`${manual}`} width={`${pct(manual)}%`} note="Not testable from outside" tone="warning" /><Metric label="HTTP STATUS" state={scan.statusCode === 200 ? "Passed" : "Review"} value={`${scan.statusCode ?? "n/a"}`} width="100%" note="Fetched from target URL" good={scan.statusCode === 200} /></div></div><section className="findings-layout"><div className="findings-list"><div className="list-heading"><div><h2>What needs attention</h2></div></div>{findings.length ? findings.map((finding, index) => <button key={`${finding.title}-${index}`} className={`finding ${selected === index ? "selected" : ""}`} onClick={() => setSelected(index)}><span className={`finding-icon ${finding.severity === "High" ? "high" : "medium"}`}><Icon name={finding.severity === "High" ? "alert" : "report"} /></span><span className="finding-content"><strong>{finding.title}</strong><span>{finding.area} · {finding.evidence}</span></span><span className={`severity ${finding.severity.toLowerCase()}`}>{finding.severity}</span><Icon name="arrow" /></button>) : <div className="empty-state">No issues found in current checks.</div>}</div><div className="repair-panel"><div className="repair-head"><span className="label">Fix guidance</span><span className="live-pill">Evidence saved</span></div>{current ? <><h2>{current.title}</h2><p>{current.copy}</p><div className="evidence"><span className="evidence-pin"><Icon name="report" /></span><div><small>Observed evidence</small><strong>{current.evidence}</strong></div></div><div className="repair-divider" /><span className="label">Next action</span><div className="next-action"><div><strong>Apply repair prompt</strong><p>Copy a scoped fix into your coding tool.</p></div><button onClick={() => navigator.clipboard?.writeText(`Fix: ${current.title}. ${current.copy}`)} aria-label="Copy repair prompt"><Icon name="copy" /></button></div><button className="prompt-button" onClick={() => navigator.clipboard?.writeText(`Fix: ${current.title}. ${current.copy}`)}>Copy repair prompt<Icon name="copy" /></button></> : <div className="empty-state">Select a finding after your next scan.</div>}</div></section>{checks.length ? <Checklist checks={checks} /> : null}</> : <div className="empty-dashboard"><span className="pulse-ring"><Icon name="scan" /></span><h2>No scan yet</h2><p>Enter a URL above to create your first persisted verification report.</p></div>}<p className="disclaimer">VibeProof flags potential gaps for human review. It is not a security certification or legal compliance guarantee.</p><Credit /></div></section></main>;
}

function Metric({ label, state, value, width, note, good, tone }: { label: string; state: string; value: string; width: string; note: string; good?: boolean; tone?: "warning" }) { return <div className="metric-card"><div className="metric-top"><span>{label}</span><span className={`metric-state ${tone ?? (good ? "good" : "danger")}`}>{state}</span></div><div className="metric-bar"><i className={tone === "warning" ? "warning-bar" : good ? "good-bar" : ""} style={{ width }} /></div><strong>{value}</strong><small>{note}</small></div>; }

function PagePanel({ active, user, scans, url, setUrl, running, error, onScan, onSelect, onSignOut }: { active: string; user: User; scans: Scan[]; url: string; setUrl: (value: string) => void; running: boolean; error: string; onScan: (event: React.FormEvent) => void; onSelect: (scan: Scan) => void; onSignOut: () => void }) {
  if (active === "Stress test") return <StressTestPanel user={user} />;
  if (active === "New scan") return <div className="secondary-page"><h1>Check a site <em>or repo.</em></h1><p className="intro">Run the bounded verification suite and save its evidence to Neon.</p><form className="new-scan-form" onSubmit={onScan}><label htmlFor="new-scan-url">Site URL or GitHub repo</label><div className="input-wrap"><Icon name="link" /><input id="new-scan-url" type="url" required value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://your-site.com or https://github.com/you/repo" /><button disabled={running}>{running ? "Scanning…" : "Run check"}<Icon name="arrow" /></button></div><small>Public GitHub repos get a source review. Only scan sites you own or have permission to test.</small></form>{error && <p className="error-message page-error">{error}</p>}</div>;
  if (active === "Reports") return <div className="secondary-page"><h1>Your verification <em>reports.</em></h1><p className="intro">Saved findings from Neon, newest first.</p><div className="report-grid">{scans.length ? scans.map((item) => <button className="report-card" key={item.id} onClick={() => onSelect(item)}><span><strong>{label(item.url)}</strong><small>{new Date(item.checkedAt).toLocaleString()}</small></span><b className={item.score >= 80 ? "score-good" : "score-warn"}>{item.score}<small>/100</small></b><Icon name="arrow" /></button>) : <div className="empty-state">No reports yet. Run your first scan.</div>}</div></div>;
  if (active === "History") return <div className="secondary-page"><h1>Every check, <em>traceable.</em></h1><p className="intro">Choose a saved run to reopen its evidence feed.</p><div className="history-list">{scans.length ? scans.map((item) => <button className="history-row" key={item.id} onClick={() => onSelect(item)}><span><strong>{label(item.url)}</strong><small>{new Date(item.checkedAt).toLocaleString()}</small></span><b>{item.findings.length} findings</b><Icon name="arrow" /></button>) : <div className="empty-state">No scan history yet.</div>}</div></div>;
  return <div className="secondary-page settings-page"><h1>Workspace <em>settings.</em></h1><p className="intro">Your auth and data connection status.</p><div className="settings-card"><div className="settings-row"><span className="avatar">{(user.displayName ?? user.email ?? "U").slice(0, 2).toUpperCase()}</span><div><strong>{user.displayName ?? "Firebase user"}</strong><small>{user.email}</small></div></div><div className="settings-row"><span className="setting-icon"><Icon name="check" /></span><div><strong>Firebase Authentication</strong><small>Google sign-in is active for this account.</small></div><span className="live-pill">CONNECTED</span></div><div className="settings-row"><span className="setting-icon"><Icon name="check" /></span><div><strong>Neon database</strong><small>{scans.length} saved report{scans.length === 1 ? "" : "s"} available.</small></div><span className="live-pill">CONNECTED</span></div><button className="ghost-button" onClick={onSignOut}>Sign out</button></div></div>;
}

const statusLabel = { passed: "Passed", failed: "Failed", not_testable: "Manual" } as const;

function Checklist({ checks }: { checks: Check[] }) {
  const groups = [...checks.reduce((map, check) => map.set(check.section, [...(map.get(check.section) ?? []), check]), new Map<string, Check[]>())];
  const count = (items: Check[], status: Check["status"]) => items.filter((check) => check.status === status).length;
  return <section className="checklist"><div className="list-heading"><h2>Full checklist</h2><p>{checks.length} checks. Passed and failed results come from the live URL. Manual checks need source access, accounts or a browser.</p></div>{groups.map(([section, items]) => <details key={section} className="check-group" open={count(items, "failed") > 0}><summary><strong>{section}</strong><span className="check-tally">{count(items, "passed")} passed, {count(items, "failed")} failed, {count(items, "not_testable")} manual</span><Icon name="caret" /></summary><ul>{items.map((check) => <li key={check.id} className={`check ${check.status}`}><span className="check-badge"><Icon name={check.status === "passed" ? "check" : check.status === "failed" ? "alert" : "manual"} /></span><span className="check-body"><strong>{check.title}</strong>{check.reason && <small>{check.reason}</small>}</span><span className="check-state">{statusLabel[check.status]}</span></li>)}</ul></details>)}</section>;
}

function StressTestPanel({ user }: { user: User }) {
  const [url, setUrl] = useState("");
  const [concurrency, setConcurrency] = useState(5);
  const [durationSeconds, setDurationSeconds] = useState(4);
  const [confirmed, setConfirmed] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<LoadResult | null>(null);

  async function run(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setRunning(true);
    try {
      const token = await user.getIdToken();
      const response = await fetch("/api/loadtest", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ url, concurrency, durationMs: durationSeconds * 1000, confirmAuthorized: confirmed }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error);
      setResult(body);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Load test failed");
    } finally {
      setRunning(false);
    }
  }

  const errorRate = result && result.requests ? Math.round((result.failed / result.requests) * 100) : 0;
  const successPct = result && result.requests ? Math.round((result.succeeded / result.requests) * 100) : 0;
  const presets = [{ name: "Light", c: 2, d: 3 }, { name: "Medium", c: 5, d: 4 }, { name: "Heavy", c: 8, d: 8 }];
  const fill = (value: number) => ({ "--fill": `${((value - 1) / 7) * 100}%` }) as React.CSSProperties;
  const verdict = !result ? undefined : result.stoppedEarly ? { tone: "bad", text: "The site started failing under load, so the run stopped after repeated errors." } : errorRate === 0 && result.latencyMs.p95 <= 1000 ? { tone: "ok", text: `All ${result.requests} requests succeeded. The slowest 5% took ${result.latencyMs.p95} ms or longer.` } : errorRate === 0 ? { tone: "warn", text: `All ${result.requests} requests succeeded, but the slowest 5% took ${result.latencyMs.p95} ms or longer.` } : { tone: errorRate >= 20 ? "bad" : "warn", text: `${result.failed} of ${result.requests} requests failed (${errorRate}%). Check the errors below.` };

  return <div className="secondary-page"><h1>Stress test <em>a URL.</em></h1><p className="intro">Send a short burst of concurrent requests to see latency and errors under load.</p>
    <form className="stress-form" onSubmit={run}>
      <label htmlFor="stress-url">Site URL</label>
      <div className="input-wrap"><Icon name="link" /><input id="stress-url" type="url" required value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://your-site.com" /><button disabled={running || !confirmed}>{running ? "Running…" : "Run test"}<Icon name="gauge" /></button></div>
      <div className="stress-grid">
        <fieldset className="stress-field"><legend>Intensity</legend><div className="stress-presets" role="group" aria-label="Intensity presets">{presets.map((preset) => <button type="button" key={preset.name} aria-pressed={concurrency === preset.c && durationSeconds === preset.d} className={concurrency === preset.c && durationSeconds === preset.d ? "active" : undefined} onClick={() => { setConcurrency(preset.c); setDurationSeconds(preset.d); }}>{preset.name}</button>)}</div><small>Light is 2 at once for 3s. Heavy is 8 at once for 8s.</small></fieldset>
        <div className="stress-field"><label htmlFor="stress-concurrency">Concurrent requests<b>{concurrency}</b></label><input id="stress-concurrency" type="range" min={1} max={8} value={concurrency} style={fill(concurrency)} onChange={(event) => setConcurrency(Number(event.target.value))} /><small>How many requests are in flight together.</small></div>
        <div className="stress-field"><label htmlFor="stress-duration">Duration<b>{durationSeconds}s</b></label><input id="stress-duration" type="range" min={1} max={8} value={durationSeconds} style={fill(durationSeconds)} onChange={(event) => setDurationSeconds(Number(event.target.value))} /><small>How long the burst keeps going.</small></div>
      </div>
      <div className="stress-foot">
        <label className="stress-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>I own this site or have permission to test it.</span></label>
        <p className="stress-limits-line">Limits: 8 at once, 8s per run, one run per site every 2 minutes, 15 runs a day.</p>
      </div>
    </form>
    {error && <p className="error-message page-error">{error}</p>}
    {running && <div className="stress-loading" aria-live="polite"><div className="stress-loading-head"><span className="pulse-ring"><Icon name="gauge" /></span><div><h2>Sending requests</h2><p>{concurrency} at once for up to {durationSeconds}s.</p></div></div><div className="stress-progress"><i style={{ animationDuration: `${durationSeconds}s` }} /></div><div className="metric-grid">{[0, 1, 2, 3].map((n) => <div key={n} className="metric-card skeleton"><span /><span /><span /></div>)}</div></div>}
    {!running && result && verdict && <>
      <div className={`stress-verdict ${verdict.tone}`} role="status"><span className="stress-verdict-icon"><Icon name={verdict.tone === "ok" ? "check" : "alert"} /></span><div><strong>{(() => { try { return new URL(result.url).host; } catch { return result.url; } })()}</strong><p>{verdict.text}</p></div><span className="stress-verdict-meta">{result.concurrency} at once for {(result.duration / 1000).toFixed(0)}s</span></div>
      <div className="metric-grid">
        <Metric label="REQUESTS" state={`${result.requestsPerSecond}/s`} value={`${result.requests}`} width="100%" note="Total sent in this run" good />
        <Metric label="SUCCEEDED" state={`${successPct}%`} value={`${result.succeeded}`} width={`${successPct}%`} note="2xx or 3xx responses" good />
        <Metric label="FAILED" state={errorRate ? `${errorRate}% error rate` : "Clear"} value={`${result.failed}`} width={`${errorRate}%`} note="Timed out, errored, or 4xx/5xx" good={!result.failed} />
        <Metric label="P95 LATENCY" state={result.latencyMs.p95 > 1000 ? "Slow" : "Fast"} value={`${result.latencyMs.p95}`} width="100%" note="ms, 95th percentile" good={result.latencyMs.p95 <= 1000} />
      </div>
      <section className="findings-layout stress-layout">
        <div className="findings-list">
          <div className="list-heading"><div><h2>Latency breakdown</h2></div></div>
          <div className="stress-latency">
            <div><strong>{result.latencyMs.min}</strong><small>Min (ms)</small></div>
            <div><strong>{result.latencyMs.avg}</strong><small>Avg (ms)</small></div>
            <div><strong>{result.latencyMs.p50}</strong><small>Median (ms)</small></div>
            <div className={result.latencyMs.p95 > 1000 ? "hot" : undefined}><strong>{result.latencyMs.p95}</strong><small>P95 (ms)</small></div>
            <div className={result.latencyMs.max > 1500 ? "hot" : undefined}><strong>{result.latencyMs.max}</strong><small>Max (ms)</small></div>
          </div>
          {!!Object.keys(result.statusCounts).length && <div className="stress-statuses">{Object.entries(result.statusCounts).map(([bucket, count]) => <span key={bucket} className={`stress-status ${bucket.startsWith("2") || bucket.startsWith("3") ? "ok" : "bad"}`}>{bucket}: {count} responses</span>)}</div>}
        </div>
        <div className="repair-panel">
          <div className="repair-head"><span className="label">Errors</span><span className="live-pill">{result.errors.length ? `${result.errors.reduce((sum, e) => sum + e.count, 0)} seen` : "None"}</span></div>
          {result.errors.length ? <ul className="stress-error-list">{result.errors.map((e) => <li key={e.message}><span className="finding-icon high"><Icon name="alert" /></span><span className="finding-content"><strong>{e.message}</strong><span>{e.count} occurrence{e.count === 1 ? "" : "s"}</span></span></li>)}</ul> : <div className="empty-state">No request errors in this run.</div>}
        </div>
      </section>
    </>}
    {!running && !result && !error && <div className="empty-dashboard"><span className="pulse-ring"><Icon name="gauge" /></span><h2>No run yet</h2><p>Enter a URL, confirm you can test it, then pick an intensity.</p></div>}
  </div>;
}
