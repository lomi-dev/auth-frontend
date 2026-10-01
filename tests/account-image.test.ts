import { expect, test } from "bun:test";
import { validateAccountImage } from "../src/lib/account-image";

test("account photos accept only HTTPS GitHub avatars", () => {
  expect(validateAccountImage("https://avatars.githubusercontent.com/u/123?v=4")).toBe("https://avatars.githubusercontent.com/u/123?v=4");
  expect(validateAccountImage("https://avatars.githubusercontent.com:443/u/123")).toBe("https://avatars.githubusercontent.com/u/123");
  for (const image of [undefined, null, 42, "", "data:image/png;base64,abc", "http://avatars.githubusercontent.com/u/123", "https://avatars.githubusercontent.com.evil.example/u/123", "https://user@avatars.githubusercontent.com/u/123", "https://avatars.githubusercontent.com:444/u/123", "https://avatars.githubusercontent.com/u/123#", "https://example.com/avatar.png"]) {
    expect(validateAccountImage(image)).toBeNull();
  }
});
