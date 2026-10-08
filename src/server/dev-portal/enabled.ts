/** The developer surface (Knowledge base portal, Readiness): on in development, previews and the dev deployment; off in production. */
export function devPortalEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV === "development" || env.VERCEL_ENV === "preview" || env.NIMBUS_DEV_PORTAL === "1";
}
