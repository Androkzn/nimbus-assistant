import { describe, expect, it } from "vitest";
import { citationNumber, linkCitations } from "./citations";

describe("citation chips (NKA-GRD-001: every [n] maps to a shown passage)", () => {
  it("links single and adjacent markers", () => {
    expect(linkCitations("P1 is 1 hour [1].")).toBe("P1 is 1 hour [1](#cite-1).");
    expect(linkCitations("Both apply [1][3].")).toBe("Both apply [1](#cite-1)[3](#cite-3).");
  });

  it("splits grouped markers into one chip each", () => {
    expect(linkCitations("Docs disagree [2, 4].")).toBe("Docs disagree [2](#cite-2)[4](#cite-4).");
  });

  it("leaves real links, reference definitions and non-numeric brackets alone", () => {
    expect(linkCitations("see [1](https://example.com)")).toBe("see [1](https://example.com)");
    expect(linkCitations("[1]: https://example.com")).toBe("[1]: https://example.com");
    expect(linkCitations("tier [Pro] and v[4.2]")).toBe("tier [Pro] and v[4.2]");
  });

  it("reads the source number back from a link", () => {
    expect(citationNumber("#cite-3")).toBe(3);
    expect(citationNumber("#cite-x")).toBeNull();
    expect(citationNumber("https://example.com")).toBeNull();
    expect(citationNumber(undefined)).toBeNull();
  });
});
