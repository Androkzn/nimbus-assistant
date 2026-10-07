import { withSentryConfig } from "@sentry/nextjs/config";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
