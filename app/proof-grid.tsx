"use client";

import { useState, type KeyboardEvent } from "react";

export type ProofStatus = "passed" | "failed" | "manual";
export type ProofCheck = { id: number; section: string; title: string; status: ProofStatus; reason?: string };

const statusWord: Record<ProofStatus, string> = { passed: "Passed", failed: "Failed", manual: "Manual" };

/** One square per check, one column per area. Used for the landing sample and for real scan results. */
export function ProofGrid({ checks, title, meta, idle = "Hover a square to read the check behind it." }: { checks: ProofCheck[]; title: string; meta: string; idle?: string }) {
  const [active, setActive] = useState<ProofCheck | null>(null);
  function moveFocus(event: KeyboardEvent<HTMLButtonElement>) {
    const buttons = Array.from(event.currentTarget.parentElement!.querySelectorAll("button"));
    const index = buttons.indexOf(event.currentTarget);
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : event.key === "ArrowRight" || event.key === "ArrowDown" ? (index + 1) % buttons.length : event.key === "ArrowLeft" || event.key === "ArrowUp" ? (index + buttons.length - 1) % buttons.length : null;
    if (next !== null) { event.preventDefault(); buttons[next].focus(); }
  }
  const sections = [...checks.reduce((map, check) => map.set(check.section, [...(map.get(check.section) ?? []), check]), new Map<string, ProofCheck[]>())].map(([name, items]) => ({ name, items }));
  const rows = Math.max(1, ...sections.map((section) => section.items.length));
  const counts: Record<ProofStatus, number> = { passed: 0, failed: 0, manual: 0 };
  for (const check of checks) counts[check.status]++;
  let order = 0;
  const cells = sections.flatMap((section) => Array.from({ length: rows }, (_, row) => {
    const check = section.items[row];
    if (!check) return <span key={`${section.name}-${row}`} className="lp-cell blank" aria-hidden="true" />;
    return <button type="button" key={check.id} className={`lp-cell ${check.status}${active?.id === check.id ? " on" : ""}`} style={{ "--d": `${order++ * 16}ms` } as React.CSSProperties} aria-label={`${statusWord[check.status]}: ${check.title}`} tabIndex={(active?.id ?? checks[0]?.id) === check.id ? 0 : -1} onKeyDown={moveFocus} onFocus={() => setActive(check)} onPointerEnter={() => setActive(check)} onClick={() => setActive(check)} />;
  }));
  return <figure className="lp-proof" data-ui aria-label={`${title}: ${checks.length} checks, ${counts.passed} passed, ${counts.failed} failed, ${counts.manual} manual`}>
    <div className="lp-proof-head"><strong>{title}</strong><span>{meta}</span></div>
    <div className="lp-grid" style={{ "--rows": rows, "--cols": sections.length } as React.CSSProperties} onPointerLeave={(event) => { if (event.pointerType === "mouse") setActive(null); }}>{cells}</div>
    <div className="lp-readout" aria-live="polite">{active ? <><span className={`lp-chip ${active.status}`}>{statusWord[active.status]}</span><span><b>{active.section}</b>: {active.title.replace(/\.$/, "")}{active.reason && <small>{active.reason}</small>}</span></> : <span className="lp-readout-idle">{idle}</span>}</div>
    <figcaption className="lp-legend"><span className="passed"><i />{counts.passed} passed</span><span className="failed"><i />{counts.failed} failed</span><span className="manual"><i />{counts.manual} manual</span></figcaption>
  </figure>;
}
