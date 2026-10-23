import { defineConfig } from "vite";

export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:4173",
      "/plugin-assets": "http://127.0.0.1:4173",
      "/media": "http://127.0.0.1:4173",
    },
  },
  build: { target: "es2022" },
});

