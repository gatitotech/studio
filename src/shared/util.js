import crypto from 'node:crypto';

export const nowMs = () => Date.now();

export function randomId(prefix = 'id') {
  return `${prefix}_${crypto.randomBytes(12).toString('base64url')}`;
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function hmacSha256(secret, value) {
  return crypto.createHmac('sha256', String(secret)).update(String(value)).digest('hex');
}

export function timingSafeEqualText(left, right) {
  const a = Buffer.from(String(left ?? ''), 'utf8');
  const b = Buffer.from(String(right ?? ''), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function safeJsonParse(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function truncate(value, max = 200) {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  if (max <= 1) return text.slice(0, max);
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function truncateMiddle(value, max = 120) {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  const half = Math.floor((max - 1) / 2);
  return `${text.slice(0, half)}…${text.slice(-half)}`;
}

export function truncateByBytes(value, maxBytes) {
  const text = String(value ?? '');
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return text;
  return `${buffer.subarray(0, Math.max(0, maxBytes - 1)).toString('utf8')}…`;
}

export function estimateTextTokens(value) {
  const text = String(value ?? '');
  if (!text) return 0;
  return Math.ceil(text.length / 3.6);
}

export function estimateContentTokens(content) {
  if (typeof content === 'string') return estimateTextTokens(content);
  if (!Array.isArray(content)) return content == null ? 0 : estimateTextTokens(JSON.stringify(content));
  let total = 0;
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text') total += estimateTextTokens(part.text);
    else if (part.type === 'image_url') total += 1500;
    else total += estimateTextTokens(JSON.stringify(part));
  }
  return total;
}

export function estimateMessagesTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  let total = 3;
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    total += 4;
    total += estimateContentTokens(message.content);
    if (message.tool_calls) total += estimateTextTokens(JSON.stringify(message.tool_calls));
    if (message.name) total += estimateTextTokens(message.name);
  }
  return total;
}

export function formatTokens(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '0';
  const abs = Math.abs(number);
  const sign = number < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}${trimDecimal(abs / 1_000_000_000)}B`;
  if (abs >= 1_000_000) return `${sign}${trimDecimal(abs / 1_000_000)}M`;
  if (abs >= 1_000) return `${sign}${trimDecimal(abs / 1_000)}K`;
  return `${sign}${Math.round(abs)}`;
}

function trimDecimal(value) {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

export function formatBytes(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return '0 B';
  if (number < 1024) return `${Math.round(number)} B`;
  if (number < 1024 * 1024) return `${trimDecimal(number / 1024)} KB`;
  if (number < 1024 * 1024 * 1024) return `${trimDecimal(number / (1024 * 1024))} MB`;
  return `${trimDecimal(number / (1024 * 1024 * 1024))} GB`;
}

export function formatDuration(ms, { compact = false } = {}) {
  const number = Number(ms);
  if (!Number.isFinite(number) || number < 0) return '0s';
  const seconds = Math.round(number / 1000);
  if (seconds < 1) return '<1s';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes && (!days || !compact)) parts.push(`${minutes}m`);
  if (secs && !days && !hours && parts.length < 2) parts.push(`${secs}s`);
  return parts.slice(0, compact ? 2 : 3).join(' ') || '0s';
}

export function formatClock(ms) {
  const number = Number(ms);
  if (!Number.isFinite(number) || number <= 0) return '';
  const date = new Date(number);
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function formatDateTime(ms) {
  const number = Number(ms);
  if (!Number.isFinite(number) || number <= 0) return '';
  return new Date(number).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatRelative(ms, now = Date.now()) {
  const number = Number(ms);
  if (!Number.isFinite(number) || number <= 0) return '';
  const diff = Math.max(0, now - number);
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return formatDateTime(number);
}

export function redactSecrets(value) {
  let text = String(value ?? '');
  text = text.replace(/\b(nvapi-|sk-|gst_|ghp_|github_pat_)[A-Za-z0-9_-]{8,}/g, '$1[redacted]');
  text = text.replace(/(authorization:\s*bearer\s+)[^\s]+/gi, '$1[redacted]');
  text = text.replace(/((?:api[_-]?key|token|secret|password|passwd|pwd)\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[redacted]');
  return text;
}

export function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'y'].includes(text)) return true;
  if (['0', 'false', 'no', 'off', 'n'].includes(text)) return false;
  return fallback;
}

export function parseNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function parseList(value, separator = ',') {
  return String(value ?? '')
    .split(separator)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new Error('Aborted'));
      return;
    }
    const timer = setTimeout(resolve, Math.max(0, Number(ms) || 0));
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(signal.reason || new Error('Aborted'));
      }, { once: true });
    }
  });
}

export function maskEmail(value) {
  const text = String(value ?? '');
  const at = text.indexOf('@');
  if (at <= 0) return text ? `${text.slice(0, 2)}***` : '';
  const name = text.slice(0, at);
  const domain = text.slice(at + 1);
  const head = name.slice(0, Math.min(2, name.length));
  return `${head}${'*'.repeat(Math.max(2, Math.min(6, name.length - head.length)))}@${domain}`;
}

export function plural(count, singular, pluralForm = `${singular}s`) {
  return Number(count) === 1 ? singular : pluralForm;
}

export function uniqueBy(items, keyFn) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

export function chunked(items, size) {
  const list = Array.isArray(items) ? items : [];
  const result = [];
  for (let index = 0; index < list.length; index += size) {
    result.push(list.slice(index, index + size));
  }
  return result;
}

export function stripAnsi(value) {
  return String(value ?? '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
}

export function normalizeNewlines(value) {
  return String(value ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function basenameForDisplay(value) {
  const text = String(value ?? '');
  const parts = text.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || text;
}
