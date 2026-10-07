import { StreamEventSchema, type StreamEvent } from "@/shared/contracts";

/** Read an NDJSON response body as validated stream events. */
export async function* readEvents(res: Response): AsyncGenerator<StreamEvent> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) yield StreamEventSchema.parse(JSON.parse(line));
    }
    if (done) break;
  }
  if (buffer.trim()) yield StreamEventSchema.parse(JSON.parse(buffer));
}
