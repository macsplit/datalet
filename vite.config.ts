import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const SYNC_SERVER_URL = process.env.SYNC_SERVER_URL ?? "http://127.0.0.1:3000";

export default defineConfig({
  plugins: [react()],
  server: {
    // `vite dev` only serves the SPA - it knows nothing about `/sync/*`.
    // In production one Node process serves both (see server/); in dev,
    // proxy to that process (run separately via `pnpm dev:server`) so
    // "Create sync vault" etc. work without a full build.
    proxy: {
      "/sync": { target: SYNC_SERVER_URL, changeOrigin: true },
    },
  },
});
