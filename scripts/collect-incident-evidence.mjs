import fs from "node:fs/promises";

const args = process.argv.slice(2);
const source = valueAfter("--source") || "incident";
const inputPath = valueAfter("--input");
const isSelfTest = args.includes("--self-test");

const LIMITS = {
  responseBytes: 8 * 1024 * 1024,
  logs: 100,
  breadcrumbs: 50,
  frames: 100,
  tags: 50,
  contexts: 30,
  string: 500,
};

function valueAfter(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
}

function text(value, limit = LIMITS.string) {
  if (value === null || value === undefined) return undefined;
  const valueText = typeof value === "string" ? value : String(value);
  return redact(valueText).slice(0, limit);
}

function redact(value) {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/(?:sk|pk|rk|sntrys|xox[baprs])[-_][A-Za-z0-9._-]+/gi, "[REDACTED_TOKEN]")
    .replace(/(?:api[_-]?key|secret|password|token)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[REDACTED_EMAIL]")
    .replace(/(https?:\/\/[^\s?#]+)[^\s]*/gi, "$1")
    .replace(/(\/Users\/)[^/\s]+/g, "$1[REDACTED]")
    .replace(/(\/home\/)[^/\s]+/g, "$1[REDACTED]");
}

function safeUrl(value) {
  if (!value) return undefined;
  try {
    const url = new URL(String(value));
    return `${url.origin}${url.pathname}`.slice(0, LIMITS.string);
  } catch {
    return text(String(value).split(/[?#]/, 1)[0], LIMITS.string);
  }
}

function sanitizePrimitive(value) {
  if (typeof value === "string") return text(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  return undefined;
}

function sanitizeTrigger(payload) {
  const safe = {};
  const dropped = [];
  const dropPattern = /^(authorization|auth|body|cookie|data|headers|ip|password|query|request|secret|token|user)$/i;
  for (const [key, value] of Object.entries(payload ?? {})) {
    if (dropPattern.test(key)) {
      dropped.push(key);
      continue;
    }
    if (key.toLowerCase().endsWith("url")) {
      safe[key] = safeUrl(value);
      continue;
    }
    const sanitized = sanitizePrimitive(value);
    if (sanitized !== undefined) safe[key] = sanitized;
  }
  return { fields: safe, droppedFields: dropped };
}

function asPairs(value, limit) {
  if (!value) return [];
  const entries = Array.isArray(value)
    ? value.map((entry) => (Array.isArray(entry) ? entry : [entry?.key, entry?.value]))
    : Object.entries(value);
  return entries.slice(0, limit).flatMap(([key, item]) => {
    const safeKey = text(key, 100);
    const safeValue = sanitizePrimitive(item);
    return safeKey && safeValue !== undefined ? [[safeKey, safeValue]] : [];
  });
}

function sanitizeContexts(contexts) {
  if (!contexts || typeof contexts !== "object") return {};
  const output = {};
  for (const [name, value] of Object.entries(contexts).slice(0, LIMITS.contexts)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      const safeValue = sanitizePrimitive(value);
      if (safeValue !== undefined) output[text(name, 100)] = safeValue;
      continue;
    }
    const fields = {};
    for (const [key, item] of Object.entries(value).slice(0, 20)) {
      const safeValue = sanitizePrimitive(item);
      if (safeValue !== undefined) fields[text(key, 100)] = safeValue;
    }
    output[text(name, 100)] = fields;
  }
  return output;
}

function sanitizeFrame(frame) {
  return {
    filename: text(frame?.filename || frame?.abs_path || frame?.module, 300),
    function: text(frame?.function || frame?.function_name, 200),
    module: text(frame?.module, 200),
    line: Number.isFinite(frame?.lineno) ? frame.lineno : undefined,
    column: Number.isFinite(frame?.colno) ? frame.colno : undefined,
    inApp: typeof frame?.in_app === "boolean" ? frame.in_app : undefined,
    source: text(frame?.context_line, 300),
  };
}

function sanitizeException(event) {
  const values = event?.exception?.values || [];
  return values.slice(0, 10).map((exception) => ({
    type: text(exception?.type, 200),
    value: text(exception?.value, 1000),
    mechanism: exception?.mechanism
      ? {
          type: text(exception.mechanism.type, 100),
          handled: typeof exception.mechanism.handled === "boolean" ? exception.mechanism.handled : undefined,
        }
      : undefined,
    frames: (exception?.stacktrace?.frames || []).slice(-LIMITS.frames).map(sanitizeFrame),
  }));
}

function sanitizeBreadcrumbs(event) {
  const values = event?.breadcrumbs?.values || event?.breadcrumbs || [];
  return values.slice(-LIMITS.breadcrumbs).map((breadcrumb) => ({
    timestamp: text(breadcrumb?.timestamp, 80),
    category: text(breadcrumb?.category, 100),
    type: text(breadcrumb?.type, 100),
    level: text(breadcrumb?.level, 50),
    message: text(breadcrumb?.message, 300),
    dataKeys: breadcrumb?.data && typeof breadcrumb.data === "object" ? Object.keys(breadcrumb.data).slice(0, 20).map((key) => text(key, 100)) : [],
  }));
}

function sanitizeSentryEvent(event) {
  const request = event?.request;
  return {
    id: text(event?.eventID || event?.event_id || event?.id, 100),
    title: text(event?.title || event?.message, 1000),
    platform: text(event?.platform, 100),
    level: text(event?.level, 50),
    environment: text(event?.environment, 100),
    release: text(event?.release, 200),
    transaction: text(event?.transaction, 300),
    timestamp: text(event?.timestamp, 80),
    received: text(event?.received, 80),
    tags: asPairs(event?.tags, LIMITS.tags),
    contexts: sanitizeContexts(event?.contexts),
    exception: sanitizeException(event),
    breadcrumbs: sanitizeBreadcrumbs(event),
    request: request
      ? {
          url: safeUrl(request.url),
          method: text(request.method, 20),
          statusCode: Number.isFinite(request.status_code) ? request.status_code : undefined,
          fragment: undefined,
        }
      : undefined,
    sdk: event?.sdk ? { name: text(event.sdk.name, 100), version: text(event.sdk.version, 100) } : undefined,
    fingerprint: Array.isArray(event?.fingerprint) ? event.fingerprint.slice(0, 10).map((item) => text(item, 200)) : [],
  };
}

function normalizeLogEntries(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.logs)) return body.logs;
  if (Array.isArray(body?.data)) return body.data;
  if (body && typeof body === "object") return [body];
  return String(body || "")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function sanitizeVercelLog(log) {
  return {
    timestamp: Number.isFinite(log?.timestampInMs) ? new Date(log.timestampInMs).toISOString() : text(log?.timestamp, 80),
    level: text(log?.level, 50),
    source: text(log?.source, 100),
    message: text(log?.message, 500),
    domain: text(log?.domain, 200),
    requestMethod: text(log?.requestMethod || log?.method, 20),
    requestPath: safeUrl(log?.requestPath || log?.path),
    responseStatusCode: Number.isFinite(log?.responseStatusCode) ? log.responseStatusCode : log?.statusCode,
    rowId: text(log?.rowId || log?.id, 100),
  };
}

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, {
    headers: { accept: "application/json", ...headers },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.text();
  if (body.length > LIMITS.responseBytes) throw new Error(`provider response exceeded ${LIMITS.responseBytes} bytes`);
  let parsed;
  try {
    parsed = body ? JSON.parse(body) : null;
  } catch {
    parsed = body;
  }
  if (!response.ok) throw new Error(`provider request failed with HTTP ${response.status}`);
  return parsed;
}

async function collectSentry(payload) {
  const token = process.env.SENTRY_AUTH_TOKEN;
  const org = process.env.SENTRY_ORG_SLUG;
  const issueId = payload.sentry_issue_id || payload.issue_id || payload.issueId;
  const eventId = payload.sentry_event_id || payload.event_id || payload.eventId;
  if (!token || !org || !issueId) {
    return { status: "skipped", reason: "SENTRY_AUTH_TOKEN, SENTRY_ORG_SLUG, or an issue ID is not configured" };
  }

  const base = (process.env.SENTRY_API_BASE_URL || "https://sentry.io/api/0").replace(/\/$/, "");
  const headers = { authorization: `Bearer ${token}` };
  try {
    let selectedEventId = eventId;
    let listing;
    if (!selectedEventId) {
      listing = await fetchJson(`${base}/organizations/${encodeURIComponent(org)}/issues/${encodeURIComponent(issueId)}/events/?limit=1`, headers);
      const latest = Array.isArray(listing) ? listing[0] : listing?.data?.[0];
      selectedEventId = latest?.eventID || latest?.event_id || latest?.id;
    }
    if (!selectedEventId) return { status: "unavailable", reason: "Sentry returned no event for the issue" };
    const event = await fetchJson(`${base}/organizations/${encodeURIComponent(org)}/issues/${encodeURIComponent(issueId)}/events/${encodeURIComponent(selectedEventId)}/`, headers);
    return {
      status: "collected",
      source: "Sentry API",
      issueId: text(issueId, 100),
      eventId: text(selectedEventId, 100),
      event: sanitizeSentryEvent(event),
      note: "Allowlisted diagnostic fields only; request payloads, headers, cookies, user identity, and breadcrumb data values were omitted.",
    };
  } catch (error) {
    return { status: "error", reason: error instanceof Error ? error.message : String(error) };
  }
}

async function collectVercel(payload) {
  const token = process.env.VERCEL_TOKEN;
  const projectId = process.env.VERCEL_PROJECT_ID;
  const teamId = process.env.VERCEL_TEAM_ID || process.env.VERCEL_ORG_ID;
  if (!token || !projectId) {
    return { status: "skipped", reason: "VERCEL_TOKEN or VERCEL_PROJECT_ID is not configured" };
  }

  const base = (process.env.VERCEL_API_BASE_URL || "https://api.vercel.com").replace(/\/$/, "");
  const headers = { authorization: `Bearer ${token}` };
  let deploymentId = payload.vercel_deployment_id || payload.deployment_id || payload.deploymentId;
  const deploymentUrl = payload.production_url || payload.baseUrl || process.env.VERCEL_PRODUCTION_URL;
  try {
    let deployment;
    if (!deploymentId && deploymentUrl) {
      const query = new URLSearchParams();
      if (teamId) query.set("teamId", teamId);
      deployment = await fetchJson(`${base}/v13/deployments/${encodeURIComponent(deploymentUrl)}${query.toString() ? `?${query}` : ""}`, headers);
      deploymentId = deployment?.id;
    }
    if (!deploymentId) {
      return { status: "unavailable", reason: "No deployment ID or production URL was supplied" };
    }
    const query = new URLSearchParams();
    if (teamId) query.set("teamId", teamId);
    const logs = await fetchJson(`${base}/v1/projects/${encodeURIComponent(projectId)}/deployments/${encodeURIComponent(deploymentId)}/runtime-logs${query.toString() ? `?${query}` : ""}`, headers);
    const entries = normalizeLogEntries(logs)
      .filter((log) => ["error", "fatal", "warning"].includes(String(log?.level || "").toLowerCase()))
      .slice(-LIMITS.logs)
      .map(sanitizeVercelLog);
    return {
      status: "collected",
      source: "Vercel Runtime Logs API",
      projectId: text(projectId, 100),
      deploymentId: text(deploymentId, 100),
      deployment: deployment
        ? {
            id: text(deployment.id, 100),
            url: safeUrl(deployment.url || deployment.inspectorUrl),
            state: text(deployment.state || deployment.readyState, 50),
            createdAt: text(deployment.createdAt, 80),
            ready: text(deployment.ready, 80),
            commit: text(deployment.meta?.githubCommitSha, 100),
          }
        : undefined,
      logs: entries,
      note: "Only warning/error/fatal entries were retained and request query strings, headers, cookies, and bodies were omitted.",
    };
  } catch (error) {
    return { status: "error", reason: error instanceof Error ? error.message : String(error) };
  }
}

function assertSelfTest(condition, message) {
  if (!condition) throw new Error(`self-test failed: ${message}`);
}

async function main() {
  if (isSelfTest) {
    const trigger = sanitizeTrigger({ issue_url: "https://sentry.io/organizations/acme/issues/123/?secret=do-not-keep", token: "secret-value", title: "hello" });
    assertSelfTest(trigger.fields.issue_url === "https://sentry.io/organizations/acme/issues/123/", "query strings are removed");
    assertSelfTest(!("token" in trigger.fields), "tokens are dropped");
    assertSelfTest(redact("Authorization: Bearer abc123 user@example.com").includes("[REDACTED]"), "secrets and email are redacted");
    const sentry = sanitizeSentryEvent({
      exception: { values: [{ stacktrace: { frames: [{ filename: "/Users/andrei/app.ts", lineno: 7 }] } }] },
      breadcrumbs: { values: [{ message: "Authorization: Bearer abc123", data: { secret: "hidden" } }] },
    });
    assertSelfTest(sentry.exception[0].frames[0].filename === "/Users/[REDACTED]/app.ts", "stack paths are redacted");
    assertSelfTest(sentry.breadcrumbs[0].message.includes("[REDACTED]"), "breadcrumb secrets are redacted");
    assertSelfTest(sentry.breadcrumbs[0].dataKeys.includes("secret"), "breadcrumb values are omitted but keys remain available");
    assertSelfTest(sanitizeVercelLog({ requestPath: "/api/chat?prompt=private" }).requestPath === "/api/chat", "Vercel query strings are removed");
    process.stdout.write("incident evidence self-test passed\n");
    return;
  }

  const rawInput = inputPath ? await fs.readFile(inputPath, "utf8") : process.env.TRIAGE_PAYLOAD || "{}";
  const payload = JSON.parse(rawInput);
  const trigger = sanitizeTrigger(payload);
  const monitorFields = source === "monitor" ? {
    baseUrl: safeUrl(payload.baseUrl),
    generatedAt: text(payload.generatedAt, 80),
    fingerprint: text(payload.fingerprint, 200),
  } : {};
  const [sentry, vercel] = await Promise.all([collectSentry(payload), collectVercel({ ...payload, ...monitorFields })]);

  process.stdout.write(JSON.stringify({
    schemaVersion: 1,
    source,
    collectedAt: new Date().toISOString(),
    ...monitorFields,
    trigger,
    sentry,
    vercel,
    privacy: {
      redacted: true,
      omitted: ["request bodies", "request headers", "cookies", "query strings", "user identity", "breadcrumb data values", "provider credentials"],
      retention: "This bundle is uploaded as a GitHub Actions artifact and included in the bugfix issue only after allowlisting and redaction.",
    },
  }, null, 2));
}

await main();
