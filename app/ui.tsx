"use client";

import { Moon, Sun } from "@phosphor-icons/react";

export function Wordmark() {
  return <span className="wordmark"><span className="brand-vibe">vibe</span><span className="brand-accent">proof</span></span>;
}

export function Brand() {
  return <div className="brand"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span><Wordmark /></div>;
}

/** The inline script in layout.tsx sets data-theme before paint; this only flips and remembers it. */
export function ThemeToggle() {
  function flip() {
    const root = document.documentElement;
    const next = root.dataset.theme === "light" ? "dark" : "light";
    root.dataset.theme = next;
    try { localStorage.setItem("vp-theme", next); } catch { /* storage blocked */ }
  }
  return <button type="button" className="theme-toggle" onClick={flip} aria-label="Toggle light and dark theme" title="Toggle light and dark theme"><Sun className="icon sun" aria-hidden="true" size={18} /><Moon className="icon moon" aria-hidden="true" size={18} /></button>;
}

export function Credit() {
  return <p className="credit">Made by <strong>Mainframe Hustlers</strong>: Ashutosh Swamy and Sairaj Dhuri</p>;
}
