import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { CONTENT_SECURITY_POLICY_META } from "./server/src/contentSecurityPolicy.js";

const SYNC_SERVER_URL = process.env.SYNC_SERVER_URL ?? "http://127.0.0.1:3000";

/**
 * Injects the CSP into built HTML only. `vite dev` is deliberately left
 * unrestricted because @vitejs/plugin-react serves its refresh preamble as an
 * inline module script, which `script-src 'self'` blocks - loosening the
 * policy to accommodate a dev-only script would weaken what ships. The built
 * app is what the offline suite exercises, so the shipped policy is still
 * covered by tests.
 */
function contentSecurityPolicy(): Plugin {
  return {
    name: "local-graph-csp",
    apply: "build",
    transformIndexHtml(html) {
      return {
        html,
        tags: [{
          tag: "meta",
          attrs: {
            "http-equiv": "Content-Security-Policy",
            content: CONTENT_SECURITY_POLICY_META,
          },
          injectTo: "head-prepend",
        }],
      };
    },
  };
}

export default defineConfig({
  plugins: [react(), contentSecurityPolicy()],
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
