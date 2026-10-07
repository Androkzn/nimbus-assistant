import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { simulateReadableStream, type LanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { isMockMode, PROVIDER_KEY_ENV, type Env, type ModelEntry } from "../config/models";

/** Sole construction site for language models. Keys are read here and nowhere else. */
export function languageModelFor(entry: ModelEntry, env: Env = process.env): LanguageModel {
  if (isMockMode(env)) return mockModel(entry);
  const apiKey = env[PROVIDER_KEY_ENV[entry.provider]];
  switch (entry.provider) {
    case "anthropic":
      return createAnthropic({ apiKey })(entry.vendorModelId);
    case "openai":
      return createOpenAI({ apiKey })(entry.vendorModelId);
    case "google":
      return createGoogleGenerativeAI({ apiKey })(entry.vendorModelId);
    default: {
      const exhaustive: never = entry.provider;
      throw new Error(`Unknown provider ${String(exhaustive)}`);
    }
  }
}

/**
 * Deterministic offline model for CI and E2E (LLM_MODE=mock). It "answers" with the first data
 * line of passage [1], cited, so tests can assert grounding behaviour without network or keys.
 */
export function mockModel(entry: ModelEntry): LanguageModel {
  return new MockLanguageModelV4({
    provider: `mock-${entry.provider}`,
    modelId: entry.vendorModelId,
    doStream: async ({ prompt }) => {
      const system = prompt
        .filter((m) => m.role === "system")
        .map((m) => m.content)
        .join("\n");
      // "[1] source: <file>\n<header line>\n<body…>" — skip file and header, take the first data line.
      const firstPassage = system.split("<passages>")[1]?.split(/\n\[\d+\] source: /)[1] ?? "";
      const evidence =
        firstPassage
          .split("\n")
          .slice(2)
          .map((l) => l.trim())
          .find((l) => l.length > 0 && !/^\|?\s*:?-{3}/.test(l)) ?? "";
      const answer = evidence
        ? `According to the knowledge base: ${evidence} [1]`
        : "I couldn't find this in the NimbusStack knowledge base.";
      // Prefixed with the model id (no digits, so the figure check stays clean) to prove which model answered.
      const words = `(${entry.id}) ${answer}`.match(/\S+\s*/g) ?? [];
      const promptChars = JSON.stringify(prompt).length;
      return {
        stream: simulateReadableStream({
          chunkDelayInMs: 8,
          chunks: [
            { type: "text-start" as const, id: "t1" },
            ...words.map((w) => ({ type: "text-delta" as const, id: "t1", delta: w })),
            { type: "text-end" as const, id: "t1" },
            {
              type: "finish" as const,
              finishReason: { unified: "stop" as const, raw: undefined },
              usage: {
                inputTokens: { total: Math.ceil(promptChars / 4), noCache: Math.ceil(promptChars / 4), cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: Math.ceil(answer.length / 4), text: Math.ceil(answer.length / 4), reasoning: undefined },
              },
            },
          ],
        }),
      };
    },
  });
}
