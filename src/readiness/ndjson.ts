import { ZodError } from "zod";
import { parseEvent, type ReadinessEvent } from "./schema";

/**
 * NDJSON reading for the readiness report (spec §4). Shared by the page (live runner stream),
 * replay (recorded runs) and the live probes (the chat stream). Browser-safe: no Node APIs.
 */

/** A line that breaks the event contract. `lineNo` is 1-based and counts blank lines, so it matches an editor. */
export class NdjsonLineError extends Error {
  override name = "NdjsonLineError";
  constructor(
    readonly lineNo: number,
    reason: string,
  ) {
    super(`line ${lineNo}: ${reason}`);
  }
}

/** One-line reason for a JSON or zod failure; zod's own message would dump every issue. */
export function describeParseError(err: unknown): string {
  if (err instanceof SyntaxError) return "not valid JSON";
  if (err instanceof ZodError) {
    const issue = err.issues[0];
    const where = issue?.path.length ? issue.path.join(".") : "(root)";
    return `${where}: ${issue?.message ?? "invalid"}`.slice(0, 300);
  }
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

/** Validates one line against the readiness contract; throws `NdjsonLineError` naming the line. */
export function parseReadinessLine(line: string, lineNo: number): ReadinessEvent {
  try {
    return parseEvent(line);
  } catch (err) {
    throw new NdjsonLineError(lineNo, `breaks the readiness event contract — ${describeParseError(err)}`);
  }
}

/** Rejects as soon as `signal` aborts, so a body that ignores its signal can't hang the caller. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/**
 * Splits a byte stream into non-blank lines. Lines and multi-byte characters may straddle chunk
 * boundaries; the stream is cancelled if the consumer stops early or `signal` aborts.
 */
export async function* ndjsonLines(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<{ line: string; lineNo: number }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lineNo = 0;
  try {
    while (true) {
      const { value, done } = await (signal ? untilAborted(reader.read(), signal) : reader.read());
      buffer += decoder.decode(value, { stream: !done });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        lineNo += 1;
        if (line) yield { line, lineNo };
      }
      if (done) break;
    }
    const rest = buffer.trim();
    if (rest) yield { line: rest, lineNo: lineNo + 1 };
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** Reads a runner's NDJSON response as validated readiness events; throws on the first line that breaks the contract. */
export async function* readReadinessEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<ReadinessEvent> {
  for await (const { line, lineNo } of ndjsonLines(body)) yield parseReadinessLine(line, lineNo);
}
