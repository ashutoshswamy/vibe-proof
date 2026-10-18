import type { Metadata, Viewport } from "next";
import { DM_Sans, Sora } from "next/font/google";
import { headers } from "next/headers";
import { connection } from "next/server";
import { siteDescription, siteName, siteUrl } from "@/lib/site";
import "./globals.css";

const display = Sora({ subsets: ["latin"], variable: "--f-display", display: "swap" });
const body = DM_Sans({ subsets: ["latin"], variable: "--f-body", display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: "VibeProof | Verify your site before you ship", template: "%s | VibeProof" },
  description: siteDescription,
  applicationName: siteName,
  alternates: { canonical: "/" },
  robots: { index: true, follow: true },
  openGraph: { type: "website", siteName, url: "/", title: "VibeProof | Verify your site before you ship", description: siteDescription },
  twitter: { card: "summary_large_image", title: "VibeProof | Verify your site before you ship", description: siteDescription },
  icons: { icon: [{ url: "/favicon.ico" }, { url: "/logo.svg", type: "image/svg+xml" }] },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [{ media: "(prefers-color-scheme: light)", color: "#f3f5f6" }, { media: "(prefers-color-scheme: dark)", color: "#090d0f" }],
};

export const instant = false;

const jsonLd = JSON.stringify({ "@context": "https://schema.org", "@type": "WebApplication", name: siteName, url: siteUrl, description: siteDescription, applicationCategory: "DeveloperApplication", operatingSystem: "Any", offers: { "@type": "Offer", price: "0", priceCurrency: "USD" } }).replace(/</g, "\\u003c");

const themeScript = `try{var t=localStorage.getItem("vp-theme");if(t!=="light"&&t!=="dark")t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";document.documentElement.dataset.theme=t;if(localStorage.getItem("vp-auth")==="1")document.documentElement.dataset.auth="1"}catch(e){document.documentElement.dataset.theme="dark"}`;

export default async function RootLayout({ children }: LayoutProps<"/">) {
  await connection();
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en" suppressHydrationWarning className={`h-full antialiased ${display.variable} ${body.variable}`}>
      <head><script nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: themeScript }} /><script type="application/ld+json" nonce={nonce} dangerouslySetInnerHTML={{ __html: jsonLd }} /></head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
