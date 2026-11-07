import { availableParallelism } from "node:os";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: the API runs on :4720 (npm run dev -w server). Set APP_ORIGIN=http://localhost:4723 for it,
// since the browser's Origin is the Vite page, not the API.
const api = { target: "http://localhost:4720" };

export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": api, "/auth": api } },
  test: {
    environment: "jsdom", globals: true, setupFiles: "./src/testSetup.js", testTimeout: 20000,
    // One jsdom worker per core is too many when the machine is shared: on a 16-core host at load 200 the page tests took 80 s instead of 15 s,
    // and vitest gave up on its own 60 s worker-to-runner message ("Timeout calling onTaskUpdate") although every test had passed.
    // Six workers finish sooner under load and cost nothing on a small CI runner (it has fewer cores than that).
    maxWorkers: Math.min(6, Math.max(1, availableParallelism() - 1)),
  },
});
