import type { Metadata } from "next";
import type { ReactNode } from "react";

/**
 * Readiness report (docs/requirements/06_Readiness_Report.md). Showcase tooling: it reads the product,
 * the product never imports it (I1). Not for search engines.
 */
export const metadata: Metadata = {
  title: "Readiness — NimbusStack Assistant",
  description: "Every quality gate, run live and mapped to the brief requirement it proves.",
  robots: { index: false, follow: false, nocache: true },
};

export default function ReadinessLayout({ children }: { children: ReactNode }) {
  return children;
}
