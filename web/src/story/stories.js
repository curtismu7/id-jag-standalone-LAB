// All story files and vertical packs, loaded at build time. Add a file to data/stories or data/verticals and it is picked up.

const byFile = (mods) => Object.values(mods).map((m) => m.default ?? m);

export const STORIES = byFile(import.meta.glob("../data/stories/*.json", { eager: true })).sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
export const VERTICALS = byFile(import.meta.glob("../data/verticals/*.json", { eager: true }));

export const DEFAULT_VERTICAL = "generic";
export const verticalById = (id) => VERTICALS.find((v) => v.id === id) || VERTICALS.find((v) => v.id === DEFAULT_VERTICAL);
/** The story that runs in a playground mode: the first one that names it, else null. */
export const storyForMode = (mode) => STORIES.find((s) => s.modes.includes(mode)) || null;
