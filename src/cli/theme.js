import { parseBoolean } from '../shared/util.js';

export const PALETTES = {
  dark: {
    ink: '#0f1115',
    surface: '#171a21',
    surface2: '#1e222b',
    surface3: '#262b36',
    border: '#2b303b',
    text: '#e8e4dc',
    muted: '#9a958c',
    faint: '#6b675f',
    accent: '#f2b35c',
    accentBg: '#2e2418',
    accent2: '#e58b8b',
    accent2Bg: '#2d1e21',
    success: '#8fc98f',
    successBg: '#1b291e',
    warning: '#e6c06a',
    warningBg: '#2d2618',
    danger: '#e06c75',
    dangerBg: '#2e1b1f',
    info: '#86b9d8',
    infoBg: '#1a2630',
    image: '#c9a2e8',
    imageBg: '#2b2235',
    paste: '#f0a45c',
    pasteBg: '#33271c',
    codeKeyword: '#f2b35c',
    codeString: '#8fc98f',
    codeComment: '#6b675f',
    codeNumber: '#e58b8b',
  },
  paper: {
    ink: '#f4f0e8',
    surface: '#ebe5da',
    surface2: '#e1dacd',
    surface3: '#d6cebf',
    border: '#c9c0b0',
    text: '#24211c',
    muted: '#6b6459',
    faint: '#8a8276',
    accent: '#a86414',
    accentBg: '#eadcc6',
    accent2: '#b45050',
    accent2Bg: '#edd8d5',
    success: '#2f7a3f',
    successBg: '#d8e8d9',
    warning: '#8a6416',
    warningBg: '#ece0c4',
    danger: '#b23a44',
    dangerBg: '#efd5d7',
    info: '#2f6b8a',
    infoBg: '#d7e5ee',
    image: '#70448f',
    imageBg: '#ebe0f4',
    paste: '#94550f',
    pasteBg: '#f3e3cd',
    codeKeyword: '#a86414',
    codeString: '#2f7a3f',
    codeComment: '#8a8276',
    codeNumber: '#b45050',
  },
  midnight: {
    ink: '#0a0d14',
    surface: '#111622',
    surface2: '#182032',
    surface3: '#212b42',
    border: '#26314a',
    text: '#e6ebf5',
    muted: '#8d99b3',
    faint: '#5a6580',
    accent: '#f5bd65',
    accentBg: '#2b2318',
    accent2: '#ea8c9a',
    accent2Bg: '#2c1c24',
    success: '#7dd3a0',
    successBg: '#162922',
    warning: '#ecc674',
    warningBg: '#2c2618',
    danger: '#e56f7c',
    dangerBg: '#2d1920',
    info: '#7cc4eb',
    infoBg: '#152536',
    image: '#caa5f0',
    imageBg: '#271f38',
    paste: '#f2a863',
    pasteBg: '#302419',
    codeKeyword: '#f5bd65',
    codeString: '#7dd3a0',
    codeComment: '#5a6580',
    codeNumber: '#ea8c9a',
  },
  ember: {
    ink: '#13100f',
    surface: '#1b1715',
    surface2: '#241f1c',
    surface3: '#2f2824',
    border: '#3a312c',
    text: '#ede6de',
    muted: '#a4988f',
    faint: '#736860',
    accent: '#f4a261',
    accentBg: '#332216',
    accent2: '#e78284',
    accent2Bg: '#331d1f',
    success: '#94c98a',
    successBg: '#1d2b1c',
    warning: '#e9c46a',
    warningBg: '#312817',
    danger: '#e06c75',
    dangerBg: '#321b1e',
    info: '#8ab8d0',
    infoBg: '#1c272e',
    image: '#cfa4e6',
    imageBg: '#2d2133',
    paste: '#f4a261',
    pasteBg: '#362417',
    codeKeyword: '#f4a261',
    codeString: '#94c98a',
    codeComment: '#736860',
    codeNumber: '#e78284',
  },
};

export const THEME_NAMES = Object.freeze(['dark', 'paper', 'midnight', 'ember']);

export const THEME_LABELS = Object.freeze({
  dark: 'obsidian amber (default)',
  paper: 'warm parchment (light)',
  midnight: 'deep navy & gold',
  ember: 'warm charcoal & copper',
});

export const GLYPHS = {
  cat: 'ᓚᘏᗢ',
  catAlert: 'ᓚᘏᗣ',
  cursor: '▌',
  bar: '│',
  thickBar: '┃',
  bullet: '·',
  checked: '✓',
  failed: '✗',
  running: '◐',
  pending: '○',
  active: '●',
  arrow: '›',
  caret: '▸',
  caretDown: '▾',
  diamond: '◆',
  spark: '✦',
  scrollUp: '↑',
  scrollDown: '↓',
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
  const strike = (text) => (enabled ? `\u001b[9m${text}\u001b[29m` : String(text ?? ''));
  const inverse = (text) => (enabled ? `\u001b[7m${text}\u001b[27m` : String(text ?? ''));
  const pill = (fgColor, bgColor, text, { pad = true, isBold = false } = {}) => {
    const content = pad ? ` ${text} ` : String(text ?? '');
    const styled = isBold ? bold(fg(fgColor, content)) : fg(fgColor, content);
    return bg(bgColor, styled);
  };
  return { palette, fg, bg, bold, dim, italic, underline, strike, inverse, pill, enabled };
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
