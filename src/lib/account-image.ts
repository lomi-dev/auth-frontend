/** GitHub account photos only; never load arbitrary account-provided URLs. */
export function validateAccountImage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "avatars.githubusercontent.com" ||
      url.username || url.password || url.port || value.includes("#")
    ) return null;
    return url.href;
  } catch {
    return null;
  }
}
