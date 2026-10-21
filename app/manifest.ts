import type { MetadataRoute } from "next";
import { siteDescription, siteName } from "@/lib/site";

export default function manifest(): MetadataRoute.Manifest {
  return { name: siteName, short_name: siteName, description: siteDescription, start_url: "/", display: "standalone", background_color: "#f5f2f3", theme_color: "#021f94", icons: [{ src: "/android-chrome-192x192.png", sizes: "192x192", type: "image/png" }, { src: "/android-chrome-512x512.png", sizes: "512x512", type: "image/png", purpose: "any" }, { src: "/logo.svg", sizes: "any", type: "image/svg+xml" }] };
}
