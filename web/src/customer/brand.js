// Turns a customer's brand colours into CSS variables, or nothing when they would be unreadable.
// The server has already checked the shape (#rrggbb); this decides legibility (WCAG AA, 4.5:1 for text).

const DARK_INK = "#051727"; // Core Dark: the text colour used on light brand colours
const LIGHT_BG = "#ffffff"; // card background, light theme
const DARK_BG = "#0b2033"; // card background, dark theme
const AA = 4.5;

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const channel = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const luminance = (hex) => { const [r, g, b] = rgb(hex).map(channel); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const darken = (hex, f) => `#${rgb(hex).map((c) => Math.round(c * f).toString(16).padStart(2, "0")).join("")}`;

/** White or Core Dark text, whichever reads better on all the given backgrounds; null if neither reaches AA. */
export function readableOn(...backgrounds) {
  const score = (ink) => Math.min(...backgrounds.map((b) => contrast(ink, b)));
  const best = score("#ffffff") >= score(DARK_INK) ? "#ffffff" : DARK_INK;
  return score(best) >= AA ? best : null;
}

/** CSS variables for :root. An empty object means "keep the Ping defaults". */
export function brandVars(brand) {
  const vars = {};
  const { primary, headerStart, headerEnd } = brand || {};
  if (primary) {
    const deep = darken(primary, 0.8);
    const on = readableOn(primary, deep);
    // As accent text the colour must read on the card of at least one theme; each theme falls back to the Ping red where it does not.
    const light = contrast(primary, LIGHT_BG) >= AA;
    const dark = contrast(primary, DARK_BG) >= AA;
    if (on && (light || dark)) {
      Object.assign(vars, { "--ping-red": primary, "--ping-red-deep": deep, "--brand-on": on });
      if (light) vars["--brand-text-light"] = primary;
      if (dark) vars["--brand-text-dark"] = primary;
    }
  }
  const ends = [headerStart, headerEnd].filter(Boolean);
  const headerOn = ends.length ? readableOn(...ends) : null;
  if (headerOn) {
    vars["--brand-header"] = `linear-gradient(90deg, ${headerStart || headerEnd}, ${headerEnd || headerStart})`;
    vars["--brand-header-on"] = headerOn;
    vars["--brand-header-soft"] = `${headerOn}c7`; // 78% alpha, the muted nav-link tone
  }
  return vars;
}
