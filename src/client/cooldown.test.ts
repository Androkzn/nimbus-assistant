import { describe, expect, it } from "vitest";
import { deadlineIn, formatWait, liveWaitCopy, secondsLeft } from "./cooldown";

describe("rate-limit countdown copy (NKA-SEC-004)", () => {
  it("turns a relative wait into a deadline that counts back down to it", () => {
    const until = deadlineIn(180, 1_000);
    expect(until).toBe(181_000);
    expect(secondsLeft(until, 1_000)).toBe(180);
  });

  it("rounds the time left up to whole seconds and never goes below zero", () => {
    expect(secondsLeft(10_500, 0)).toBe(11);
    expect(secondsLeft(1_000, 1_000)).toBe(0);
    expect(secondsLeft(0, 5_000)).toBe(0);
  });

  it("formats seconds under a minute and m:ss above", () => {
    expect(formatWait(45)).toBe("45s");
    expect(formatWait(60)).toBe("1:00");
    expect(formatWait(167)).toBe("2:47");
  });

  it("keeps the provider copy's wait in step with the countdown", () => {
    const msg = "Google Gemini is rate-limited right now. Wait about 12 seconds and try again, or choose another model.";
    expect(liveWaitCopy(msg, 7)).toBe("Google Gemini is rate-limited right now. Wait about 7 seconds and try again, or choose another model.");
    expect(liveWaitCopy(msg, 1)).toContain("Wait about 1 second and");
    expect(liveWaitCopy(msg, 0)).toBe("Google Gemini is rate-limited right now. Try again, or choose another model.");
  });

  it("leaves copy without a wait untouched", () => {
    expect(liveWaitCopy("Google Gemini rejected the request.", 5)).toBe("Google Gemini rejected the request.");
  });
});
