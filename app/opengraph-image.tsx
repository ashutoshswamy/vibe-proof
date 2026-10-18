import { ImageResponse } from "next/og";

export const alt = "VibeProof: verify before you ship";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function Image() {
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", padding: 96, background: "#f3f5f6", color: "#10181c" }}>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 10, height: 66 }}>
        <div style={{ width: 15, height: 33, borderRadius: 8, background: "#0a7a58", opacity: 0.5 }} />
        <div style={{ width: 15, height: 51, borderRadius: 8, background: "#0a7a58", opacity: 0.75 }} />
        <div style={{ width: 15, height: 66, borderRadius: 8, background: "#0a7a58" }} />
      </div>
      <div style={{ display: "flex", fontSize: 104, fontWeight: 700, letterSpacing: -4, marginTop: 40 }}>Verify before you <span style={{ color: "#0a7a58", marginLeft: 24 }}>ship.</span></div>
      <div style={{ fontSize: 40, color: "#55636b", marginTop: 24 }}>82 launch checks. Evidence and a fix prompt for every finding.</div>
    </div>,
    size,
  );
}
