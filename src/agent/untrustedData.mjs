const OPEN = "<untrusted_data>";
const CLOSE = "</untrusted_data>";

export function wrapUntrustedData(value, { maxChars = 2000 } = {}) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const safe = String(text ?? "").slice(0, maxChars)
    .replaceAll(OPEN, "&lt;untrusted_data&gt;")
    .replaceAll(CLOSE, "&lt;/untrusted_data&gt;");
  return `${OPEN}${safe}${CLOSE}`;
}

export function containsUntrustedData(messages = []) {
  return messages.some((message) => String(message?.content || "").includes(OPEN) && String(message?.content || "").includes(CLOSE));
}
