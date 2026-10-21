"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUpRight, Check, Copy } from "@phosphor-icons/react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { createChecklist } from "@/lib/checklist";
import { ProofGrid, type ProofCheck } from "./proof-grid";
import { Brand, Credit, ThemeToggle, Wordmark } from "./ui";

const SAMPLE_FAILED = new Set([9, 16, 25, 42, 44, 45, 46, 50, 56, 75, 78]);
const SAMPLE_MANUAL = new Set([4, 6, 10, 12, 15, 19, 20, 21, 22, 27, 28, 29, 30, 31, 33, 34, 38, 59, 60, 61, 62, 63, 79, 80]);
const repairPrompt = "Add a Content-Security-Policy response header. Restrict scripts, styles, connections and frame sources to the origins this app actually needs. Test sign-in and third-party integrations, then rerun the scan.";

function Checks() {
  const sections = useMemo(() => {
    const map = new Map<string, { id: number; title: string }[]>();
    for (const check of createChecklist()) map.set(check.section, [...(map.get(check.section) ?? []), check]);
    return [...map.entries()];
  }, []);
  return <div className="check-index">{sections.map(([name, checks], index) => <details key={name} name="check-areas" open={index === 0 ? true : undefined}>
    <summary><span>{name}</span><span className="check-count">{checks.length} checks</span><span className="disclosure-mark" aria-hidden="true">+</span></summary>
    <ul>{checks.map(check => <li key={check.id}><Check size={18} aria-hidden="true" />{check.title}</li>)}</ul>
  </details>)}</div>;
}

function SampleReport() {
  const checks = useMemo<ProofCheck[]>(() => createChecklist().map(check => ({ ...check, status: SAMPLE_FAILED.has(check.id) ? "failed" : SAMPLE_MANUAL.has(check.id) ? "manual" : "passed" })), []);
  return <ProofGrid checks={checks} title="An example launch report" meta="Illustrative results" idle="Choose a check to see what it verifies." />;
}

function RepairExample() {
  const [message, setMessage] = useState("");
  async function copy() {
    try { await navigator.clipboard.writeText(repairPrompt); setMessage("Prompt copied."); }
    catch { setMessage("Copy is unavailable. Select the prompt text to copy it."); }
  }
  return <div className="repair-example" data-ui>
    <div className="example-caption"><span>Example finding</span><span className="example-status">Needs attention</span></div>
    <h3>Missing CSP header.</h3>
    <dl><div><dt>Observed</dt><dd>No Content-Security-Policy header in the response.</dd></div><div><dt>Next action</dt><dd>{repairPrompt}</dd></div></dl>
    <button type="button" onClick={copy}>Copy fix prompt<Copy size={18} aria-hidden="true" /></button>
    <p className="copy-status" role="status">{message}</p>
  </div>;
}

export function Landing({ onSignIn, error }: { onSignIn: () => void; error: string }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    gsap.registerPlugin(ScrollTrigger);
    const navigation = ["report", "checks", "workflow"].map(id => {
      const link = root.current?.querySelector(`nav a[href="#${id}"]`);
      return ScrollTrigger.create({ trigger: `#${id}`, start: "top 35%", end: "bottom 35%", onToggle: self => {
        if (self.isActive) link?.setAttribute("aria-current", "location");
        else link?.removeAttribute("aria-current");
      } });
    });
    const media = gsap.matchMedia();
    media.add("(prefers-reduced-motion: no-preference)", () => {
      gsap.from(".lp-nav", { y: -28, opacity: 0, duration: 0.8, ease: "power3.out", clearProps: "all" });
      gsap.from(".hero-line > span", { yPercent: 105, duration: 1.05, stagger: 0.1, ease: "power3.out", clearProps: "all" });
      gsap.from(".hero-bottom > *", { y: 20, opacity: 0, duration: 0.65, stagger: 0.08, delay: 0.25, clearProps: "all" });
      gsap.utils.toArray<HTMLElement>("[data-reveal]").forEach(section => {
        gsap.from(section.children, { y: 24, opacity: 0, duration: 0.7, stagger: 0.08, ease: "power2.out", clearProps: "all", scrollTrigger: { trigger: section, start: "top 90%", once: true } });
      });
      gsap.fromTo(".report-stage", { y: 35, rotation: -2 }, { y: -20, rotation: 1, ease: "none", scrollTrigger: { trigger: ".report-section", start: "top bottom", end: "bottom top", scrub: true } });
      gsap.from(".lp-grid button", { scale: 0.35, opacity: 0, duration: 0.6, stagger: { amount: 0.9, from: "center" }, ease: "back.out(1.4)", clearProps: "all", scrollTrigger: { trigger: ".lp-grid", start: "top 85%", once: true } });
      gsap.to(".hero-line", { xPercent: index => index === 0 ? -3 : 3, y: -30, ease: "none", scrollTrigger: { trigger: ".lp-hero", start: "top top", end: "bottom top", scrub: 0.6 } });
      const wordmark = gsap.timeline({ scrollTrigger: { trigger: ".lp-footer", start: "top 95%", end: "bottom bottom", scrub: 0.7 } });
      wordmark.from(".footer-wordmark .brand-vibe", { xPercent: -12, yPercent: 24, rotation: -5, ease: "none" }, 0)
        .from(".footer-wordmark .brand-accent", { xPercent: 12, yPercent: 24, rotation: 5, ease: "none" }, 0);
    }, root);
    return () => { media.revert(); navigation.forEach(trigger => trigger.kill()); };
  }, []);

  const notice = error.startsWith("Firebase is not configured.") ? "Sign-in is unavailable in this preview. Explore the sample report and checks below." : error;
  return <div className="lp" ref={root}>
    <a className="skip-link" href="#main-content">Skip to content</a>
    <header className="lp-nav lp-wrap">
      <a href="#" className="home-link" aria-label="VibeProof home"><Brand /></a>
      <nav aria-label="Page sections"><a href="#report">The report</a><a href="#workflow">How it works</a><a href="#checks">The checks</a></nav>
      <div className="lp-nav-actions"><ThemeToggle /><button className="nav-signin" type="button" onClick={onSignIn}>Sign in<ArrowUpRight size={18} aria-hidden="true" /></button></div>
    </header>
    <main id="main-content" tabIndex={-1}>
      <section className="lp-hero lp-wrap" aria-labelledby="hero-title">
        <h1 id="hero-title"><span className="hero-line"><span>Good vibes.</span></span><span className="hero-line"><span>Real proof.</span></span></h1>
        <div className="hero-bottom">
          <div className="hero-description"><p>82 launch checks for your site or repo. Find the gaps. Know what to fix.</p><a className="text-link" href="#report">Take a look inside<ArrowDown size={18} aria-hidden="true" /></a></div>
          <button className="lp-primary" type="button" onClick={onSignIn}>Check your site<ArrowUpRight size={22} aria-hidden="true" /><span>Continue with Google</span></button>
        </div>
        {notice && <p className="lp-notice" role="status">{notice}</p>}
      </section>

      <section className="report-section" id="report" aria-labelledby="report-title">
        <div className="lp-wrap report-intro" data-reveal><h2 id="report-title">Looks good.<br />Now check.</h2><p>Explore a sample. Select a square to see the check behind it.</p></div>
        <div className="lp-wrap report-layout">
          <div className="report-aside" data-reveal><div className="giant-number">82</div><span className="giant-caption">checks. Nothing hidden.</span><a className="text-link" href="#checks">See the full checklist<ArrowDown size={18} aria-hidden="true" /></a></div>
          <div className="report-stage" data-reveal><SampleReport /></div>
        </div>
      </section>

      <section className="lp-wrap workflow" id="workflow" aria-labelledby="workflow-title">
        <div className="section-intro" data-reveal><h2 id="workflow-title">Find it.<br />Then fix it.</h2><p>Scan. Review the evidence. Fix what matters.</p></div>
        <article className="workflow-row" data-reveal>
          <div className="workflow-copy"><h3>Look beneath<br />the surface.</h3><p>Check pages, headers, accessibility, and exposed files. Add a GitHub repo to review the source too.</p></div>
          <div className="source-example" data-ui><div className="example-caption"><span>What a scan reads</span><span>Site + source</span></div><div className="source-address">your-site.com<ArrowUpRight aria-hidden="true" size={24} /></div><dl><div><dt>Live website</dt><dd>Pages · headers · scripts · styles</dd></div><div><dt>GitHub repository</dt><dd>Source files · routes · dependencies</dd></div><div><dt>One review</dt><dd>Add your site to the repository’s website field to scan both together.</dd></div></dl></div>
        </article>
        <article className="workflow-row reverse" data-reveal><div className="workflow-copy"><h3>Less guessing.<br />More fixing.</h3><p>Get the evidence and a fix prompt. Paste it into your coding tool, make the change, and scan again.</p></div><RepairExample /></article>
        <article className="workflow-row" data-reveal><div className="workflow-copy"><h3>Put it under<br />a little pressure.</h3><p>Test a site you own with a short burst of requests. See slow responses and errors before real traffic arrives.</p></div><div className="load-example" data-ui><div className="example-caption"><span>Stress test</span><span>Available run limits</span></div><div className="load-numbers"><div><strong>8</strong><span>concurrent requests</span></div><div><strong>8s</strong><span>maximum duration</span></div></div><p>Results include median and p95 latency, requests per second, and failed responses.</p><span className="example-note">Test only sites you own or have permission to test.</span></div></article>
      </section>

      <section className="checks-section lp-wrap" id="checks" aria-labelledby="checks-title">
        <div className="section-intro" data-reveal><h2 id="checks-title">The whole<br />checklist.</h2><p>Ten areas. Open one to explore the checks.</p></div>
        <Checks />
      </section>

      <section className="honesty-section lp-wrap" aria-labelledby="honesty-title">
        <div data-reveal><h2 id="honesty-title">Proof has limits.</h2><p className="honesty-lede">See what was verified, what failed, and what still needs a person.</p></div>
        <dl className="result-definitions" data-reveal><div><dt>Passed</dt><dd>Observed on the live site or in the source.</dd></div><div><dt>Failed</dt><dd>Evidence of a problem, with a fix prompt.</dd></div><div><dt>Manual</dt><dd>Needs an account, a database, or a human check. Marked, never guessed.</dd></div></dl>
      </section>

      <section className="final-section" aria-labelledby="final-title"><div className="lp-wrap" data-reveal><h2 id="final-title">Ship with proof.</h2><div className="final-bottom"><p>Keep the momentum.<br />Check the work.</p><button className="lp-primary" type="button" onClick={onSignIn}>Run your first scan<ArrowUpRight size={22} aria-hidden="true" /><span>Continue with Google to save your reports</span></button></div></div></section>
    </main>
    <footer className="lp-footer lp-wrap"><div className="footer-top"><Credit /><a className="text-link" href="#main-content">Back to top<ArrowUpRight size={18} aria-hidden="true" /></a><p>Potential gaps for human review.<br />Not a security certification.</p></div><div className="footer-wordmark" aria-label="VibeProof"><Wordmark /></div></footer>
  </div>;
}
