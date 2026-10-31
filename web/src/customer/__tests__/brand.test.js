import { brandVars, contrast, readableOn } from "../brand";

describe("contrast", () => {
  it("matches the WCAG reference values", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 0);
    expect(contrast("#ffffff", "#ffffff")).toBe(1);
  });
});

describe("readableOn", () => {
  it("picks white on dark colours and Core Dark on light ones", () => {
    expect(readableOn("#0b3d91")).toBe("#ffffff");
    expect(readableOn("#ffd54a")).toBe("#051727");
  });
  it("returns null when neither reaches AA", () => {
    expect(readableOn("#7a7a7a", "#ffffff", "#000000")).toBeNull();
  });
});

describe("brandVars", () => {
  it("is empty without a brand", () => {
    expect(brandVars(undefined)).toEqual({});
    expect(brandVars({})).toEqual({});
  });

  it("sets the primary, a darker end of the gradient and a readable text colour", () => {
    const v = brandVars({ primary: "#0b6bcb" });
    expect(v["--ping-red"]).toBe("#0b6bcb");
    expect(v["--ping-red-deep"]).toMatch(/^#[0-9a-f]{6}$/);
    expect(v["--brand-on"]).toBe("#ffffff");
    expect(v["--brand-text-light"]).toBe("#0b6bcb");
  });

  it("uses the brand as accent text only on the theme where it is readable", () => {
    const yellow = brandVars({ primary: "#ffcc00" }); // reads on dark, not on white
    expect(yellow["--brand-text-light"]).toBeUndefined();
    expect(yellow["--brand-text-dark"]).toBe("#ffcc00");
    expect(yellow["--brand-on"]).toBe("#051727");
    const navy = brandVars({ primary: "#0a2540" }); // reads on white, not on the dark card
    expect(navy["--brand-text-light"]).toBe("#0a2540");
    expect(navy["--brand-text-dark"]).toBeUndefined();
  });

  it("falls back to the Ping default when the brand fails contrast on both themes", () => {
    expect(brandVars({ primary: "#808080" })).toEqual({});
  });

  it("sets the header gradient with a readable ink, and drops a header nothing is readable on", () => {
    const v = brandVars({ headerStart: "#0a2540", headerEnd: "#12395f" });
    expect(v["--brand-header"]).toBe("linear-gradient(90deg, #0a2540, #12395f)");
    expect(v["--brand-header-on"]).toBe("#ffffff");
    expect(brandVars({ headerStart: "#7a7a7a", headerEnd: "#7a7a7a" })["--brand-header"]).toBeUndefined();
    expect(brandVars({ headerStart: "#0a2540", headerEnd: "#ffffff" })["--brand-header"]).toBeUndefined();
  });

  it("a bad primary does not take the header colours down with it", () => {
    const v = brandVars({ primary: "#808080", headerStart: "#0a2540" });
    expect(v["--ping-red"]).toBeUndefined();
    expect(v["--brand-header"]).toBeDefined();
  });
});
