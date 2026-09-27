const DEVICE_CODE_ALPHABET = /^[A-HJ-NP-Z2-9]{8}$/;

/** Match Better Auth's default device-code alphabet after removing separators. */
export function normalizeDeviceCode(value: string): string | null {
  const normalized = value.replace(/[^a-z0-9]/gi, "").toUpperCase();
  return DEVICE_CODE_ALPHABET.test(normalized) ? normalized : null;
}

export function formatDeviceCode(value: string): string {
  return `${value.slice(0, 4)} ${value.slice(4)}`;
}

export function readDeviceCodeFromLocation(search: string): string | null {
  const params = new URLSearchParams(search);
  const values = params.getAll("user_code");
  if (values.length !== 1) return null;
  return normalizeDeviceCode(values[0] ?? "");
}
