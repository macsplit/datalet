import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";

export default defineConfig({
  plugins: [react(), wasm()],
  server: {
    headers: {
      "Access-Control-Allow-Private-Network": "true",
    },
  },
  envPrefix: ["VITE_", "NG_"],
});
