const baseUrl = process.argv[2] ?? process.env.PRODUCTION_URL ?? "https://nimbus-assistant-production.vercel.app";
const checks = [];

async function check(name, path, validate) {
  const startedAt = Date.now();
  const url = new URL(path, baseUrl);

  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      // Non-JSON responses are still useful for status-code checks.
    }

    validate({ body, status: response.status, text });
    checks.push({ name, status: "pass", statusCode: response.status, latencyMs: Date.now() - startedAt });
  } catch (error) {
    checks.push({
      name,
      status: "fail",
      error: error instanceof Error ? error.message : String(error),
      latencyMs: Date.now() - startedAt,
    });
  }
}

await check("homepage", "/", ({ status }) => {
  if (status !== 200) throw new Error(`expected HTTP 200, got ${status}`);
});

await check("health", "/api/health", ({ body, status }) => {
  if (status !== 200) throw new Error(`expected HTTP 200, got ${status}`);
  if (body?.ok !== true || body?.mode !== "live") throw new Error("health is not live and healthy");
  if ((body.corpus?.files ?? 0) < 1 || (body.corpus?.chunks ?? 0) < 1) throw new Error("knowledge corpus is empty");
  if ((body.providersAvailable?.length ?? 0) < 1) throw new Error("no model providers are available");
});

await check("model-catalog", "/api/models", ({ body, status }) => {
  if (status !== 200) throw new Error(`expected HTTP 200, got ${status}`);
  if (!body?.defaultModelId || !Array.isArray(body.models) || body.models.length < 1) {
    throw new Error("model catalog is unavailable");
  }
});

await check("production-readiness-hidden", "/readiness?autostart=1", ({ status }) => {
  if (status !== 404) throw new Error(`expected HTTP 404, got ${status}`);
});

const failed = checks.filter((checkResult) => checkResult.status === "fail");
const report = {
  generatedAt: new Date().toISOString(),
  baseUrl,
  ok: failed.length === 0,
  fingerprint: failed.length > 0 ? failed.map((checkResult) => checkResult.name).join(",") : "healthy",
  checks,
};

console.log(JSON.stringify(report, null, 2));
if (failed.length > 0) process.exitCode = 1;
