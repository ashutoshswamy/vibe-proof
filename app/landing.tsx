"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowRight, Check, ClipboardText, GithubLogo, Globe, Hand, Lightning, Warning } from "@phosphor-icons/react";
import { createChecklist } from "@/lib/checklist";
import { ProofGrid, type ProofCheck } from "./proof-grid";
import { Brand, Credit, ThemeToggle } from "./ui";

/* Illustrative outcome for the hero grid. The check titles are the real checklist. */
const SAMPLE_FAILED = new Set([9, 16, 25, 42, 44, 45, 46, 50, 56, 75, 78]);
const SAMPLE_MANUAL = new Set([4, 6, 10, 12, 15, 19, 20, 21, 22, 27, 28, 29, 30, 31, 33, 34, 38, 59, 60, 61, 62, 63, 79, 80]);

/** Content is visible by default. Only blocks below the fold are hidden after hydration, then revealed on scroll. */
function Reveal({ children, className = "" }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !("IntersectionObserver" in window) || el.getBoundingClientRect().top < window.innerHeight * 0.9) return;
    el.classList.add("pending");
    const io = new IntersectionObserver(([entry]) => { if (entry.isIntersecting) { el.classList.remove("pending"); io.disconnect(); } }, { threshold: 0.12 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return <div ref={ref} className={`lp-reveal ${className}`}>{children}</div>;
}

function useSections() {
  return useMemo(() => {
    const map = new Map<string, { id: number; title: string }[]>();
    for (const check of createChecklist()) map.set(check.section, [...(map.get(check.section) ?? []), { id: check.id, title: check.title }]);
    return [...map.entries()].map(([name, checks]) => ({ name, checks }));
  }, []);
}

function SampleGrid() {
  const checks = useMemo<ProofCheck[]>(() => createChecklist().map((check) => ({ id: check.id, section: check.section, title: check.title, status: SAMPLE_FAILED.has(check.id) ? "failed" : SAMPLE_MANUAL.has(check.id) ? "manual" : "passed" })), []);
  return <ProofGrid checks={checks} title="Sample scan" meta="82 checks in 10 areas" />;
}

function Checks() {
  const sections = useSections();
  const [open, setOpen] = useState(0);
  const current = sections[open];
  function onKey(event: React.KeyboardEvent) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const next = (open + (event.key === "ArrowDown" ? 1 : sections.length - 1)) % sections.length;
    setOpen(next);
    document.getElementById(`lp-tab-${next}`)?.focus();
  }
  return <div className="lp-tabs">
    <div className="lp-tablist" role="tablist" aria-orientation="vertical" aria-label="Check areas" onKeyDown={onKey}>
      {sections.map((section, index) => <button key={section.name} id={`lp-tab-${index}`} role="tab" type="button" aria-selected={open === index} aria-controls="lp-panel" tabIndex={open === index ? 0 : -1} className={open === index ? "active" : undefined} onClick={() => setOpen(index)}><span>{section.name}</span><b>{section.checks.length}</b></button>)}
    </div>
    <div className="lp-panel" id="lp-panel" role="tabpanel" aria-labelledby={`lp-tab-${open}`}>
      <h3>{current.name}</h3>
      <ul>{current.checks.map((check) => <li key={check.id}><Check className="icon" aria-hidden="true" size={16} weight="bold" />{check.title.replace(/\.$/, "")}</li>)}</ul>
    </div>
  </div>;
}

export function Landing({ onSignIn, error }: { onSignIn: () => void; error: string }) {
  return <div className="lp">
    <header className="lp-nav"><div className="lp-wrap lp-nav-row"><Brand /><nav aria-label="Page sections"><a href="#checks">What it checks</a><a href="#ways">Ways to scan</a></nav><div className="lp-nav-actions"><ThemeToggle /><button className="prompt-button lp-cta" onClick={onSignIn}>Continue with Google<ArrowRight size={16} aria-hidden="true" /></button></div></div></header>

    <main>
      <section className="lp-hero lp-wrap">
        <div className="lp-hero-copy">
          <h1>Verify before you <em>ship.</em></h1>
          <p>Scan a site or GitHub repo against 82 launch checks. Every finding comes with evidence and a fix prompt.</p>
          <div className="lp-hero-actions"><button className="prompt-button lp-cta" onClick={onSignIn}>Continue with Google<ArrowRight size={16} aria-hidden="true" /></button><a className="ghost-button" href="#checks">See the checks</a></div>
          {error && <p className="error-message">{error}</p>}
        </div>
        <SampleGrid />
      </section>

      <section className="lp-section lp-wrap" id="checks">
        <Reveal><h2>Ten areas, 82 checks.</h2><p className="lp-lede">Pick an area to read exactly what gets checked.</p></Reveal>
        <Reveal><Checks /></Reveal>
      </section>

      <section className="lp-section lp-wrap" id="ways">
        <Reveal><h2>Check the live site, the code, or both.</h2><p className="lp-lede">Give a repo a website on GitHub and both reviews run together.</p></Reveal>
        <Reveal className="lp-bento">
          <article className="lp-tile live"><Globe size={28} aria-hidden="true" /><h3>Scan a live site</h3><p>Fetches the page, linked pages, scripts and styles. Reads headers, cookies, SEO tags, accessibility markup and files left exposed.</p></article>
          <article className="lp-tile repo"><GithubLogo size={28} aria-hidden="true" /><h3>Review a GitHub repo</h3><p>Reads every text file on the default branch. Flags committed secrets, unprotected routes, broken imports and missing tests.</p></article>
          <article className="lp-tile stress"><Lightning size={28} aria-hidden="true" /><h3>Stress test a URL</h3><p>A short, capped burst of requests that reports latency and errors. One run per site every two minutes.</p></article>
          <article className="lp-tile fix"><ClipboardText size={28} aria-hidden="true" /><h3>Fix prompts included</h3><p>Each failed check shows the evidence it saw and a prompt you can paste into your coding tool. Rerun the same URL to confirm the fix.</p></article>
        </Reveal>
      </section>

      <section className="lp-section lp-wrap">
        <Reveal>
          <h2>Passed means observed. Manual means yours.</h2>
          <p className="lp-lede">A scan cannot prove your app is secure. VibeProof shows what it verified from the outside, what failed, and what still needs a person.</p>
          <dl className="lp-defs">
            <div><dt><Check size={18} weight="bold" aria-hidden="true" />Passed</dt><dd>Observed on the live site or in the source.</dd></div>
            <div><dt><Warning size={18} weight="bold" aria-hidden="true" />Failed</dt><dd>Evidence found, with a fix prompt.</dd></div>
            <div><dt><Hand size={18} weight="bold" aria-hidden="true" />Manual</dt><dd>Needs an account, a database or a browser. Marked, never guessed.</dd></div>
          </dl>
        </Reveal>
      </section>

      <section className="lp-wrap lp-final">
        <Reveal className="lp-final-card">
          <h2>Run your first scan.</h2>
          <p>Sign in with Google to save reports and rerun checks after each fix.</p>
          <button className="prompt-button lp-cta" onClick={onSignIn}>Continue with Google<ArrowRight size={16} aria-hidden="true" /></button>
        </Reveal>
      </section>
    </main>

    <footer className="lp-footer"><div className="lp-wrap lp-footer-row"><Brand /><Credit /><p>VibeProof flags potential gaps for human review. It is not a security certification or legal compliance guarantee.</p></div></footer>
  </div>;
}
