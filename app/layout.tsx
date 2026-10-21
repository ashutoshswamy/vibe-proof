import type { Metadata, Viewport } from "next";
import { DM_Sans } from "next/font/google";
import localFont from "next/font/local";
import { headers } from "next/headers";
import { connection } from "next/server";
import { siteDescription, siteKeywords, siteName, siteUrl } from "@/lib/site";
import "./globals.css";

const display = localFont({ src: "../public/font/Rosefana.otf", variable: "--f-display", display: "swap", weight: "400" });
const body = DM_Sans({ subsets: ["latin"], variable: "--f-body", display: "swap" });

const ogImage = { url: "/og-image.png", width: 1730, height: 909, alt: "VibeProof: verify before you ship" };

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: "VibeProof | Verify your site before you ship", template: "%s | VibeProof" },
  description: siteDescription,
  applicationName: siteName,
  keywords: siteKeywords,
  authors: [{ name: "Mainframe Hustlers" }],
  creator: "Mainframe Hustlers",
  category: "technology",
  alternates: { canonical: "/" },
  robots: { index: true, follow: true },
  openGraph: { type: "website", siteName, url: "/", locale: "en_US", images: [ogImage], title: "VibeProof | Verify your site before you ship", description: siteDescription },
  twitter: { card: "summary_large_image", images: [ogImage.url], title: "VibeProof | Verify your site before you ship", description: siteDescription },
  icons: { icon: [{ url: "/favicon.ico" }, { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" }, { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" }, { url: "/logo.svg", type: "image/svg+xml" }], apple: "/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [{ media: "(prefers-color-scheme: light)", color: "#f5f2f3" }, { media: "(prefers-color-scheme: dark)", color: "#101317" }],
};

export const instant = false;

const jsonLd = JSON.stringify({ "@context": "https://schema.org", "@graph": [
  { "@type": "Organization", "@id": `${siteUrl}/#org`, name: "Mainframe Hustlers", url: siteUrl, logo: `${siteUrl}/android-chrome-512x512.png` },
  { "@type": "WebSite", "@id": `${siteUrl}/#site`, name: siteName, url: siteUrl, description: siteDescription, inLanguage: "en", publisher: { "@id": `${siteUrl}/#org` } },
  { "@type": "WebApplication", "@id": `${siteUrl}/#app`, name: siteName, url: siteUrl, description: siteDescription, applicationCategory: "DeveloperApplication", operatingSystem: "Any", image: `${siteUrl}/og-image.png`, publisher: { "@id": `${siteUrl}/#org` }, featureList: ["Live site scan", "GitHub repo review", "82 launch checks across 10 areas", "URL stress test", "Evidence and fix prompt per finding"], offers: { "@type": "Offer", price: "0", priceCurrency: "USD" } },
] }).replace(/</g, "\\u003c");

const themeScript = `try{var t=localStorage.getItem("vp-theme");if(t!=="light"&&t!=="dark")t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";document.documentElement.dataset.theme=t;if(localStorage.getItem("vp-auth")==="1")document.documentElement.dataset.auth="1"}catch(e){document.documentElement.dataset.theme="dark"}`;

export default async function RootLayout({ children }: LayoutProps<"/">) {
  await connection();
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en" data-scroll-behavior="smooth" suppressHydrationWarning className={`h-full antialiased ${display.variable} ${body.variable}`}>
      <head><script nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: themeScript }} /><script type="application/ld+json" nonce={nonce} dangerouslySetInnerHTML={{ __html: jsonLd }} /></head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
