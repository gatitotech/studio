import { stripAnsi, visibleWidth, sliceVisible, padEndVisible, truncateVisible, centerVisible } from '../theme.js';

const hexToRgb = (hex) => {
  const clean = String(hex).replace('#', '');
  const value = Number.parseInt(clean, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
};

export function bgEscape(styler, token = 'ink') {
  const hex = (styler.palette || {})[token] || token || '#0f1115';
  const [r, g, b] = hexToRgb(hex);
  return `\u001b[48;2;${r};${g};${b}m`;
}

export function inkBackground(styler) {
  return bgEscape(styler, 'ink');
}

// Paint a full row with the ink background. Inner background resets (\u001b[49m)
// would otherwise drop back to the terminal default, leaving black gaps.
export function paintRow(line, styler) {
  const inkBg = inkBackground(styler);
  return `${inkBg}${String(line ?? '').replaceAll('\u001b[49m', inkBg)}${inkBg}`;
}

// Fill a line with a surface background while preserving inner fg colors.
export function paintSurface(line, styler, surface = 'surface') {
  if (!styler?.enabled) return String(line ?? '');
  const bg = bgEscape(styler, surface);
  return `${bg}${String(line ?? '').replaceAll('\u001b[49m', bg)}\u001b[49m`;
}

export function badge(styler, text, { fg = 'accent', bg = 'accentBg', bold = false } = {}) {
  const content = ` ${text} `;
  const styled = bold ? styler.bold(styler.fg(fg, content)) : styler.fg(fg, content);
  return styler.bg(bg, styled);
}

const BUTTON_VARIANTS = {
  primary: {
    fg: 'ink', bg: 'accent', iconFg: 'ink', bold: true,
    hoverFg: 'ink', hoverBg: 'warning',
  },
  secondary: {
    fg: 'text', bg: 'surface2', iconFg: 'accent', bold: false,
    hoverFg: 'text', hoverBg: 'surface3', hoverIconFg: 'accent',
  },
  subtle: {
    fg: 'muted', bg: 'surface2', iconFg: 'muted', bold: false,
    hoverFg: 'text', hoverBg: 'surface3', hoverIconFg: 'accent',
  },
  accent: {
    fg: 'accent', bg: 'accentBg', iconFg: 'accent', bold: true,
    hoverFg: 'ink', hoverBg: 'accent', hoverIconFg: 'ink',
  },
  info: {
    fg: 'info', bg: 'infoBg', iconFg: 'info', bold: true,
    hoverFg: 'ink', hoverBg: 'info', hoverIconFg: 'ink',
  },
  success: {
    fg: 'success', bg: 'successBg', iconFg: 'success', bold: true,
    hoverFg: 'ink', hoverBg: 'success', hoverIconFg: 'ink',
  },
  warning: {
    fg: 'warning', bg: 'warningBg', iconFg: 'warning', bold: true,
    hoverFg: 'ink', hoverBg: 'warning', hoverIconFg: 'ink',
  },
  danger: {
    fg: 'danger', bg: 'dangerBg', iconFg: 'danger', bold: true,
    hoverFg: 'ink', hoverBg: 'danger', hoverIconFg: 'ink',
  },
  'plan-pro': {
    fg: 'accent', bg: 'accentBg', iconFg: 'accent', bold: true,
    hoverFg: 'ink', hoverBg: 'accent', hoverIconFg: 'ink',
  },
  'plan-plus': {
    fg: 'info', bg: 'infoBg', iconFg: 'info', bold: true,
    hoverFg: 'ink', hoverBg: 'info', hoverIconFg: 'ink',
  },
  'plan-free': {
    fg: 'text', bg: 'surface3', iconFg: 'muted', bold: true,
    hoverFg: 'ink', hoverBg: 'accent', hoverIconFg: 'ink',
  },
};

export function button(styler, label, {
  variant = 'secondary',
  icon = '',
  trailing = '',
  shortcut = '',
  hovered = false,
  active = false,
  disabled = false,
  compact = false,
} = {}) {
  const spec = BUTTON_VARIANTS[variant] || BUTTON_VARIANTS.secondary;
  const fgColor = disabled ? 'faint'
    : hovered ? (spec.hoverFg || spec.fg)
      : active ? (spec.fg === 'muted' ? 'accent' : spec.fg)
        : spec.fg;
  const bgColor = disabled ? 'surface'
    : hovered ? (spec.hoverBg || 'surface3')
      : active && variant === 'secondary' ? 'accentBg'
        : spec.bg;
  const iconColor = disabled ? 'faint'
    : hovered ? (spec.hoverIconFg || fgColor)
      : active && variant === 'secondary' ? 'accent'
        : (spec.iconFg || fgColor);
  const useBold = !disabled && (spec.bold || hovered || active);
  const pad = compact ? '' : ' ';
  const parts = [];
  if (icon) parts.push(styler.fg(iconColor, icon));
  if (label) {
    const labelStyled = useBold ? styler.bold(styler.fg(fgColor, label)) : styler.fg(fgColor, label);
    parts.push(labelStyled);
  }
  if (trailing) {
    const trailColor = hovered && bgColor === 'accent' ? 'ink' : (disabled ? 'faint' : (hovered ? fgColor : 'muted'));
    parts.push(styler.fg(trailColor, trailing));
  }
  if (shortcut) {
    const keyColor = hovered && ['accent', 'info', 'success', 'warning', 'danger'].includes(bgColor) ? 'ink' : 'faint';
    parts.push(styler.fg(keyColor, `[${shortcut}]`));
  }
  const inner = `${pad}${parts.join(' ')}${pad}`;
  return paintSurface(inner, styler, bgColor);
}

export function placeSegments(segments, { startCol = 0, gap = 1, separator = null } = {}) {
  const list = (Array.isArray(segments) ? segments : []).filter((entry) => entry && entry.text);
  const sepText = separator != null ? String(separator) : ' '.repeat(Math.max(0, gap));
  const sepWidth = visibleWidth(sepText);
  let col = startCol;
  const rendered = [];
  const hits = [];
  for (let index = 0; index < list.length; index += 1) {
    const seg = list[index];
    if (index > 0 && sepWidth > 0) {
      rendered.push(sepText);
      col += sepWidth;
    }
    const width = visibleWidth(seg.text);
    rendered.push(seg.text);
    if (seg.hit) {
      hits.push({ ...seg.hit, col, width });
    }
    col += width;
  }
  return {
    text: rendered.join(''),
    width: col - startCol,
    endCol: col,
    hits,
  };
}

export function horizontalRule(width, styler, { char = '─', color = 'border', label = '' } = {}) {
  const max = Math.max(1, width);
  if (!label) return styler.fg(color, char.repeat(max));
  const tag = ` ${label} `;
  const tagWidth = visibleWidth(tag);
  if (tagWidth >= max - 2) return truncateVisible(styler.fg('muted', tag), max);
  const left = Math.min(2, Math.floor((max - tagWidth) / 2));
  const right = Math.max(0, max - left - tagWidth);
  return `${styler.fg(color, char.repeat(left))}${styler.fg('muted', tag)}${styler.fg(color, char.repeat(right))}`;
}

export function wrapPlain(text, width) {
  const max = Math.max(1, width);
  const output = [];
  for (const rawLine of String(text ?? '').split('\n')) {
    if (rawLine === '') {
      output.push('');
      continue;
    }
    let line = '';
    for (const word of rawLine.split(/(\s+)/)) {
      if (!word) continue;
      if (/^\s+$/.test(word)) {
        if (!line) continue;
        if (visibleWidth(line) + word.length > max) {
          output.push(line);
          line = '';
        } else {
          line += ' ';
        }
        continue;
      }
      let remaining = word;
      while (remaining.length) {
        const available = max - visibleWidth(line);
        if (available <= 0) {
          output.push(line);
          line = '';
          continue;
        }
        if (visibleWidth(remaining) <= available) {
          line += remaining;
          remaining = '';
        } else if (line) {
          output.push(line);
          line = '';
        } else {
          const piece = sliceVisible(remaining, 0, max);
          if (!piece) {
            const first = String.fromCodePoint(remaining.codePointAt(0));
            output.push(first);
            remaining = remaining.slice(first.length);
          } else {
            output.push(piece);
            remaining = remaining.slice(piece.length);
          }
        }
      }
    }
    if (line) output.push(line);
  }
  return output.length ? output : [''];
}

const CODE_KEYWORDS = new Set([
  'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'def', 'del', 'do', 'elif', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'fn', 'for',
  'from', 'func', 'function', 'go', 'if', 'impl', 'import', 'in', 'interface', 'is', 'lambda',
  'let', 'loop', 'match', 'mod', 'mut', 'new', 'nil', 'None', 'not', 'null', 'or', 'package',
  'pass', 'private', 'pub', 'public', 'raise', 'readonly', 'return', 'select', 'self', 'static',
  'struct', 'super', 'switch', 'this', 'throw', 'trait', 'true', 'True', 'False', 'try', 'type',
  'typeof', 'undefined', 'use', 'var', 'void', 'where', 'while', 'with', 'yield',
  'SELECT', 'FROM', 'WHERE', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'CREATE',
  'TABLE', 'JOIN', 'LEFT', 'RIGHT', 'ORDER', 'GROUP', 'BY', 'LIMIT', 'AND', 'OR', 'NOT',
]);

const HASH_COMMENT_LANGS = new Set([
  'py', 'python', 'sh', 'bash', 'zsh', 'shell', 'yaml', 'yml', 'toml', 'rb', 'ruby', 'pl', 'perl',
  'dockerfile', 'docker', 'makefile', 'make', 'conf', 'ini', 'env', 'ps1', 'powershell', 'r',
]);

const DASH_COMMENT_LANGS = new Set(['sql', 'lua', 'haskell', 'hs', 'elm']);

// Four-token syntax highlighter per DESIGN.md: keyword, string, comment, number.
export function highlightCodeLine(line, lang, styler) {
  const source = String(line ?? '');
  if (!styler?.enabled || !source) return styler.fg('text', source);
  const language = String(lang || '').toLowerCase();
  const useHashComment = HASH_COMMENT_LANGS.has(language);
  const useDashComment = DASH_COMMENT_LANGS.has(language);

  let output = '';
  let index = 0;
  let plain = '';
  const flushPlain = () => {
    if (plain) {
      output += styler.fg('text', plain);
      plain = '';
    }
  };

  while (index < source.length) {
    const ch = source[index];
    const next = source[index + 1];

    // Comments
    if ((ch === '/' && next === '/') || (useHashComment && ch === '#') || (useDashComment && ch === '-' && next === '-')) {
      flushPlain();
      output += styler.fg('codeComment', source.slice(index));
      index = source.length;
      break;
    }
    if (ch === '/' && next === '*') {
      flushPlain();
      const close = source.indexOf('*/', index + 2);
      const end = close === -1 ? source.length : close + 2;
      output += styler.fg('codeComment', source.slice(index, end));
      index = end;
      continue;
    }

    // Strings
    if (ch === '"' || ch === '\'' || ch === '`') {
      flushPlain();
      let end = index + 1;
      while (end < source.length) {
        if (source[end] === '\\') {
          end += 2;
          continue;
        }
        if (source[end] === ch) {
          end += 1;
          break;
        }
        end += 1;
      }
      output += styler.fg('codeString', source.slice(index, end));
      index = end;
      continue;
    }

    // Numbers
    if (/[0-9]/.test(ch) && (index === 0 || !/[A-Za-z0-9_$]/.test(source[index - 1]))) {
      const match = /^(?:0x[0-9a-fA-F_]+|0b[01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)/.exec(source.slice(index));
      if (match) {
        flushPlain();
        output += styler.fg('codeNumber', match[0]);
        index += match[0].length;
        continue;
      }
    }

    // Identifiers & keywords
    if (/[A-Za-z_$]/.test(ch)) {
      const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(index));
      if (match) {
        const word = match[0];
        if (CODE_KEYWORDS.has(word)) {
          flushPlain();
          output += styler.fg('codeKeyword', word);
        } else {
          plain += word;
        }
        index += word.length;
        continue;
      }
    }

    plain += ch;
    index += 1;
  }

  flushPlain();
  return output;
}

function parseInline(text) {
  const segments = [];
  const source = String(text ?? '');
  let index = 0;
  let buffer = '';
  const flush = () => {
    if (buffer) segments.push({ text: buffer, bold: false, italic: false, strike: false, code: false, link: false });
    buffer = '';
  };
  while (index < source.length) {
    if (source.startsWith('**', index)) {
      const end = source.indexOf('**', index + 2);
      if (end !== -1 && end > index + 2) {
        flush();
        segments.push({ text: source.slice(index + 2, end), bold: true, italic: false, strike: false, code: false, link: false });
        index = end + 2;
        continue;
      }
    }
    if (source.startsWith('~~', index)) {
      const end = source.indexOf('~~', index + 2);
      if (end !== -1 && end > index + 2) {
        flush();
        segments.push({ text: source.slice(index + 2, end), bold: false, italic: false, strike: true, code: false, link: false });
        index = end + 2;
        continue;
      }
    }
    if (source[index] === '*' && source[index + 1] !== '*' && source[index + 1] !== ' ' && (index === 0 || !/[A-Za-z0-9]/.test(source[index - 1]))) {
      const end = source.indexOf('*', index + 1);
      if (end !== -1 && end > index + 1 && source[end - 1] !== ' ') {
        flush();
        segments.push({ text: source.slice(index + 1, end), bold: false, italic: true, strike: false, code: false, link: false });
        index = end + 1;
        continue;
      }
    }
    if (source[index] === '`') {
      const end = source.indexOf('`', index + 1);
      if (end !== -1) {
        flush();
        segments.push({ text: source.slice(index + 1, end), bold: false, italic: false, strike: false, code: true, link: false });
        index = end + 1;
        continue;
      }
    }
    if (source[index] === '[') {
      const close = source.indexOf(']', index + 1);
      const open = close !== -1 ? source.indexOf('(', close + 1) : -1;
      const end = open !== -1 ? source.indexOf(')', open + 1) : -1;
      if (close !== -1 && open === close + 1 && end !== -1) {
        flush();
        segments.push({ text: source.slice(index + 1, close), bold: false, italic: false, strike: false, code: false, link: true });
        index = end + 1;
        continue;
      }
    }
    buffer += source[index];
    index += 1;
  }
  flush();
  return segments.length ? segments : [{ text: '', bold: false, italic: false, strike: false, code: false, link: false }];
}

function wrapSegments(segments, width) {
  const max = Math.max(1, width);
  const lines = [];
  let current = [];
  let currentWidth = 0;
  const pushLine = () => {
    lines.push(current);
    current = [];
    currentWidth = 0;
  };
  const append = (text, style) => {
    if (!text) return;
    current.push({ text, ...style });
    currentWidth += visibleWidth(text);
  };
  for (const segment of segments) {
    const style = {
      bold: segment.bold,
      italic: segment.italic,
      strike: segment.strike,
      code: segment.code,
      link: segment.link,
    };
    const tokens = segment.text.split(/(\n|[ \t]+)/);
    for (const token of tokens) {
      if (!token) continue;
      if (token === '\n') {
        pushLine();
        continue;
      }
      if (/^[ \t]+$/.test(token)) {
        if (currentWidth > 0 && currentWidth < max) append(' ', style);
        continue;
      }
      let remaining = token;
      while (remaining) {
        const available = max - currentWidth;
        if (available <= 0) {
          pushLine();
          continue;
        }
        if (visibleWidth(remaining) <= available) {
          append(remaining, style);
          remaining = '';
        } else if (currentWidth === 0) {
          const part = sliceVisible(remaining, 0, available);
          if (!part) {
            const first = String.fromCodePoint(remaining.codePointAt(0));
            append(first, style);
            remaining = remaining.slice(first.length);
          } else {
            append(part, style);
            remaining = remaining.slice(part.length);
          }
          pushLine();
        } else {
          pushLine();
        }
      }
    }
  }
  if (current.length || !lines.length) pushLine();
  return lines;
}

function styleLine(segments, styler, { base = 'text', background = null } = {}) {
  let output = '';
  for (const segment of segments) {
    let rendered = segment.text;
    if (segment.code) rendered = styler.bg('surface2', styler.fg('accent', rendered));
    else if (segment.link) rendered = styler.fg('info', styler.underline(rendered));
    else if (segment.strike) rendered = styler.strike(styler.fg('faint', rendered));
    else if (segment.bold) rendered = styler.bold(styler.fg(base, rendered));
    else if (segment.italic) rendered = styler.italic(styler.fg(base, rendered));
    else rendered = styler.fg(base, rendered);
    output += rendered;
  }
  if (background) {
    output = styler.bg(background, output);
  }
  return output;
}

function parseTableCells(line) {
  const trimmed = String(line || '').trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

function isTableSeparator(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed.includes('|') && !trimmed.includes('-')) return false;
  const cells = parseTableCells(trimmed);
  return cells.length >= 1 && cells.every((cell) => /^:?-{2,}:?$/.test(cell));
}

function renderTableBlock(tableLines, max, styler, indent, base) {
  const rows = tableLines.map(parseTableCells);
  const colCount = Math.max(1, ...rows.map((row) => row.length));
  const sepOverhead = Math.max(0, (colCount - 1) * 3);
  const avail = Math.max(colCount * 2, max - sepOverhead);
  const natural = new Array(colCount).fill(3);
  for (const row of rows) {
    for (let col = 0; col < colCount; col += 1) {
      const cellWidth = visibleWidth(stripAnsi(row[col] || ''));
      if (cellWidth > natural[col]) natural[col] = cellWidth;
    }
  }
  const totalNatural = natural.reduce((sum, value) => sum + value, 0);
  const widths = natural.map((w) => (totalNatural <= avail
    ? w
    : Math.max(2, Math.floor((w / Math.max(1, totalNatural)) * avail))));
  // Clamp exact sum so we never exceed max
  let sum = widths.reduce((a, b) => a + b, 0);
  for (let col = colCount - 1; col >= 0 && sum + sepOverhead > max; col -= 1) {
    const cut = Math.min(widths[col] - 1, sum + sepOverhead - max);
    if (cut > 0) {
      widths[col] -= cut;
      sum -= cut;
    }
  }
  const output = [];
  const sep = styler.fg('border', ' │ ');
  const renderRow = (cells, isHeader = false) => {
    const parts = [];
    for (let col = 0; col < colCount; col += 1) {
      const text = truncateVisible(cells[col] || '', widths[col]);
      const padded = padEndVisible(text, widths[col]);
      parts.push(isHeader ? styler.bold(styler.fg('accent', padded)) : styler.fg(base, padded));
    }
    return truncateVisible(`${indent}${parts.join(sep)}`, visibleWidth(indent) + max);
  };
  output.push(renderRow(rows[0], true));
  const ruleLine = widths.map((w) => '─'.repeat(w)).join('─┼─');
  output.push(`${indent}${styler.fg('border', truncateVisible(ruleLine, max))}`);
  for (let index = 1; index < rows.length; index += 1) {
    output.push(renderRow(rows[index], false));
  }
  return output;
}

const CALLOUT_COLORS = {
  NOTE: 'info',
  TIP: 'success',
  IMPORTANT: 'accent',
  WARNING: 'warning',
  CAUTION: 'danger',
};

export function renderMarkdown(text, width, styler, { base = 'text', indent = '' } = {}) {
  const max = Math.max(4, width - visibleWidth(indent));
  const lines = [];
  const source = String(text ?? '').replace(/\t/g, '  ');
  const rawLines = source.split('\n');
  let inCode = false;
  let codeLang = '';
  let codeBuffer = [];

  const flushCode = () => {
    if (!codeBuffer.length && !codeLang) return;
    const innerWidth = Math.max(2, max - 2);
    if (codeLang || codeBuffer.length >= 2) {
      const langLabel = codeLang || 'code';
      const meta = `${codeBuffer.length} ${codeBuffer.length === 1 ? 'line' : 'lines'}`;
      const leftPart = ` ${langLabel}`;
      const rightPart = `${meta} `;
      let headerText;
      if (visibleWidth(leftPart) + visibleWidth(rightPart) + 1 <= max) {
        const gap = max - visibleWidth(leftPart) - visibleWidth(rightPart);
        headerText = `${styler.fg('accent', leftPart)}${' '.repeat(gap)}${styler.fg('faint', rightPart)}`;
      } else {
        headerText = styler.fg('accent', padEndVisible(truncateVisible(leftPart, max), max));
      }
      lines.push(`${indent}${paintSurface(headerText, styler, 'surface3')}`);
    }
    for (const codeLine of codeBuffer) {
      const wrapped = codeLine === '' ? [''] : wrapPlain(codeLine, innerWidth);
      for (const piece of wrapped) {
        const highlighted = highlightCodeLine(piece, codeLang, styler);
        const padCount = Math.max(0, innerWidth - visibleWidth(piece));
        const row = ` ${highlighted}${' '.repeat(padCount)} `;
        lines.push(`${indent}${paintSurface(row, styler, 'surface2')}`);
      }
    }
    codeBuffer = [];
    codeLang = '';
  };

  for (let lineIndex = 0; lineIndex < rawLines.length; lineIndex += 1) {
    const rawLine = rawLines[lineIndex];
    const fenceMatch = /^\s*```([A-Za-z0-9_+.#-]*)\s*$/.exec(rawLine);
    if (fenceMatch) {
      if (inCode) {
        flushCode();
        inCode = false;
      } else {
        inCode = true;
        codeLang = fenceMatch[1] || '';
        codeBuffer = [];
      }
      continue;
    }
    if (inCode) {
      codeBuffer.push(rawLine);
      continue;
    }
    if (!rawLine.trim()) {
      lines.push('');
      continue;
    }
    // GFM tables: header row followed by separator row
    if (rawLine.includes('|') && lineIndex + 1 < rawLines.length && isTableSeparator(rawLines[lineIndex + 1])) {
      const tableRows = [rawLine];
      lineIndex += 2;
      while (lineIndex < rawLines.length && rawLines[lineIndex].trim() && rawLines[lineIndex].includes('|')) {
        tableRows.push(rawLines[lineIndex]);
        lineIndex += 1;
      }
      lineIndex -= 1;
      lines.push(...renderTableBlock(tableRows, max, styler, indent, base));
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(rawLine)) {
      lines.push(`${indent}${styler.fg('border', '─'.repeat(max))}`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(rawLine);
    if (heading) {
      const level = heading[1].length;
      const inline = parseInline(heading[2]);
      const headingColor = level <= 2 ? 'accent' : 'text';
      const prefix = level === 2 ? `${styler.fg('accent', '▸ ')}` : '';
      const headingWidth = Math.max(2, max - visibleWidth(prefix));
      const wrappedHeadings = wrapSegments(inline, headingWidth);
      wrappedHeadings.forEach((wrapped, idx) => {
        const lead = idx === 0 ? prefix : ' '.repeat(visibleWidth(prefix));
        lines.push(`${indent}${lead}${styler.bold(styleLine(wrapped, styler, { base: headingColor }))}`);
      });
      if (level === 1 && max >= 8) {
        lines.push(`${indent}${styler.fg('border', '─'.repeat(Math.min(max, Math.max(8, visibleWidth(heading[2])))))}`);
      }
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(rawLine);
    if (quote) {
      const callout = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i.exec(quote[1]);
      if (callout) {
        const tag = callout[1].toUpperCase();
        const tone = CALLOUT_COLORS[tag] || 'info';
        const rest = callout[2] ? ` ${callout[2]}` : '';
        lines.push(`${indent}${styler.fg(tone, '┃ ')}${styler.bold(styler.fg(tone, tag.toLowerCase()))}${rest ? styler.fg('muted', truncateVisible(rest, Math.max(0, max - tag.length - 3))) : ''}`);
        continue;
      }
      for (const wrapped of wrapSegments(parseInline(quote[1]), Math.max(2, max - 2))) {
        lines.push(`${indent}${styler.fg('border', '┃ ')}${styler.italic(styleLine(wrapped, styler, { base: 'muted' }))}`);
      }
      continue;
    }
    const checklist = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(rawLine);
    if (checklist) {
      const lead = checklist[1].replace(/\t/g, '  ');
      const done = checklist[2].toLowerCase() === 'x';
      const glyph = done ? styler.fg('success', '✓ ') : styler.fg('faint', '○ ');
      const wrapped = wrapSegments(parseInline(checklist[3]), Math.max(2, max - lead.length - 2));
      wrapped.forEach((lineSegments, idx) => {
        const prefix = idx === 0 ? `${lead}${glyph}` : `${lead}  `;
        lines.push(`${indent}${prefix}${styleLine(lineSegments, styler, { base: done ? 'muted' : base })}`);
      });
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(rawLine);
    if (bullet) {
      const lead = bullet[1].replace(/\t/g, '  ');
      const wrapped = wrapSegments(parseInline(bullet[2]), Math.max(2, max - lead.length - 2));
      wrapped.forEach((lineSegments, index) => {
        const prefix = index === 0 ? `${lead}${styler.fg('accent', '• ')}` : `${lead}  `;
        lines.push(`${indent}${prefix}${styleLine(lineSegments, styler, { base })}`);
      });
      continue;
    }
    const numbered = /^(\s*)(\d+[.)])\s+(.*)$/.exec(rawLine);
    if (numbered) {
      const lead = numbered[1];
      const marker = `${numbered[2]} `;
      const wrapped = wrapSegments(parseInline(numbered[3]), Math.max(2, max - lead.length - marker.length));
      wrapped.forEach((lineSegments, index) => {
        const prefix = index === 0 ? `${lead}${styler.fg('accent', marker)}` : `${lead}${' '.repeat(marker.length)}`;
        lines.push(`${indent}${prefix}${styleLine(lineSegments, styler, { base })}`);
      });
      continue;
    }
    for (const wrapped of wrapSegments(parseInline(rawLine), max)) {
      lines.push(`${indent}${styleLine(wrapped, styler, { base })}`);
    }
  }
  if (inCode) flushCode();
  return lines;
}

const ANSI_ESCAPE = /^\u001b\[[0-?]*[ -/]*[@-~]$/;

// Wrap styled text by visible width. ANSI sequences are zero-width, so colors
// survive wrapping. Long words are split; ordinary words are wrapped at spaces.
export function wrapStyledLines(line, width) {
  const max = Math.max(1, width);
  const output = [];
  for (const physicalLine of String(line ?? '').split('\n')) {
    if (visibleWidth(physicalLine) <= max) {
      output.push(physicalLine);
      continue;
    }
    const items = [];
    for (const token of String(physicalLine).split(/(\u001b\[[0-?]*[ -/]*[@-~])/g)) {
      if (!token) continue;
      if (ANSI_ESCAPE.test(token)) {
        items.push({ type: 'ansi', text: token, width: 0 });
        continue;
      }
      for (const piece of token.split(/(\s+)/)) {
        if (!piece) continue;
        if (/^\s+$/.test(piece)) items.push({ type: 'space', text: ' ', width: 1 });
        else items.push({ type: 'word', text: piece, width: visibleWidth(piece) });
      }
    }
    let current = [];
    let currentWidth = 0;
    const flush = () => {
      output.push(current.length ? `${current.map((item) => item.text).join('')}\x1b[0m` : '');
      current = [];
      currentWidth = 0;
    };
    for (const item of items) {
      if (item.type === 'ansi') {
        current.push(item);
        continue;
      }
      if (item.type === 'space') {
        if (!current.length || currentWidth >= max) {
          if (currentWidth >= max) flush();
          continue;
        }
        current.push(item);
        currentWidth += 1;
        continue;
      }
      if (item.type === 'word') {
        if (currentWidth + item.width > max && current.length) flush();
        if (item.width > max) {
          let chunk = [];
          let chunkWidth = 0;
          for (const char of item.text) {
            const charWidth = visibleWidth(char);
            if (chunkWidth + charWidth > max && chunk.length) {
              current.push(...chunk);
              flush();
              chunk = [];
              chunkWidth = 0;
            }
            chunk.push({ type: 'word', text: char, width: charWidth });
            chunkWidth += charWidth;
          }
          if (chunk.length) {
            current.push(...chunk);
            currentWidth = chunkWidth;
          }
        } else {
          current.push(item);
          currentWidth += item.width;
        }
      }
    }
    flush();
  }
  return output.length ? output : [''];
}

const FRACTIONAL_BLOCKS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];

export function progressBar(percent, width, styler, color = 'accent') {
  const max = Math.max(1, width);
  const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
  const exact = (clamped / 100) * max;
  const full = Math.floor(exact);
  const remainder = exact - full;
  const eighth = Math.min(7, Math.round(remainder * 8));
  let filled = '█'.repeat(full);
  let partial = '';
  if (full < max && eighth > 0) {
    partial = FRACTIONAL_BLOCKS[eighth];
  } else if (full === 0 && clamped > 0 && max > 0) {
    partial = '▏';
  }
  const usedCells = full + (partial ? 1 : 0);
  const empty = Math.max(0, max - usedCells);
  return `${styler.fg(color, `${filled}${partial}`)}${styler.fg('border', '░'.repeat(empty))}`;
}

export function roundedBox({
  width,
  lines,
  styler,
  title = '',
  subtitle = '',
  footer = '',
  padding = 1,
  background = 'surface',
  borderColor = 'border',
  titleColor = 'accent',
  closable = false,
  closeHovered = false,
}) {
  const inner = Math.max(4, width - 2);
  const contentWidth = Math.max(1, inner - padding * 2);
  const padStr = ' '.repeat(padding);
  const paintLine = (raw) => {
    const text = truncateVisible(raw, contentWidth);
    const padded = `${padStr}${padEndVisible(text, contentWidth)}${padStr}`;
    return paintSurface(padded, styler, background);
  };
  const bodyRows = [];
  for (const line of lines) {
    for (const wrapped of wrapStyledLines(line, contentWidth)) {
      bodyRows.push(`${styler.fg(borderColor, '│')}${paintLine(wrapped)}${styler.fg(borderColor, '│')}`);
    }
  }
  const titleText = title ? ` ${title} ` : '';
  const subText = subtitle ? ` ${subtitle} ` : '';
  const closeText = closable ? ' × ' : '';
  const titleStyled = title ? styler.bold(styler.fg(titleColor, titleText)) : '';
  const subStyled = subtitle ? styler.fg('faint', subText) : '';
  const closeStyled = closable
    ? (closeHovered
      ? paintSurface(styler.bold(styler.fg('danger', closeText)), styler, 'dangerBg')
      : styler.fg('muted', closeText))
    : '';
  const rightMeta = `${subStyled}${closeStyled}`;
  const rightMetaWidth = visibleWidth(subText) + visibleWidth(closeText);
  const usedTop = 1 + visibleWidth(titleText) + rightMetaWidth;
  const topFill = Math.max(0, inner - usedTop);
  const top = rightMetaWidth && topFill >= 1
    ? `${styler.fg(borderColor, '╭─')}${titleStyled}${styler.fg(borderColor, '─'.repeat(topFill))}${rightMeta}${styler.fg(borderColor, '╮')}`
    : `${styler.fg(borderColor, '╭─')}${titleStyled}${styler.fg(borderColor, `${'─'.repeat(Math.max(0, inner - 1 - visibleWidth(titleText)))}╮`)}`;

  const footerRows = [];
  if (footer) {
    footerRows.push(styler.fg(borderColor, `├${'─'.repeat(inner)}┤`));
    footerRows.push(`${styler.fg(borderColor, '│')}${paintLine(styler.fg('faint', footer))}${styler.fg(borderColor, '│')}`);
  }
  const bottom = styler.fg(borderColor, `╰${'─'.repeat(inner)}╯`);
  return [top, ...bodyRows, ...footerRows, bottom];
}

export function renderDialogBand({
  columns,
  rows,
  title,
  subtitle = '',
  body,
  footer = '',
  styler,
  recordHit,
  recordCloseHit,
  borderColor = 'accent',
  maxWidth = 84,
  closable = false,
  closeHovered = false,
}) {
  const width = Math.max(24, Math.min(columns - 4, maxWidth));
  const reserved = footer ? 4 : 2;
  const maxBody = Math.max(1, rows - reserved);
  const visibleBody = body.slice(0, maxBody);
  const box = roundedBox({
    width,
    title,
    subtitle,
    footer,
    styler,
    lines: visibleBody,
    background: 'surface',
    borderColor,
    closable,
    closeHovered,
  });
  const inkBg = inkBackground(styler);
  const left = Math.max(0, Math.floor((columns - width) / 2));
  const top = Math.max(0, Math.floor((rows - box.length) / 2));
  const contentCol = left + 2;
  const contentWidth = Math.max(1, width - 4);
  const inkLine = ' '.repeat(columns);
  const output = [];
  const leftPad = ' '.repeat(left);
  for (let index = 0; index < rows; index += 1) {
    const boxIndex = index - top;
    if (boxIndex >= 0 && boxIndex < box.length) {
      const boxLine = `${leftPad}${box[boxIndex]}`;
      const rightPad = Math.max(0, columns - visibleWidth(boxLine));
      output.push(`${inkBg}${boxLine}${inkBg}${' '.repeat(rightPad)}`);
      if (closable && recordCloseHit && boxIndex === 0) {
        recordCloseHit(index, left + width - 4, 3);
      }
      if (recordHit && boxIndex >= 1 && boxIndex < 1 + visibleBody.length) {
        recordHit(index, boxIndex - 1, contentCol, contentWidth);
      }
    } else {
      output.push(`${inkBg}${inkLine}`);
    }
  }
  return output;
}

export function centerBlock(lines, width) {
  return lines.map((line) => centerVisible(line, width));
}

export function clipLines(lines, max) {
  return lines.length <= max ? lines : lines.slice(0, max);
}
