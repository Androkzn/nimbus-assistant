"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

/**
 * Last-resort boundary for errors in the root layout. It replaces the whole document, so it carries
 * its own minimal styling (global CSS and fonts are not loaded here).
 */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: "100vh", display: "grid", placeItems: "center", background: "#0f1729", color: "#f1f5f9", fontFamily: "system-ui, sans-serif" }}>
        <title>Something went wrong · NimbusStack</title>
        <main style={{ maxWidth: 420, padding: 24, textAlign: "center" }}>
          <p style={{ margin: 0, fontSize: 11, fontWeight: 700, letterSpacing: "0.18em", textTransform: "uppercase", color: "#f28c38" }}>NimbusStack</p>
          <h1 style={{ margin: "12px 0 8px", fontSize: 28 }}>
            Something went wrong<span style={{ color: "#f28c38" }}>.</span>
          </h1>
          <p style={{ margin: 0, color: "#97a3b8", lineHeight: 1.5 }}>The error has been reported. Reload the page to start again.</p>
          <button
            onClick={() => retry()}
            style={{ marginTop: 20, padding: "10px 18px", border: 0, borderRadius: 12, background: "#ea580c", color: "#fff", fontWeight: 600, cursor: "pointer" }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
