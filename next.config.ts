import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  experimental: {
    agentFeedback: true,
  },
  devIndicators: false,
  poweredByHeader: false,
  cacheComponents: true,
  serverExternalPackages: ["playwright-core", "@sparticuz/chromium"],
  partialPrefetching: true,
  // Same-origin auth helper: keeps redirect sign-in working where browsers partition third-party storage (Safari, mobile).
  async rewrites() {
    const host = process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN;
    return host ? [{ source: "/__/:path*", destination: `https://${host}/__/:path*` }] : [];
  },
  async headers() {
    return [{
      source: "/((?!__/).*)", // /__/ is Firebase's auth iframe: DENY framing and COOP would break it
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()" },
        { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" }, // popup sign-in needs allow-popups
        { key: "X-DNS-Prefetch-Control", value: "off" },
        { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
      ],
    }, {
      source: "/api/(.*)",
      headers: [{ key: "Cache-Control", value: "no-store" }],
    }];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
