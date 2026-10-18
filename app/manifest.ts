import type { MetadataRoute } from "next";
import { siteDescription, siteName } from "@/lib/site";

export default function manifest(): MetadataRoute.Manifest {
  return { name: siteName, short_name: siteName, description: siteDescription, start_url: "/", display: "standalone", background_color: "#f3f5f6", theme_color: "#0a7a58", icons: [{ src: "/logo.svg", sizes: "any", type: "image/svg+xml" }] };
}
