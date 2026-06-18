function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

module.exports = {
  clamp,
  escapeHtml,
  normalizeText,
  sleep,
  unique,
};
