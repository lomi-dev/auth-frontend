import { createAuthClient } from "better-auth/client";
import { deviceAuthorizationClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  baseURL: window.location.origin,
  plugins: [deviceAuthorizationClient()],
  fetchOptions: {
    cache: "no-store",
    credentials: "same-origin",
    headers: {
      "X-Lomi-Request": "1",
    },
  },
});
