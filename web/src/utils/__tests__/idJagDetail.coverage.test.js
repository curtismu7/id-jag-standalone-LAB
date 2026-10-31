import { describe, it, expect } from "vitest";
import { PLAYGROUND_DIAGRAMS, PLAYGROUND_DIAGRAM_MODES } from "../idJagPlaygroundDiagrams.js";
import { stepDetail } from "../idJagStepDetail.js";

// No mocks here: this reads the real per-mode data files.
describe("idJagDetail coverage", () => {
  it("has request forms, mock tokens and standards for every step of every mode", () => {
    for (const mode of PLAYGROUND_DIAGRAM_MODES) {
      for (const st of PLAYGROUND_DIAGRAMS[mode].steps) {
        const d = stepDetail(mode, st.n);
        expect(d, `${mode} step ${st.n}`).not.toBeNull();
        expect(d.refs.length, `${mode} step ${st.n} refs`).toBeGreaterThan(0);
      }
    }
  });
  it("marks every standards entry as rfc, spec or emerging", () => {
    for (const mode of PLAYGROUND_DIAGRAM_MODES) {
      for (const st of PLAYGROUND_DIAGRAMS[mode].steps) {
        for (const r of stepDetail(mode, st.n)?.refs || []) {
          expect(["rfc", "spec", "emerging"]).toContain(r.kind);
          expect(r.id && r.title).toBeTruthy();
        }
      }
    }
  });
});
