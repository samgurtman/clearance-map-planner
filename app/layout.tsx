import type { Metadata } from "next";
import "maplibre-gl/dist/maplibre-gl.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Clearance — FAA §91.119(b) Planning Aid",
  description: "Screen building-height data against the modeled 1,000-foot vertical and 2,000-foot horizontal clearance standard.",
  icons: { icon: "./favicon.svg", shortcut: "./favicon.svg" },
  openGraph: {
    title: "Clearance — FAA §91.119(b) Planning Aid",
    description: "A client-side 2D altitude and building-clearance screening tool.",
  },
  twitter: {
    card: "summary_large_image",
    title: "Clearance — FAA §91.119(b) Planning Aid",
    description: "A client-side 2D altitude and building-clearance screening tool.",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
