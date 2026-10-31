// Story text is written once with tokens; a vertical pack supplies the names and nouns.
//   {{lena}}          a cast id, replaced by that person's name
//   {{vocab.partner}} a vocabulary entry of the vertical
// A customer persona ({ lena: "Priya" }) overrides a cast name.
// A token nothing defines stays visible as ⟨missing: token⟩ so a gap is seen, not hidden.

const TOKEN = /\{\{\s*([\w.]+)\s*\}\}/g;

export function fill(text, vertical, persona) {
  if (typeof text !== "string") return text;
  return text.replace(TOKEN, (_m, key) => {
    if (key.startsWith("vocab.")) return vertical?.vocab?.[key.slice(6)] ?? `⟨missing: ${key}⟩`;
    return persona?.[key] ?? vertical?.cast?.[key]?.name ?? `⟨missing: ${key}⟩`;
  });
}

/** Every token used anywhere in a value (string, array or object), as "lena" / "vocab.partner". */
export function tokensIn(value, found = new Set()) {
  if (typeof value === "string") for (const m of value.matchAll(TOKEN)) found.add(m[1]);
  else if (Array.isArray(value)) value.forEach((v) => tokensIn(v, found));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => tokensIn(v, found));
  return found;
}

/** Same walk as fill(), over a whole story (copy; the input is not changed). */
export function fillAll(value, vertical, persona) {
  if (typeof value === "string") return fill(value, vertical, persona);
  if (Array.isArray(value)) return value.map((v) => fillAll(v, vertical, persona));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillAll(v, vertical, persona)]));
  return value;
}
