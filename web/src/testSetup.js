import "@testing-library/jest-dom/vitest";
import { configure } from "@testing-library/react";

// findBy*/waitFor stop waiting as soon as their condition holds, so this is only how long a test that is going to FAIL waits before
// saying so. The 1000 ms default is wall-clock: a test process that the OS leaves unscheduled for a second (a loaded laptop, a shared CI
// runner) fails a correct render. Stays under the 20 s testTimeout so a real failure still reports the assertion, not a timeout.
configure({ asyncUtilTimeout: 10000 });

// Node 25+ has its own localStorage global (unusable without --localstorage-file) that hides jsdom's.
if (typeof globalThis.localStorage?.clear !== "function") {
  Object.defineProperty(globalThis, "localStorage", { value: globalThis.jsdom.window.localStorage, configurable: true });
}

// jsdom has no ResizeObserver; @xyflow/react needs one to mount.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}
