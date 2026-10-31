import "@testing-library/jest-dom/vitest";

// Node 25+ has its own localStorage global (unusable without --localstorage-file) that hides jsdom's.
if (typeof globalThis.localStorage?.clear !== "function") {
  Object.defineProperty(globalThis, "localStorage", { value: globalThis.jsdom.window.localStorage, configurable: true });
}

// jsdom has no ResizeObserver; @xyflow/react needs one to mount.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}
