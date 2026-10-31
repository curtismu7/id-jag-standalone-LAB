import { describe, expect, it } from "vitest";
import { fill, fillAll, tokensIn } from "../fill";
import { DEFAULT_VERTICAL, STORIES, VERTICALS, storyForMode, verticalById } from "../stories";
import { validateStory, validateVertical } from "../storySchema";
import { MODE_STEPS } from "../../utils/idJagPlaygroundSteps";

const MODES = ["mock", "pf-as", "pf-pf", "byo"];
const good = () => JSON.parse(JSON.stringify(STORIES[0]));

describe("shipped data", () => {
  it("has at least one story and the generic vertical", () => {
    expect(STORIES.length).toBeGreaterThan(0);
    expect(VERTICALS.map((v) => v.id)).toContain(DEFAULT_VERTICAL);
  });

  it.each(STORIES.map((s) => [s.id, s]))("story %s is valid", (_id, s) => {
    expect(validateStory(s, { modes: MODES })).toEqual([]);
  });

  it.each(VERTICALS.map((v) => [v.id, v]))("vertical %s is valid", (_id, v) => {
    expect(validateVertical(v)).toEqual([]);
  });

  it("story ids and vertical ids are unique", () => {
    expect(new Set(STORIES.map((s) => s.id)).size).toBe(STORIES.length);
    expect(new Set(VERTICALS.map((v) => v.id)).size).toBe(VERTICALS.length);
  });

  it("every token in every story resolves in every vertical (no ⟨missing⟩ can reach the page)", () => {
    for (const s of STORIES) {
      for (const v of VERTICALS) {
        const out = JSON.stringify(fillAll(s, v));
        expect(out, `${s.id} in ${v.id}`).not.toContain("⟨missing");
      }
    }
  });

  it("every story's step numbers exist in each playground mode it names", () => {
    expect(Object.keys(MODE_STEPS).sort()).toEqual([...MODES].sort());
    for (const s of STORIES) {
      for (const m of s.modes) {
        const missing = s.steps.map((x) => x.n).filter((n) => !MODE_STEPS[m].includes(n));
        expect(missing, `${s.id} in ${m}`).toEqual([]);
      }
    }
  });

  it("every playground mode has a story", () => {
    for (const m of MODES) expect(storyForMode(m), m).not.toBeNull();
  });

  it("no vertical pack mentions AI-DEMO2 environment ids or secrets, only its source path", () => {
    for (const v of VERTICALS) {
      expect(JSON.stringify(v)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      expect(JSON.stringify(v)).not.toMatch(/secret|password|token_/i);
    }
  });
});

describe("validateStory", () => {
  it("accepts the shipped story", () => expect(validateStory(good(), { modes: MODES })).toEqual([]));

  it("names each problem", () => {
    const s = good();
    s.id = "11"; s.steps[0].n = 9; s.steps[1].n = s.steps[2].n; delete s.steps[0].say; delete s.proof.blocked; s.modes = ["nope"];
    const errors = validateStory(s, { modes: MODES }).join("\n");
    expect(errors).toContain("id must look like S11");
    expect(errors).toContain("n must be an integer 1-6");
    expect(errors).toContain("duplicates another step");
    expect(errors).toContain("steps[n=9].say is required text");
    expect(errors).toContain("proof needs happy and blocked text");
    expect(errors).toContain('unknown mode "nope"');
  });

  it("rejects a blocked variant without both tell and say", () => {
    const s = good();
    s.steps.find((x) => x.blocked).blocked = { tell: "only half" };
    expect(validateStory(s, { modes: MODES }).join()).toContain("blocked needs tell and say");
  });

  it("requires ascending step order", () => {
    const s = good();
    s.steps.reverse();
    expect(validateStory(s, { modes: MODES }).join()).toContain("ascending order");
  });
});

describe("validateVertical", () => {
  it("rejects a bad color and a vocab that is not text", () => {
    const v = { ...verticalById("banking"), brand: { primary: "red", headerStart: "#000000", headerEnd: "#000000" }, vocab: { a: 3 } };
    const errors = validateVertical(v).join("\n");
    expect(errors).toContain("brand.primary must be a #rrggbb color");
    expect(errors).toContain("vocab must map names to text");
  });
});

describe("fill", () => {
  const v = { cast: { lena: { name: "Lena" } }, vocab: { partner: "a partner bank" } };
  it("replaces cast and vocab tokens, tolerating spaces", () => {
    expect(fill("{{lena}} works at {{ vocab.partner }}.", v)).toBe("Lena works at a partner bank.");
  });
  it("keeps an undefined token visible", () => {
    expect(fill("{{nobody}} {{vocab.nothing}}", v)).toBe("⟨missing: nobody⟩ ⟨missing: vocab.nothing⟩");
  });
  it("lists tokens across nested values", () => {
    expect([...tokensIn({ a: ["{{x}}", { b: "{{vocab.y}} {{x}}" }] })].sort()).toEqual(["vocab.y", "x"]);
  });
  it("fillAll copies and does not change the source", () => {
    const src = { t: "{{lena}}", n: 1, arr: ["{{lena}}"] };
    expect(fillAll(src, v)).toEqual({ t: "Lena", n: 1, arr: ["Lena"] });
    expect(src.t).toBe("{{lena}}");
  });
});

describe("lookup", () => {
  it("finds the story for a mode it names, and none for others", () => {
    expect(storyForMode("byo")?.id).toBe("S11");
    expect(storyForMode("pf-as")?.id).toBe("S13");
    expect(storyForMode("pf-pf")?.id).toBe("S11b");
    expect(storyForMode("mock")?.id).toBe("S36");
    expect(storyForMode("nope")).toBeNull();
  });
  it("falls back to generic for an unknown vertical", () => {
    expect(verticalById("does-not-exist").id).toBe(DEFAULT_VERTICAL);
  });
});
