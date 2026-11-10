import { parseBoolean } from '../shared/util.js';

export const PALETTES = {
  dark: {
    ink: '#0f1115',
    surface: '#171a21',
    surface2: '#1e222b',
    border: '#2b303b',
    text: '#e8e4dc',
    muted: '#9a958c',
    faint: '#6b675f',
    accent: '#f2b35c',
    accent2: '#e58b8b',
    success: '#8fc98f',
    warning: '#e6c06a',
    danger: '#e06c75',
    info: '#86b9d8',
  },
  paper: {
    ink: '#f4f0e8',
    surface: '#ebe5da',
    surface2: '#e1dacd',
    border: '#c9c0b0',
    text: '#24211c',
    muted: '#6b6459',
    faint: '#8a8276',
    accent: '#a86414',
    accent2: '#b45050',
    success: '#2f7a3f',
    warning: '#8a6416',
    danger: '#b23a44',
    info: '#2f6b8a',
  },
};

export const GLYPHS = {
  cat: 'ᓚᘏᗢ',
  cursor: '▌',
  bar: '│',
  bullet: '·',
  checked: '✓',
  failed: '✗',
  running: '◐',
  pending: '○',
  arrow: '›',
  scrollUp: '↑',
};

const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

export function stripAnsi(value) {
  return String(value ?? '').replace(ANSI_RE, '');
}

export function visibleWidth(value) {
  const text = stripAnsi(value);
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0);
    if (!code) continue;
    if (code === 0x200d || (code >= 0x0300 && code <= 0x036f)) continue;
    if (
      (code >= 0x1100 && code <= 0x115f)
      || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe30 && code <= 0xfe4f)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6)
      || (code >= 0x1f300 && code <= 0x1faff)
      || (code >= 0x1f900 && code <= 0x1f9ff)
      || (code >= 0x1f680 && code <= 0x1f6ff)
      || (code >= 0x2600 && code <= 0x26ff)
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

export function sliceVisible(value, start, length = Infinity) {
  const text = String(value ?? '');
  let visible = 0;
  let index = 0;
  let output = '';
  while (index < text.length && visible < start) {
    if (text[index] === '\u001b') {
      const match = /^\u001b\[[0-?]*[ -/]*[@-~]/.exec(text.slice(index));
      if (match) {
        index += match[0].length;
        continue;
      }
    }
    const char = String.fromCodePoint(text.codePointAt(index));
    index += char.length;
    visible += visibleWidth(char);
  }
  while (index < text.length && length > 0) {
    if (text[index] === '\u001b') {
      const match = /^\u001b\[[0-?]*[ -/]*[@-~]/.exec(text.slice(index));
      if (match) {
        output += match[0];
        index += match[0].length;
        continue;
      }
    }
    const char = String.fromCodePoint(text.codePointAt(index));
    const width = visibleWidth(char);
    if (width > length) break;
    output += char;
    index += char.length;
    length -= width;
  }
  return output;
}

export function truncateVisible(value, width, ellipsis = '…') {
  if (width <= 0) return '';
  if (visibleWidth(value) <= width) return value;
  const ellipsisWidth = visibleWidth(ellipsis);
  return `${sliceVisible(value, 0, Math.max(0, width - ellipsisWidth))}${ellipsis}`;
}

export function padEndVisible(value, width) {
  const text = String(value ?? '');
  const padding = Math.max(0, width - visibleWidth(text));
  return `${text}${' '.repeat(padding)}`;
}

export function centerVisible(value, width) {
  const text = String(value ?? '');
  const left = Math.max(0, Math.floor((width - visibleWidth(text)) / 2));
  return `${' '.repeat(left)}${text}`;
}

/**
 * Truncate a string to a maximum visible width, stripping ANSI escapes so
 * long error output or command text cannot wrap past the viewport and break
 * the frame layout. Returns the original string if it already fits.
 */
export function truncateToWidth(value, maxWidth, ellipsis = '…') {
  const text = stripAnsi(String(value ?? ''));
  const width = Math.max(0, maxWidth);
  if (visibleWidth(text) <= width) return text;
  const ellipsisWidth = visibleWidth(ellipsis);
  const keep = Math.max(0, width - ellipsisWidth);
  return `${sliceVisible(text, 0, keep)}${ellipsis}`;
}

export function createStyler(paletteName = 'dark', { enabled = true } = {}) {
  const palette = PALETTES[paletteName] || PALETTES.dark;
  const hexToRgb = (hex) => {
    const clean = hex.replace('#', '');
    const value = parseInt(clean, 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  };
  const fg = (hex, text) => {
    if (!enabled) return String(text ?? '');
    const [r, g, b] = hexToRgb(palette[hex] || hex);
    return `\u001b[38;2;${r};${g};${b}m${text}\u001b[39m`;
  };
  const bg = (hex, text) => {
    if (!enabled) return String(text ?? '');
    const [r, g, b] = hexToRgb(palette[hex] || hex);
    return `\u001b[48;2;${r};${g};${b}m${text}\u001b[49m`;
  };
  const bold = (text) => (enabled ? `\u001b[1m${text}\u001b[22m` : String(text ?? ''));
  const dim = (text) => (enabled ? `\u001b[2m${text}\u001b[22m` : String(text ?? ''));
  const italic = (text) => (enabled ? `\u001b[3m${text}\u001b[23m` : String(text ?? ''));
  const underline = (text) => (enabled ? `\u001b[4m${text}\u001b[24m` : String(text ?? ''));
  const inverse = (text) => (enabled ? `\u001b[7m${text}\u001b[27m` : String(text ?? ''));
  return { palette, fg, bg, bold, dim, italic, underline, inverse, enabled };
}

export function colorEnabled({ force = false } = {}) {
  if (process.env.NO_COLOR !== undefined && !force) return false;
  if (parseBoolean(process.env.FORCE_COLOR, false)) return true;
  return true;
}

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
export const THINKING = ['ᨐ  ', 'ᨐ· ', 'ᨐ··', 'ᨐ···'];

export function selectGlyph(sequence, tick) {
  return sequence[Math.abs(Math.floor(tick)) % sequence.length];
}
