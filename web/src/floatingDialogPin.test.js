// The vendored FloatingDialog (web/src/floating-dialog) must stay byte for byte what floating-dialog.sha256 pins, and the pin names the
// AI-DEMO-Standalone commit it came from. To update: copy shared/floating-dialog from AI-DEMO-Standalone main again, then re-pin.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "floating-dialog");

describe("vendored floating-dialog", () => {
  it("matches floating-dialog.sha256, which names the AI-DEMO-Standalone commit", () => {
    const text = fs.readFileSync(path.join(dir, "floating-dialog.sha256"), "utf8");
    expect(text.split("\n")[0]).toMatch(/^# vendored byte for byte from curtismu7\/AI-DEMO-Standalone shared\/floating-dialog at [0-9a-f]{7,40}/);
    const pins = text.split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(/\s+/));
    expect(pins.map(([, f]) => f).sort()).toEqual(["FloatingDialog.jsx", "floating-dialog.css", "floating-dialog.test.jsx", "geometry.js", "useFloatingPanel.js"]);
    for (const [h, f] of pins) expect(createHash("sha256").update(fs.readFileSync(path.join(dir, f))).digest("hex"), f).toBe(h);
    expect(fs.readdirSync(dir).sort()).toEqual(["FloatingDialog.jsx", "floating-dialog.css", "floating-dialog.sha256", "floating-dialog.test.jsx", "geometry.js", "useFloatingPanel.js"]);
  });
});
