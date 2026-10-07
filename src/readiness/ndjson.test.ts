import { describe, expect, it } from "vitest";
import { ndjsonLines, NdjsonLineError, readReadinessEvents } from "./ndjson";
import type { ReadinessEvent } from "./schema";

/** A body that delivers `text` in `size`-byte chunks, so lines and multi-byte characters straddle chunk boundaries. */
function chunkedBody(text: string, size: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size));
      controller.close();
    },
  });
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

const EVENTS: ReadinessEvent[] = [
  { type: "stage-start", stage: "lint", at: "2026-10-07T20:00:00.000Z" },
  // "›" and "—" are multi-byte in UTF-8: 3-byte chunks cut through them.
  { type: "log", stage: "lint", line: "eslint › src — 0 problems" },
  {
    type: "stage-end",
    stage: "lint",
    status: "passed",
    durationMs: 4200,
    counts: { passed: 1, failed: 0, skipped: 0 },
    source: "live",
    at: "2026-10-07T20:00:04.200Z",
  },
];

describe("readiness NDJSON reader (spec §4)", () => {
  it.each([1, 3, 7, 64, 4096])("reassembles events split into %i-byte chunks", async (size) => {
    const text = EVENTS.map((e) => JSON.stringify(e)).join("\n") + "\n";
    expect(await collect(readReadinessEvents(chunkedBody(text, size)))).toEqual(EVENTS);
  });

  it("skips blank and CRLF lines and reads a last line with no trailing newline", async () => {
    const [a, b, c] = EVENTS.map((e) => JSON.stringify(e));
    const text = `${a}\r\n\r\n   \n${b}\n${c}`;
    expect(await collect(readReadinessEvents(chunkedBody(text, 5)))).toEqual(EVENTS);
  });

  it("names the 1-based line (blank lines counted) of an event that breaks the contract", async () => {
    const bad = JSON.stringify({ type: "test-result", result: { id: "x", stage: "unit", file: "f", fullName: "n", status: "flaky", durationMs: 1, source: "live" } });
    const text = `${JSON.stringify(EVENTS[0])}\n\n${bad}\n`;
    const read = collect(readReadinessEvents(chunkedBody(text, 4)));
    await expect(read).rejects.toBeInstanceOf(NdjsonLineError);
    await expect(read).rejects.toMatchObject({ lineNo: 3, message: expect.stringMatching(/^line 3: breaks the readiness event contract — result\.status: /) });
  });

  it("reports a line that is not JSON", async () => {
    await expect(collect(readReadinessEvents(chunkedBody(`${JSON.stringify(EVENTS[0])}\n{"type":`, 3)))).rejects.toThrow(
      "line 2: breaks the readiness event contract — not valid JSON",
    );
  });

  it("stops reading and rejects as soon as its signal aborts, even if the body never ends", async () => {
    const ctrl = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"a":1}\n'));
      },
    });
    const lines: string[] = [];
    const read = (async () => {
      for await (const { line } of ndjsonLines(body, ctrl.signal)) {
        lines.push(line);
        ctrl.abort(new Error("stop"));
      }
    })();
    await expect(read).rejects.toThrow("stop");
    expect(lines).toEqual(['{"a":1}']);
  });
});
