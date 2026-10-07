import * as Sentry from "@sentry/nextjs";
import { sentryOptions } from "@/shared/sentry";

Sentry.init({
  ...sentryOptions,
  // Automated browsers (Playwright E2E, the live eval) are not users — keep their traffic out of Sentry.
  enabled: sentryOptions.enabled && !navigator.webdriver,
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
