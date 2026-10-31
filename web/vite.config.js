import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: the API runs on :4720 (npm run dev -w server). Set APP_ORIGIN=http://localhost:4723 for it,
// since the browser's Origin is the Vite page, not the API.
const api = { target: "http://localhost:4720" };

export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": api, "/auth": api } },
  test: { environment: "jsdom", globals: true, setupFiles: "./src/testSetup.js", testTimeout: 20000 },
});
