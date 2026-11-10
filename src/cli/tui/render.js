import { stripAnsi, visibleWidth, sliceVisible, padEndVisible, truncateVisible, centerVisible } from '../theme.js';

const hexToRgb = (hex) => {
  const clean = String(hex).replace('#', '');
  const value = Number.parseInt(clean, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
};

export function inkBackground(styler) {
  const inkHex = (styler.palette || {}).ink || '#0f1115';
  const [r, g, b] = hexToRgb(inkHex);
  return `\u001b[48;2;${r};${g};${b}m`;
}

// Paint a full row with the ink background. Inner background resets (\u001b[49m)
// would otherwise drop back to the terminal default, leaving black gaps.
export function paintRow(line, styler) {
  const inkBg = inkBackground(styler);
  return `${inkBg}${String(line ?? '').replaceAll('\u001b[49m', inkBg)}${inkBg}`;
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
        if (remaining.length <= available) {
          line += remaining;
          remaining = '';
        } else {
          if (line) {
            output.push(line);
            line = '';
          } else {
            output.push(remaining.slice(0, max));
            remaining = remaining.slice(max);
          }
        }
      }
    }
    if (line) output.push(line);
  }
  return output.length ? output : [''];
}

function parseInline(text) {
  const segments = [];
  const source = String(text ?? '');
  let index = 0;
  let buffer = '';
  const flush = () => {
    if (buffer) segments.push({ text: buffer, bold: false, code: false, link: false });
    buffer = '';
  };
  while (index < source.length) {
    if (source.startsWith('**', index)) {
      const end = source.indexOf('**', index + 2);
      if (end !== -1) {
        flush();
        segments.push({ text: source.slice(index + 2, end), bold: true, code: false, link: false });
        index = end + 2;
        continue;
      }
    }
    if (source[index] === '`') {
      const end = source.indexOf('`', index + 1);
      if (end !== -1) {
        flush();
        segments.push({ text: source.slice(index + 1, end), bold: false, code: true, link: false });
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
        segments.push({ text: source.slice(index + 1, close), bold: false, code: false, link: true });
        index = end + 1;
        continue;
      }
    }
    buffer += source[index];
    index += 1;
  }
  flush();
  return segments.length ? segments : [{ text: '', bold: false, code: false, link: false }];
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
    const style = { bold: segment.bold, code: segment.code, link: segment.link };
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
          append(part, style);
          remaining = remaining.slice(part.length);
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
    let text = segment.text;
    let rendered;
    if (segment.code) rendered = text;
    else rendered = text;
    if (segment.code) rendered = styler.fg('accent', rendered);
    else if (segment.link) rendered = styler.fg('info', styler.underline(rendered));
    else if (segment.bold) rendered = styler.bold(styler.fg(base, rendered));
    else rendered = styler.fg(base, rendered);
    output += rendered;
  }
  if (background) {
    const padding = Math.max(0, visibleWidth(output) > 0 ? 0 : 0);
    output = styler.bg(background, output + ' '.repeat(padding));
  }
  return output;
}

export function renderMarkdown(text, width, styler, { base = 'text', indent = '' } = {}) {
  const max = Math.max(4, width - visibleWidth(indent));
  const lines = [];
  const source = String(text ?? '').replace(/\t/g, '  ');
  let inCode = false;
  let codeBuffer = [];

  const flushCode = () => {
    if (!codeBuffer.length) return;
    for (const codeLine of codeBuffer) {
      const wrapped = codeLine === '' ? [''] : wrapPlain(codeLine.replace(/^ /, ''), max - 2);
      for (const piece of wrapped) {
        const content = ` ${padEndVisible(piece, max - 2)} `;
        lines.push(`${indent}${styler.bg('surface2', styler.fg('text', content))}`);
      }
    }
    codeBuffer = [];
  };

  for (const rawLine of source.split('\n')) {
    const fence = /^\s*```/.test(rawLine);
    if (fence) {
      if (inCode) {
        flushCode();
        inCode = false;
      } else {
        inCode = true;
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
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(rawLine)) {
      lines.push(`${indent}${styler.fg('faint', '─'.repeat(max))}`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(rawLine);
    if (heading) {
      const inline = parseInline(heading[2]);
      for (const wrapped of wrapSegments(inline, max)) {
        lines.push(`${indent}${styler.bold(styleLine(wrapped, styler, { base: 'accent' }))}`);
      }
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(rawLine);
    if (quote) {
      for (const wrapped of wrapSegments(parseInline(quote[1]), max - 2)) {
        lines.push(`${indent}${styler.fg('faint', '│ ')}${styler.italic(styleLine(wrapped, styler, { base: 'muted' }))}`);
      }
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(rawLine);
    if (bullet) {
      const lead = bullet[1].replace(/\t/g, '  ');
      const wrapped = wrapSegments(parseInline(bullet[2]), max - lead.length - 2);
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
      const wrapped = wrapSegments(parseInline(numbered[3]), max - lead.length - marker.length);
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

export function progressBar(percent, width, styler, color = 'accent') {
  const max = Math.max(1, width);
  const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
  const filled = Math.round((clamped / 100) * max);
  return `${styler.fg(color, '█'.repeat(filled))}${styler.fg('faint', '░'.repeat(Math.max(0, max - filled)))}`;
}

export function roundedBox({ width, lines, styler, title = '', padding = 1, background = 'surface', borderColor = 'border' }) {
  const inner = Math.max(4, width - 2);
  const padded = [];
  for (const line of lines) {
    const text = truncateVisible(line, inner - padding * 2);
    padded.push(`${styler.bg(background, ' '.repeat(padding))}${styler.bg(background, padEndVisible(text, inner - padding * 2))}${styler.bg(background, ' '.repeat(padding))}`);
  }
  const titleText = title ? ` ${title} ` : '';
  const topFill = Math.max(0, inner - visibleWidth(titleText) - 1);
  const top = `${styler.fg(borderColor, '╭─')}${styler.fg('muted', titleText)}${styler.fg(borderColor, `${'─'.repeat(topFill)}╮`)}`;
  const bottom = styler.fg(borderColor, `╰${'─'.repeat(inner)}╯`);
  return [top, ...padded.map((line) => `${styler.fg(borderColor, '│')}${line}${styler.fg(borderColor, '│')}`), bottom];
}

export function renderDialogBand({ columns, rows, title, body, footer, styler, recordHit }) {
  const width = Math.min(columns - 4, 82);
  const box = roundedBox({
    width,
    title,
    styler,
    lines: body.slice(0, Math.max(1, rows - 2)),
    background: 'surface',
    borderColor: 'accent',
  });
  if (footer) box.push(`${styler.fg('faint', footer)}`);
  const inkBg = inkBackground(styler);
  const left = Math.max(0, Math.floor((columns - width - 2) / 2));
  const top = Math.max(0, Math.floor((rows - box.length) / 2));
  const inkLine = ' '.repeat(columns);
  const output = [];
  const leftPad = ' '.repeat(left);
  for (let index = 0; index < rows; index += 1) {
    const boxIndex = index - top;
    if (boxIndex >= 0 && boxIndex < box.length) {
      const boxLine = `${leftPad}${box[boxIndex]}`;
      const rightPad = Math.max(0, columns - visibleWidth(boxLine));
      output.push(`${inkBg}${boxLine}${inkBg}${' '.repeat(rightPad)}`);
      if (recordHit && boxIndex >= 1 && boxIndex < 1 + body.length) {
        recordHit(index, boxIndex - 1);
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
