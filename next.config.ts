import { withSentryConfig } from "@sentry/nextjs/config";
import type { NextConfig } from "next";

// Vercel exposes VERCEL_ENV only at build time. Re-export it for observability metadata.
const deploymentEnv = process.env.VERCEL_ENV ?? process.env.NEXT_PUBLIC_VERCEL_ENV ?? "development";
// Local and preview builds include the developer-only readiness/knowledge-base surfaces. Production
// deployments stay locked down unless explicitly opted in for a local diagnostic run.
const devSurfaceEnabled = process.env.NIMBUS_DEV_PORTAL === "1" || deploymentEnv !== "production" || process.env.NODE_ENV === "development";

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_VERCEL_ENV: deploymentEnv,
    NEXT_PUBLIC_DEV_SURFACE: devSurfaceEnabled ? "1" : "0",
  },
  // Allow isolated build tooling to choose a separate output directory when needed.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // The knowledge base is read from disk at runtime; make sure serverless
  // bundles of the API routes ship with it.
  outputFileTracingIncludes: {
    "/api/**": ["./knowledge-base/**/*.md"],
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
