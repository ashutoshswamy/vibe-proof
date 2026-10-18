const host = process.env.VERCEL_PROJECT_PRODUCTION_URL;
export const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? (host ? `https://${host}` : process.env.NODE_ENV === "production" ? "https://vibeproof-mainframehustlers.vercel.app" : "http://localhost:3000");
export const siteName = "VibeProof";
export const siteDescription = "Scan a live site or GitHub repo against 82 launch checks across security, SEO, accessibility, performance and more. Every finding comes with evidence and a fix prompt.";
export const siteKeywords = ["website scanner", "launch checklist", "pre-launch checks", "security headers check", "SEO audit", "accessibility audit", "GitHub repo review", "load test", "vibe coding", "AI-generated app review", "VibeProof"];
