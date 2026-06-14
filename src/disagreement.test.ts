import { describe, it, expect } from "vitest";
import {
  cosineSimilarity,
  cosineDistance,
  pairwiseDisagreement,
  disagreementLabel,
  scoreDisagreement,
  type Embedder,
} from "./disagreement.js";

describe("cosineSimilarity", () => {
  it("is 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
  });
  it("is 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });
  it("is -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 6);
  });
  it("matches a known value", () => {
    expect(cosineSimilarity([1, 1], [1, 0])).toBeCloseTo(Math.SQRT1_2, 6); // 1/√2
  });
  it("is 0 (not NaN) when a vector is all zeros", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe("cosineDistance", () => {
  it("is 0 for identical and clamps opposite to 1", () => {
    expect(cosineDistance([1, 2], [1, 2])).toBeCloseTo(0, 6);
    expect(cosineDistance([1, 0], [-1, 0])).toBe(1); // 1-(-1)=2 → clamped
  });
});

describe("pairwiseDisagreement", () => {
  it("throws with fewer than two vectors", () => {
    expect(() => pairwiseDisagreement([[1, 0]])).toThrow(/at least 2/);
  });
  it("reports zero distance and no flag for identical vectors", () => {
    const r = pairwiseDisagreement([
      [1, 0],
      [1, 0],
    ]);
    expect(r.maxDistance).toBeCloseTo(0, 6);
    expect(r.flagged).toBe(false);
  });
  it("flags orthogonal vectors and names the divergent pair", () => {
    const r = pairwiseDisagreement([
      [1, 0],
      [1, 0],
      [0, 1], // the outlier
    ]);
    expect(r.maxDistance).toBeCloseTo(1, 6);
    expect(r.flagged).toBe(true);
    expect(r.maxPair).toEqual([0, 2]); // or [1,2]; outlier is index 2
  });
  it("respects a custom threshold", () => {
    const vecs = [
      [1, 0],
      [0.9, 0.1],
    ];
    // small distance — flagged only under a very low threshold
    expect(pairwiseDisagreement(vecs, 0.001).flagged).toBe(true);
    expect(pairwiseDisagreement(vecs, 0.9).flagged).toBe(false);
  });
});

describe("disagreementLabel", () => {
  it.each([
    [0.05, "strong consensus"],
    [0.2, "broad agreement"],
    [0.4, "notable disagreement"],
    [0.8, "strong disagreement"],
  ])("%s -> %s", (d, label) => {
    expect(disagreementLabel(d)).toBe(label);
  });
});

describe("scoreDisagreement", () => {
  // a fake embedder: each answer's content maps to a preset vector
  const embedder =
    (map: Record<string, number[]>): Embedder =>
    async (texts) =>
      texts.map((t) => map[t] ?? [0, 0]);

  it("returns null with fewer than two usable answers", async () => {
    const r = await scoreDisagreement(
      [{ model: "a", content: "only one" }],
      embedder({ "only one": [1, 0] }),
    );
    expect(r).toBeNull();
  });

  it("ignores blank answers when counting usable ones", async () => {
    const r = await scoreDisagreement(
      [
        { model: "a", content: "real" },
        { model: "b", content: "   " },
      ],
      embedder({ real: [1, 0] }),
    );
    expect(r).toBeNull();
  });

  it("scores a divided panel and names the most divergent pair", async () => {
    const r = await scoreDisagreement(
      [
        { model: "a/agree", content: "yes" },
        { model: "b/agree", content: "yep" },
        { model: "c/dissent", content: "no" },
      ],
      embedder({ yes: [1, 0], yep: [1, 0], no: [0, 1] }),
    );
    expect(r).not.toBeNull();
    expect(r!.flagged).toBe(true);
    expect(r!.maxDistance).toBeCloseTo(1, 6);
    expect(r!.mostDivergentPair).toContain("c/dissent");
    expect(r!.models).toEqual(["a/agree", "b/agree", "c/dissent"]);
  });

  it("returns null (never throws) when the embedder fails", async () => {
    const boom: Embedder = async () => {
      throw new Error("model load failed");
    };
    const r = await scoreDisagreement(
      [
        { model: "a", content: "x" },
        { model: "b", content: "y" },
      ],
      boom,
    );
    expect(r).toBeNull();
  });

  it("returns null when the embedder returns the wrong count", async () => {
    const wrong: Embedder = async () => [[1, 0]]; // only one vector for two answers
    const r = await scoreDisagreement(
      [
        { model: "a", content: "x" },
        { model: "b", content: "y" },
      ],
      wrong,
    );
    expect(r).toBeNull();
  });
});
