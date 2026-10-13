import type { Metadata } from "next";
import { Instrument_Serif, Public_Sans, JetBrains_Mono } from "next/font/google";
import { SideRail } from "@/components/SideRail";
import { StatusRail } from "@/components/StatusRail";
import { db } from "@/lib/db/client";
import { merchants } from "@/lib/db/schema";
import { docketSummary } from "@/lib/queries/docket";
import "./globals.css";
import styles from "./shell.module.css";

// ---------- TYPE · display, body, data ----------
// Public Sans is the USWDS text face — built for forms and public records,
// which is the register this product works in. Both it and JetBrains Mono are
// variable fonts, so each resolves to a single next/font entry.

const instrumentSerif = Instrument_Serif({
  variable: "--font-instrument-serif",
  subsets: ["latin"],
  weight: "400",
  style: "normal",
});

const publicSans = Public_Sans({
  variable: "--font-public-sans",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Rebuttal — dispute evidence desk",
  description:
    "Drafts cited evidence packets for PayPal disputes and files them before the response deadline closes.",
};

export const dynamic = "force-dynamic";

/**
 * The shell renders before the database is reachable on a cold Neon start, so
 * both lookups fall back rather than throwing. A chrome failure must not take
 * the page with it.
 */
async function loadShell() {
  const [merchant, summary] = await Promise.all([
    db
      .select()
      .from(merchants)
      .limit(1)
      .then((rows) => rows[0] ?? null)
      .catch(() => null),
    docketSummary().catch(() => null),
  ]);

  return {
    merchantName: merchant?.displayName ?? "Merchant",
    merchantRef: merchant?.paypalMerchantId ?? "not linked",
    openCount: summary?.openCount ?? 0,
  };
}

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const shell = await loadShell();

  return (
    <html
      lang="en"
      className={`${instrumentSerif.variable} ${publicSans.variable} ${jetbrainsMono.variable}`}
    >
      <body>
        <div className={styles.shell}>
          <SideRail {...shell} />
          <div className={styles.column}>
            <main className={styles.main}>{children}</main>
            <StatusRail />
          </div>
        </div>
      </body>
    </html>
  );
}
