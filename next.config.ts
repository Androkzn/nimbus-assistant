import { withSentryConfig } from "@sentry/nextjs/config";
import type { NextConfig } from "next";

// Vercel exposes VERCEL_ENV only at build time. Re-export it for observability metadata.
const deploymentEnv = process.env.VERCEL_ENV ?? process.env.NEXT_PUBLIC_VERCEL_ENV ?? "development";

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_VERCEL_ENV: deploymentEnv,
  },
  // Allow isolated build tooling to choose a separate output directory when needed.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // The checked-in corpus is a test/development fallback. Production builds can
  // stage a validated Google Drive snapshot in .generated/ before Next builds.
  outputFileTracingIncludes: {
    "/api/**": ["./knowledge-base/**/*.md", "./.generated/knowledge-base/**/*.md", "./.generated/knowledge-base/.drive-kb-manifest.json"],
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default withSentryConfig(nextConfig, {
  org: "andrei-tekhtelev",
  project: "nimbus-assistant",
  // Source maps upload only when a token is present (Vercel/CI); local builds and fresh clones skip it.
  authToken: process.env.SENTRY_AUTH_TOKEN,
  sourcemaps: { disable: process.env.SENTRY_AUTH_TOKEN ? false : "disable-upload" },
  widenClientFileUpload: true,
  // Browser events go through our own origin so ad-blockers don't drop them.
  tunnelRoute: "/monitoring",
  silent: !process.env.CI,
  telemetry: false,
});
