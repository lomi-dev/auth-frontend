import { defineConfig } from "astro/config";

export default defineConfig({
  output: "static",
  prefetch: false,
  build: {
    assets: "assets",
    inlineStylesheets: "never",
  },
  vite: {
    build: {
      assetsInlineLimit: 0,
    },
    server: {
      port: 4321,
      strictPort: true,
      proxy: {
        "/api/auth": {
          target: "http://127.0.0.1:3001",
          changeOrigin: false,
          secure: false,
        },
        "/v1": {
          target: "http://127.0.0.1:3001",
          changeOrigin: false,
          secure: false,
        },
        "/health": {
          target: "http://127.0.0.1:3001",
          changeOrigin: false,
          secure: false,
        },
      },
    },
  },
});
