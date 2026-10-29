import { defineConfig } from "astro/config";

const authApiProxy = {
  target: "http://127.0.0.1:3001",
  changeOrigin: false,
  secure: false,
};

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
        "/api/auth": authApiProxy,
        "/v1": authApiProxy,
        "/health": authApiProxy,
        "/v2/remote/consumer-authorizations": authApiProxy,
        "/v2/remote/consumer-windows": authApiProxy,
        "/v2/remote/host-authorizations": authApiProxy,
        "/v2/remote/hosts": authApiProxy,
        "/v2/remote/enrollments": authApiProxy,
      },
    },
  },
});
