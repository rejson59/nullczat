import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";

export const metadata: Metadata = {
  title: "nullczat",
  description: "",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
  other: { google: "notranslate" },
};

export const viewport: Viewport = {
  themeColor: "#000000",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const nonce = (await headers()).get("x-nonce") ?? "";
  return (
    <html lang="pl" translate="no">
      <head>
        <meta name="google" content="notranslate" />
        <meta name="csp-nonce" content={nonce} />
      </head>
      <body translate="no">{children}</body>
    </html>
  );
}
