// Per-step teaching detail for the playground diagrams, built from per-mode data objects in
// ./idJagDetail/. Each object is { [step number]: { forms, tokens, refs } }:
//   forms:  [{ title, code }]                 the request on the wire (code is a plain string)
//   tokens: [{ note, header?, claims }]       MOCK tokens (objects), teaching values only
//   refs:   [{ id, title, kind }]             kind "rfc" | "spec" | "emerging" (see idJagStandards.js)
import mock from "./idJagDetail/mock.js";
import pf from "./idJagDetail/pf.js";
import acme from "./idJagDetail/acme.js";
import byo from "./idJagDetail/byo.js";
import gateway from "./idJagDetail/gateway.js";

// Diagram mode ids (mock, pf-as, pf-pf, byo, gateway-redeem) and the detail file names both resolve.
const DATA = { mock, pf, acme, byo, "pf-as": pf, "pf-pf": acme, "gateway-redeem": gateway };

/** { forms, tokens, refs } for a step (refs de-duplicated by id), or null when the step has none. */
export function stepDetail(mode, step) {
  const s = DATA[mode]?.[step];
  if (!s) return null;
  const forms = s.forms || [];
  const tokens = s.tokens || [];
  const refs = [...new Map((s.refs || []).map((r) => [r.id, r])).values()];
  return forms.length || tokens.length || refs.length ? { forms, tokens, refs } : null;
}
