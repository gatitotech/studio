import { padEndVisible, truncateVisible } from '../theme.js';

const ALT_SCREEN_ON = '\u001b[?1049h';
const ALT_SCREEN_OFF = '\u001b[?1049l';
const CURSOR_HIDE = '\u001b[?25l';
const CURSOR_SHOW = '\u001b[?25h';
const BRACKET_PASTE_ON = '\u001b[?2004h';
const BRACKET_PASTE_OFF = '\u001b[?2004l';
const MOUSE_ON = '\u001b[?1002h\u001b[?1006h';
const MOUSE_OFF = '\u001b[?1002l\u001b[?1006l';
const SYNC_ON = '\u001b[?2026h';
const SYNC_OFF = '\u001b[?2026l';
const HOME = '\u001b[H';
const CLEAR_LINE_END = '\u001b[K';
const CLEAR_BELOW = '\u001b[0J';

const CSI_KEYS = {
  A: { name: 'up' },
  B: { name: 'down' },
  C: { name: 'right' },
  D: { name: 'left' },
  H: { name: 'home' },
  F: { name: 'end' },
  Z: { name: 'tab', shift: true },
  '1~': { name: 'home' },
  '2~': { name: 'insert' },
  '3~': { name: 'delete' },
  '4~': { name: 'end' },
  '5~': { name: 'pageup' },
  '6~': { name: 'pagedown' },
  '7~': { name: 'home' },
  '8~': { name: 'end' },
  '11~': { name: 'f1' },
  '12~': { name: 'f2' },
  '13~': { name: 'f3' },
  '14~': { name: 'f4' },
  '15~': { name: 'f5' },
  '17~': { name: 'f6' },
  '18~': { name: 'f7' },
  '19~': { name: 'f8' },
  '20~': { name: 'f9' },
  '21~': { name: 'f10' },
  '23~': { name: 'f11' },
  '24~': { name: 'f12' },
};

function mapCsi(sequence) {
  const params = sequence.slice(2, -1);
  const final = sequence[sequence.length - 1];
  if (final === '~') {
    const key = CSI_KEYS[`${params}~`];
    if (key) return key;
    return { name: 'unknown', sequence };
  }
  if (final === 'A' || final === 'B' || final === 'C' || final === 'D' || final === 'H' || final === 'F' || final === 'Z') {
    const key = { ...CSI_KEYS[final] };
    if (final === 'Z') key.shift = true;
    if (params.includes(';')) {
      const mods = Number(params.split(';')[1] || 0);
      if (mods) {
        const bits = mods - 1;
        key.shift = Boolean(bits & 1);
        key.alt = Boolean(bits & 2);
        key.ctrl = Boolean(bits & 4);
      }
    }
    return key;
  }
  return { name: 'unknown', sequence };
}

export class Terminal {
  constructor({ stdin = process.stdin, stdout = process.stdout } = {}) {
    this.stdin = stdin;
    this.stdout = stdout;
    this.entered = false;
    this.keyHandler = null;
    this.resizeHandler = null;
    this.pending = '';
    this.escapeTimer = null;
    this.renderTimer = null;
    this.renderFn = null;
    this.frameCount = 0;
    this.onData = (chunk) => this.handleData(chunk);
    this.onResize = () => {
      this.requestRender();
      this.resizeHandler?.();
    };
  }

  get isTTY() {
    return Boolean(this.stdin.isTTY && this.stdout.isTTY);
  }

  get columns() {
    return Math.max(20, Number(this.stdout.columns) || 80);
  }

  get rows() {
    return Math.max(8, Number(this.stdout.rows) || 24);
  }

  enter() {
    if (this.entered) return;
    this.entered = true;
    this.stdout.write(`${ALT_SCREEN_ON}${CURSOR_HIDE}${BRACKET_PASTE_ON}${MOUSE_ON}\u001b[2J${HOME}`);
    try {
      this.stdin.setRawMode(true);
    } catch {
      // A non-tty stdin cannot enter raw mode; keys will still arrive as lines.
    }
    this.stdin.resume?.();
    this.stdin.setEncoding?.('utf8');
    this.stdin.on('data', this.onData);
    this.stdout.on('resize', this.onResize);
  }

  leave() {
    if (!this.entered) return;
    this.entered = false;
    clearTimeout(this.escapeTimer);
    clearTimeout(this.renderTimer);
    this.stdin.removeListener('data', this.onData);
    this.stdout.removeListener('resize', this.onResize);
    try {
      this.stdin.setRawMode(false);
    } catch {
      // Ignore.
    }
    this.stdin.pause?.();
    this.stdin.unref?.();
    this.stdout.write(`${MOUSE_OFF}${BRACKET_PASTE_OFF}${CURSOR_SHOW}${ALT_SCREEN_OFF}`);
  }

  onKey(handler) {
    this.keyHandler = handler;
  }

  onResizeEvent(handler) {
    this.resizeHandler = handler;
  }

  emitKey(key) {
    if (!this.keyHandler) return;
    try {
      this.keyHandler(key);
    } catch (error) {
      this.stdout.write(`\r\nkey handler error: ${error.message}\r\n`);
    }
  }

  handleData(chunk) {
    this.pending += String(chunk);
    if (this.pending.length > 1024 * 1024) this.pending = this.pending.slice(-1024 * 1024);
    clearTimeout(this.escapeTimer);
    this.parsePending();
  }

  parsePending() {
    while (this.pending.length) {
      const bracket = this.pending.indexOf('\u001b[200~');
      if (bracket === 0) {
        const end = this.pending.indexOf('\u001b[201~', 6);
        if (end === -1) return;
        const text = this.pending.slice(6, end);
        this.pending = this.pending.slice(end + 6);
        this.emitKey({ name: 'paste', text });
        continue;
      }
      if (bracket > 0) {
        this.emitText(this.pending.slice(0, bracket));
        this.pending = this.pending.slice(bracket);
        continue;
      }
      const char = this.pending[0];
      if (char === '\u001b') {
        const mouse = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])/.exec(this.pending);
        if (mouse) {
          this.pending = this.pending.slice(mouse[0].length);
          this.emitKey({
            name: 'mouse',
            button: Number(mouse[1]),
            column: Number(mouse[2]),
            row: Number(mouse[3]),
            press: mouse[4] === 'M',
            release: mouse[4] === 'm',
          });
          continue;
        }
        // Kitty keyboard protocol: CSI <codepoint>[;<modifiers>]u — e.g.
        // \u001b[13;2u is Shift+Enter, \u001b[9;2u is Shift+Tab.
        const csiU = /^\u001b\[(\d+)(?:;(\d+))?u/.exec(this.pending);
        if (csiU) {
          this.pending = this.pending.slice(csiU[0].length);
          const code = Number(csiU[1]);
          const mods = Math.max(0, Number(csiU[2] || '1') - 1);
          const key = {
            shift: Boolean(mods & 1),
            alt: Boolean(mods & 2),
            ctrl: Boolean(mods & 4),
          };
          if (code === 13) key.name = 'enter';
          else if (code === 9) key.name = 'tab';
          else if (code === 32) key.name = 'text', key.text = ' ';
          else if (code >= 97 && code <= 122 && key.ctrl) {
            key.name = 'char';
            key.text = String.fromCharCode(code);
          } else {
            key.name = 'unknown';
            key.sequence = csiU[0];
          }
          this.emitKey(key);
          continue;
        }
        const csi = /^\u001b\[[0-9;?]*[A-Za-z~]/.exec(this.pending);
        if (csi) {
          this.pending = this.pending.slice(csi[0].length);
          this.emitKey(mapCsi(csi[0]));
          continue;
        }
        const ss3 = /^\u001bO[A-Za-z]/.exec(this.pending);
        if (ss3) {
          this.pending = this.pending.slice(ss3[0].length);
          const final = ss3[0][ss3[0].length - 1];
          const key = CSI_KEYS[final] || { name: final.toLowerCase() };
          this.emitKey({ ...key });
          continue;
        }
        if (this.pending.length === 1) {
          this.escapeTimer = setTimeout(() => {
            this.pending = this.pending.slice(1);
            this.emitKey({ name: 'escape' });
            if (this.pending) this.parsePending();
          }, 25);
          return;
        }
        const next = this.pending[1];
        if (next === '\r' || next === '\n') {
          this.pending = this.pending.slice(2);
          this.emitKey({ name: 'enter', alt: true });
          continue;
        }
        if (next === '\u007f' || next === '\b') {
          this.pending = this.pending.slice(2);
          this.emitKey({ name: 'backspace', alt: true });
          continue;
        }
        const printable = String.fromCodePoint(this.pending.codePointAt(1));
        this.pending = this.pending.slice(1 + printable.length);
        this.emitKey({ name: 'char', text: printable, alt: true });
        continue;
      }
      if (char === '\r') {
        this.pending = this.pending.slice(1);
        this.emitKey({ name: 'enter' });
        continue;
      }
      if (char === '\n') {
        this.pending = this.pending.slice(1);
        this.emitKey({ name: 'newline' });
        continue;
      }
      if (char === '\t') {
        this.pending = this.pending.slice(1);
        this.emitKey({ name: 'tab' });
        continue;
      }
      if (char === '\u007f' || char === '\b') {
        this.pending = this.pending.slice(1);
        this.emitKey({ name: 'backspace' });
        continue;
      }
      const code = char.charCodeAt(0);
      if (code >= 1 && code <= 26) {
        this.pending = this.pending.slice(1);
        const letter = String.fromCharCode(code + 96);
        this.emitKey({ name: 'char', text: letter, ctrl: true });
        continue;
      }
      if (code === 0) {
        this.pending = this.pending.slice(1);
        this.emitKey({ name: 'char', text: ' ', ctrl: true });
        continue;
      }
      const nextSpecial = this.pending.slice(1).search(/[\u0000-\u001f\u007f]/);
      const end = nextSpecial === -1 ? this.pending.length : nextSpecial + 1;
      const text = this.pending.slice(0, end);
      this.pending = this.pending.slice(end);
      this.emitKey({ name: 'text', text });
    }
  }

  emitText(text) {
    if (!text) return;
    this.emitKey({ name: 'text', text });
  }

  write(value) {
    this.stdout.write(String(value));
  }

  // Terminal bell — the portable way to get a user's attention.
  bell() {
    try {
      this.stdout.write('\u0007');
    } catch {
      // A bell must never break the frame.
    }
  }

  requestRender() {
    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      this.renderNow();
    }, 16);
  }

  renderNow() {
    if (!this.renderFn || !this.entered) return;
    const result = this.renderFn();
    const lines = Array.isArray(result) ? result : result?.lines;
    if (!Array.isArray(lines)) return;
    const rows = this.rows;
    const columns = this.columns;
    const visible = lines.slice(0, rows).map((line) => `${padEndVisible(truncateVisible(String(line ?? ''), columns), columns)}\u001b[0m`);
    while (visible.length < rows) visible.push(' '.repeat(columns));
    const sync = process.env.GATITA_SYNC_OUTPUT !== '0';
    const body = visible.map((line) => `${line}${CLEAR_LINE_END}`).join('\r\n');
    this.stdout.write(`${sync ? SYNC_ON : ''}${HOME}${body}${CLEAR_BELOW}${sync ? SYNC_OFF : ''}`);
    this.frameCount += 1;
  }

  start(renderFn) {
    this.renderFn = renderFn;
    this.requestRender();
  }
}
