// Checks a story file and a vertical pack. Returns a list of problems (empty = valid); no thrown errors, so a
// test can print every problem at once. Hand-rolled: a schema library is not worth a dependency for ~10 fields.

const isStr = (v) => typeof v === "string" && v.trim().length > 0;
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

export function validateStory(s, { modes = [], stepRange = [1, 6] } = {}) {
  const e = [];
  const at = (path, msg) => e.push(`${s?.id || "?"}: ${path} ${msg}`);
  if (!isObj(s)) return ["story is not an object"];
  if (!/^S\d+[a-z]?$/.test(s.id || "")) at("id", "must look like S11 or S11b");
  for (const k of ["title", "goal", "obstacle", "control", "say"]) if (!isStr(s[k])) at(k, "is required text");
  if (!Array.isArray(s.modes) || !s.modes.length) at("modes", "needs at least one playground mode");
  else for (const m of s.modes) if (modes.length && !modes.includes(m)) at("modes", `names unknown mode "${m}"`);
  if (!Array.isArray(s.steps) || !s.steps.length) at("steps", "needs at least one step");
  else {
    const seen = new Set();
    for (const st of s.steps) {
      const p = `steps[n=${st?.n}]`;
      if (!Number.isInteger(st?.n) || st.n < stepRange[0] || st.n > stepRange[1]) at(p, `n must be an integer ${stepRange[0]}-${stepRange[1]}`);
      if (seen.has(st?.n)) at(p, "duplicates another step");
      seen.add(st?.n);
      for (const k of ["title", "tell", "say", "why"]) if (!isStr(st?.[k])) at(`${p}.${k}`, "is required text");
      if (st?.blocked !== undefined) {
        if (!isObj(st.blocked) || !isStr(st.blocked.tell) || !isStr(st.blocked.say)) at(`${p}.blocked`, "needs tell and say");
      }
    }
    const ns = s.steps.map((x) => x.n);
    if (ns.some((n, i) => i > 0 && n <= ns[i - 1])) at("steps", "must be in ascending order of n");
  }
  if (!isObj(s.proof) || !isStr(s.proof.happy) || !isStr(s.proof.blocked)) at("proof", "needs happy and blocked text");
  if (s.demos !== undefined && (!Array.isArray(s.demos) || s.demos.some((d) => !/^[A-F]\d+$/.test(d)))) at("demos", "must be catalog ids like C1");
  return e;
}

export function validateVertical(v) {
  const e = [];
  const at = (path, msg) => e.push(`${v?.id || "?"}: ${path} ${msg}`);
  if (!isObj(v)) return ["vertical is not an object"];
  if (!/^[a-z][a-z0-9-]*$/.test(v.id || "")) at("id", "must be lowercase letters, digits, dashes");
  for (const k of ["displayName", "tagline", "source"]) if (!isStr(v[k])) at(k, "is required text");
  for (const k of ["primary", "headerStart", "headerEnd"]) if (!/^#[0-9a-fA-F]{6}$/.test(v.brand?.[k] || "")) at(`brand.${k}`, "must be a #rrggbb color");
  if (!isObj(v.vocab) || Object.values(v.vocab).some((x) => !isStr(x))) at("vocab", "must map names to text");
  if (!isObj(v.cast) || Object.values(v.cast).some((c) => !isStr(c?.name) || !isStr(c?.role))) at("cast", "must map ids to { name, role }");
  return e;
}
