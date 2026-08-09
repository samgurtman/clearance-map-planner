import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") || requestHeaders.get("host") || "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  return {
    title: "Clearance — FAA §91.119(b) Planning Aid",
    description: "Screen building-height data against the modeled 1,000-foot vertical and 2,000-foot horizontal clearance standard.",
    icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
    openGraph: {
      title: "Clearance — FAA §91.119(b) Planning Aid",
      description: "A client-side 2D altitude and building-clearance screening tool.",
      images: [{ url: `${origin}/og.png`, width: 1200, height: 630, alt: "Clearance planning aid map" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Clearance — FAA §91.119(b) Planning Aid",
      description: "A client-side 2D altitude and building-clearance screening tool.",
      images: [`${origin}/og.png`],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
