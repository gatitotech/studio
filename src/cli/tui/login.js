import { Terminal } from './terminal.js';
import {
  createStyler,
  GLYPHS,
  SPINNER,
  selectGlyph,
  visibleWidth,
  padEndVisible,
  truncateVisible,
  centerVisible,
  sliceVisible,
} from '../theme.js';
import { bgEscape, inkBackground, paintRow, paintSurface, progressBar } from './render.js';
import { CLIENT_VERSION } from '../../shared/protocol.js';
import { formatDuration, formatTokens } from '../../shared/util.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function codePointBefore(text, index) {
  if (index <= 0) return 0;
  const code = text.charCodeAt(index - 1);
  if (code >= 0xdc00 && code <= 0xdfff && index >= 2) {
    const high = text.charCodeAt(index - 2);
    if (high >= 0xd800 && high <= 0xdbff) return index - 2;
  }
  return index - 1;
}

function codePointAfter(text, index) {
  if (index >= text.length) return text.length;
  const code = text.codePointAt(index);
  return index + (code > 0xffff ? 2 : 1);
}

function planStyle(planId = 'free') {
  const id = String(planId || 'free').toLowerCase();
  if (id === 'pro') return { fg: 'accent', bg: 'accentBg' };
  if (id === 'plus') return { fg: 'info', bg: 'infoBg' };
  return { fg: 'muted', bg: 'surface2' };
}

export class LoginView {
  constructor({
    serverUrl = '',
    theme = 'dark',
    animations = true,
    initialEmail = '',
    initialMode = 'credentials',
    subtitle = 'Sign in to your Gatita account',
    onSubmit = null,
    onCancel = null,
    onComplete = null,
    readClipboard = null,
  } = {}) {
    this.serverUrl = String(serverUrl || '');
    this.styler = createStyler(theme || 'dark', { enabled: true });
    this.animations = animations !== false;
    this.subtitle = subtitle;
    this.mode = initialMode === 'token' ? 'token' : 'credentials';
    this.email = String(initialEmail || '').trim();
    this.emailCursor = this.email.length;
    this.password = '';
    this.passwordCursor = 0;
    this.token = '';
    this.tokenCursor = 0;
    this.showSecret = false;
    this.focus = this.mode === 'token' ? 'token' : (this.email ? 'password' : 'email');
    this.serverStatus = 'checking'; // 'checking' | 'online' | 'offline'
    this.serverDetail = '';
    this.submitting = false;
    this.error = null; // { message, tone, retryUntil }
    this.successPayload = null;
    this.tick = 0;
    this.hits = [];
    this.onSubmit = onSubmit;
    this.onCancel = onCancel;
    this.onComplete = onComplete;
    this.readClipboard = readClipboard;
    this.abortController = null;
  }

  fieldsForMode() {
    return this.mode === 'token' ? ['token', 'submit'] : ['email', 'password', 'submit'];
  }

  setMode(nextMode) {
    const normalized = nextMode === 'token' ? 'token' : 'credentials';
    if (this.submitting || this.successPayload) return;
    if (this.mode === normalized) return;
    this.mode = normalized;
    this.error = null;
    this.focus = normalized === 'token' ? 'token' : (this.email ? 'password' : 'email');
  }

  moveFocus(delta) {
    const fields = this.fieldsForMode();
    const current = Math.max(0, fields.indexOf(this.focus));
    const next = (current + delta + fields.length) % fields.length;
    this.focus = fields[next];
  }

  activeFieldKey() {
    if (this.focus === 'email' || this.focus === 'password' || this.focus === 'token') return this.focus;
    return null;
  }

  getFieldValue(field) {
    if (field === 'email') return this.email;
    if (field === 'password') return this.password;
    if (field === 'token') return this.token;
    return '';
  }

  getFieldCursor(field) {
    if (field === 'email') return this.emailCursor;
    if (field === 'password') return this.passwordCursor;
    if (field === 'token') return this.tokenCursor;
    return 0;
  }

  setField(field, value, cursor) {
    const clamped = Math.max(0, Math.min(value.length, cursor));
    if (field === 'email') {
      this.email = value;
      this.emailCursor = clamped;
    } else if (field === 'password') {
      this.password = value;
      this.passwordCursor = clamped;
    } else if (field === 'token') {
      this.token = value;
      this.tokenCursor = clamped;
    }
  }

  insertIntoActive(rawText) {
    const field = this.activeFieldKey();
    if (!field) return false;
    const clean = String(rawText ?? '').replace(/[\r\n]/g, '').slice(0, 512);
    if (!clean) return false;
    const value = this.getFieldValue(field);
    const cursor = this.getFieldCursor(field);
    this.setField(field, value.slice(0, cursor) + clean + value.slice(cursor), cursor + clean.length);
    this.error = null;
    return true;
  }

  setServerStatus(status, detail = '') {
    this.serverStatus = status;
    this.serverDetail = String(detail || '');
  }

  setError(message, { tone = 'danger', retryAfter = 0 } = {}) {
    const retryUntil = Number(retryAfter) > 0 ? Date.now() + Number(retryAfter) * 1000 : 0;
    this.error = { message: String(message || 'Sign in failed.'), tone, retryUntil };
  }

  setSuccess(payload) {
    this.submitting = false;
    this.error = null;
    this.successPayload = payload;
  }

  validate() {
    if (this.mode === 'token') {
      const token = this.token.trim();
      if (!token) {
        this.focus = 'token';
        this.setError('Paste a Gatita API key (gsk_...) or session token.', { tone: 'warning' });
        return null;
      }
      return { mode: 'token', token };
    }
    const email = this.email.trim();
    const password = this.password;
    if (!email) {
      this.focus = 'email';
      this.setError('Enter your Gatita account email.', { tone: 'warning' });
      return null;
    }
    if (!EMAIL_RE.test(email)) {
      this.focus = 'email';
      this.setError('Enter a valid email address.', { tone: 'warning' });
      return null;
    }
    if (!password) {
      this.focus = 'password';
      this.setError('Enter your password.', { tone: 'warning' });
      return null;
    }
    return { mode: 'credentials', email, password };
  }

  triggerSubmit() {
    if (this.submitting || this.successPayload) return false;
    const data = this.validate();
    if (!data) return false;
    this.error = null;
    this.submitting = true;
    this.abortController = new AbortController();
    this.onSubmit?.(data, this.abortController.signal);
    return true;
  }

  cancelInFlight() {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.submitting = false;
  }

  async handlePasteFromClipboard() {
    if (typeof this.readClipboard !== 'function') return false;
    try {
      const text = await this.readClipboard();
      if (text) return this.insertIntoActive(text);
    } catch {
      // Clipboard unavailable.
    }
    return false;
  }

  handleMouse(key) {
    if (!key.press || key.button !== 0) return false;
    const rowIndex = Number(key.row) - 1;
    const colIndex = Number(key.column) - 1;
    const rowHits = this.hits[rowIndex] || [];
    const hit = rowHits.find((entry) => colIndex >= entry.col && colIndex < entry.col + entry.width);
    if (!hit) return false;
    if (this.successPayload) {
      this.onComplete?.(this.successPayload);
      return true;
    }
    if (this.submitting) return false;
    if (hit.type === 'tab') {
      this.setMode(hit.mode);
      return true;
    }
    if (hit.type === 'focus') {
      this.focus = hit.field;
      return true;
    }
    if (hit.type === 'toggle-secret') {
      this.showSecret = !this.showSecret;
      return true;
    }
    if (hit.type === 'submit') {
      this.focus = 'submit';
      this.triggerSubmit();
      return true;
    }
    return false;
  }

  handleKey(key) {
    if (!key) return false;
    if (key.name === 'mouse') return this.handleMouse(key);

    if (this.successPayload) {
      if (key.name === 'enter' || key.name === 'escape' || key.text === ' ') {
        this.onComplete?.(this.successPayload);
        return true;
      }
      return false;
    }

    if (key.ctrl && key.text === 'c') {
      this.cancelInFlight();
      this.onCancel?.();
      return true;
    }

    if (key.name === 'escape') {
      if (this.submitting) {
        this.cancelInFlight();
        this.setError('Sign-in cancelled. Edit your details and try again.', { tone: 'warning' });
        return true;
      }
      this.onCancel?.();
      return true;
    }

    if (this.submitting) return false;

    if (key.name === 'paste') {
      return this.insertIntoActive(key.text || '');
    }

    if (key.ctrl && key.text === 'v') {
      void this.handlePasteFromClipboard();
      return true;
    }

    if (key.ctrl && key.text === 'r') {
      this.showSecret = !this.showSecret;
      return true;
    }

    if (key.alt && key.text === '1') {
      this.setMode('credentials');
      return true;
    }
    if (key.alt && key.text === '2') {
      this.setMode('token');
      return true;
    }

    if (key.name === 'tab') {
      this.moveFocus(key.shift ? -1 : 1);
      return true;
    }
    if (key.name === 'down') {
      this.moveFocus(1);
      return true;
    }
    if (key.name === 'up') {
      this.moveFocus(-1);
      return true;
    }

    if (key.name === 'enter') {
      if (this.mode === 'credentials' && this.focus === 'email' && !this.password) {
        if (this.email.trim()) {
          this.focus = 'password';
          this.error = null;
          return true;
        }
      }
      this.triggerSubmit();
      return true;
    }

    if (this.focus === 'submit') {
      if (key.name === 'left' || key.name === 'right') {
        this.setMode(this.mode === 'credentials' ? 'token' : 'credentials');
        return true;
      }
      if ((key.name === 'text' || key.name === 'char') && key.text === ' ') {
        this.triggerSubmit();
        return true;
      }
      return false;
    }

    const field = this.activeFieldKey();
    if (!field) return false;
    const value = this.getFieldValue(field);
    const cursor = this.getFieldCursor(field);

    if (key.name === 'backspace') {
      const before = codePointBefore(value, cursor);
      this.setField(field, value.slice(0, before) + value.slice(cursor), before);
      this.error = null;
      return true;
    }
    if (key.name === 'delete') {
      const after = codePointAfter(value, cursor);
      this.setField(field, value.slice(0, cursor) + value.slice(after), cursor);
      this.error = null;
      return true;
    }
    if (key.name === 'left') {
      if (cursor === 0 && !value) {
        this.setMode(this.mode === 'credentials' ? 'token' : 'credentials');
      } else {
        this.setField(field, value, codePointBefore(value, cursor));
      }
      return true;
    }
    if (key.name === 'right') {
      if (cursor === value.length && !value) {
        this.setMode(this.mode === 'credentials' ? 'token' : 'credentials');
      } else {
        this.setField(field, value, codePointAfter(value, cursor));
      }
      return true;
    }
    if (key.name === 'home' || (key.ctrl && key.text === 'a')) {
      this.setField(field, value, 0);
      return true;
    }
    if (key.name === 'end' || (key.ctrl && key.text === 'e')) {
      this.setField(field, value, value.length);
      return true;
    }
    if (key.ctrl && key.text === 'u') {
      this.setField(field, value.slice(cursor), 0);
      this.error = null;
      return true;
    }
    if (key.ctrl && key.text === 'k') {
      this.setField(field, value.slice(0, cursor), cursor);
      this.error = null;
      return true;
    }
    if (key.ctrl && key.text === 'w') {
      let idx = cursor;
      while (idx > 0 && /\s/.test(value[idx - 1])) idx -= 1;
      while (idx > 0 && !/\s/.test(value[idx - 1])) idx -= 1;
      this.setField(field, value.slice(0, idx) + value.slice(cursor), idx);
      this.error = null;
      return true;
    }
    if ((key.name === 'text' || key.name === 'char') && !key.ctrl && !key.alt) {
      return this.insertIntoActive(key.text);
    }
    return false;
  }

  shimmer(text) {
    if (!this.animations) return this.styler.fg('accent', text);
    const chars = [...text];
    const pos = Math.floor(this.tick / 2) % (chars.length + 8) - 4;
    return chars.map((ch, i) => (Math.abs(i - pos) <= 2 ? this.styler.fg('accent', ch) : this.styler.fg('muted', ch))).join('');
  }

  renderField({
    label,
    field,
    value,
    cursor,
    placeholder,
    secret = false,
    statusBadge = '',
    rightAction = null,
    innerWidth,
  }) {
    const s = this.styler;
    const focused = this.focus === field && !this.submitting;
    const borderColor = focused ? 'accent' : 'border';
    const labelColor = focused ? 'accent' : 'muted';
    const boxInner = Math.max(10, innerWidth - 2);
    const textWidth = Math.max(4, boxInner - 2);

    const leftLabel = ` ${label} `;
    const statusText = statusBadge ? ` ${statusBadge} ` : '';
    const actionLabel = rightAction ? ` ${rightAction.label} ` : '';
    const fillCount = Math.max(0, boxInner - 1 - visibleWidth(leftLabel) - visibleWidth(statusText) - visibleWidth(actionLabel));
    const topLine = `${s.fg(borderColor, '╭─')}${s.bold(s.fg(labelColor, leftLabel))}${statusText}${s.fg(borderColor, '─'.repeat(fillCount))}${rightAction ? s.fg(focused ? 'accent' : 'faint', actionLabel) : ''}${s.fg(borderColor, '╮')}`;

    const displayRaw = secret && !this.showSecret ? '•'.repeat([...value].length) : value;
    const displayChars = [...displayRaw];
    const charCursor = [...value.slice(0, cursor)].length;

    // Horizontal viewport windowing so long emails/tokens stay cleanly inside the box.
    let windowStart = 0;
    if (charCursor >= textWidth) {
      windowStart = charCursor - textWidth + 1;
    }
    const visibleSlice = displayChars.slice(windowStart, windowStart + textWidth).join('');
    const relCursor = charCursor - windowStart;

    let bodyContent;
    if (!displayRaw && !focused) {
      bodyContent = s.fg('faint', truncateVisible(placeholder, textWidth));
    } else if (!displayRaw && focused) {
      bodyContent = `${s.inverse(' ')}${s.fg('faint', truncateVisible(placeholder, Math.max(0, textWidth - 1)))}`;
    } else if (focused) {
      const before = sliceVisible(visibleSlice, 0, relCursor);
      const cell = sliceVisible(visibleSlice, relCursor, 1) || ' ';
      const after = sliceVisible(visibleSlice, relCursor + 1);
      bodyContent = `${s.fg('text', before)}${s.inverse(cell)}${s.fg('text', after)}`;
    } else {
      bodyContent = s.fg('text', truncateVisible(visibleSlice, textWidth));
    }

    const paddedBody = ` ${padEndVisible(bodyContent, textWidth)} `;
    const midLine = `${s.fg(borderColor, '│')}${paintSurface(paddedBody, s, focused ? 'surface2' : 'ink')}${s.fg(borderColor, '│')}`;
    const botLine = s.fg(borderColor, `╰${'─'.repeat(boxInner)}╯`);

    const actionColOffset = rightAction
      ? Math.max(0, boxInner + 1 - visibleWidth(actionLabel))
      : -1;

    return {
      lines: [topLine, midLine, botLine],
      hits: [
        rightAction ? [{ type: 'toggle-secret', relCol: actionColOffset, width: visibleWidth(actionLabel) }] : [],
        [{ type: 'focus', field, relCol: 0, width: innerWidth }],
        [],
      ],
    };
  }

  renderServerStatus() {
    const s = this.styler;
    if (this.serverStatus === 'online') {
      const detail = this.serverDetail ? ` · ${this.serverDetail}` : '';
      return `${s.fg('success', GLYPHS.active)} ${s.fg('muted', 'connected')}${s.fg('faint', detail)}`;
    }
    if (this.serverStatus === 'offline') {
      return `${s.fg('danger', GLYPHS.pending)} ${s.fg('danger', 'unreachable')}`;
    }
    const spin = this.animations ? selectGlyph(SPINNER, this.tick) : GLYPHS.running;
    return `${s.fg('accent', spin)} ${s.fg('faint', 'checking server...')}`;
  }

  renderSuccessCard(cardInner) {
    const s = this.styler;
    const payload = this.successPayload;
    const name = payload?.user?.displayName || payload?.user?.email || 'friend';
    const email = payload?.user?.email || '';
    const planId = payload?.plan?.id || payload?.user?.plan || 'free';
    const planLabel = (payload?.plan?.displayName || 'Free').replace(/^Gatita\s+/i, '').toUpperCase();
    const pStyle = planStyle(planId);
    const planPill = s.pill(pStyle.fg, pStyle.bg, planLabel, { isBold: true });

    const lines = [];
    lines.push('');
    lines.push(centerVisible(`${s.fg('success', GLYPHS.checked)}  ${s.bold(s.fg('text', `Welcome back, ${truncateVisible(name, Math.max(10, cardInner - 20))}`))}`, cardInner));
    if (email && email !== name) {
      lines.push(centerVisible(`${s.fg('muted', email)}  ${planPill}`, cardInner));
    } else {
      lines.push(centerVisible(planPill, cardInner));
    }
    lines.push('');

    const windows = payload?.quota?.windows || [];
    if (windows.length) {
      const win = windows[0];
      const pct = Math.max(0, Math.min(100, Number(win.percent) || 0));
      const barW = Math.max(10, Math.min(26, cardInner - 22));
      const color = pct >= 90 ? 'danger' : pct >= 75 ? 'warning' : 'accent';
      const remaining = `${formatTokens(win.remaining)} left`;
      lines.push(centerVisible(`${s.fg('faint', String(win.shortLabel || win.label || 'quota').toLowerCase())}  ${progressBar(pct, barW, s, color)}  ${s.fg('muted', remaining)}`, cardInner));
      lines.push('');
    }

    const spin = this.animations ? selectGlyph(SPINNER, this.tick) : GLYPHS.caret;
    lines.push(centerVisible(`${s.fg('accent', spin)} ${s.fg('muted', 'entering Gatita Studio...')}`, cardInner));
    lines.push(centerVisible(s.fg('faint', 'session saved to this machine · press any key'), cardInner));
    lines.push('');
    return { lines, lineHits: lines.map(() => []) };
  }

  render(cols, rows) {
    const s = this.styler;
    const width = Math.max(36, Math.min(cols - 4, 62));
    const cardInner = Math.max(20, width - 6); // 1 border + 2 padding on each side

    const headerLines = [
      centerVisible(`${s.fg('accent', GLYPHS.cat)}  ${s.bold(s.fg('text', 'G A T I T A   S T U D I O'))}`, width),
      centerVisible(`${s.fg('muted', 'Your terminal. Her territory.')}  ${s.fg('faint', `v${CLIENT_VERSION}`)}`, width),
    ];

    const bodyLines = [];
    const bodyHits = [];
    const pushBody = (line, hitList = []) => {
      bodyLines.push(line);
      bodyHits.push(hitList);
    };

    if (this.successPayload) {
      const success = this.renderSuccessCard(cardInner);
      success.lines.forEach((line, idx) => pushBody(line, success.lineHits[idx]));
    } else {
      // Server status row
      const host = this.serverUrl.replace(/^https?:\/\//, '');
      const statusLeft = this.renderServerStatus();
      const hostRight = s.fg('faint', truncateVisible(host, Math.max(10, cardInner - visibleWidth(statusLeft) - 2)));
      const gap = Math.max(1, cardInner - visibleWidth(statusLeft) - visibleWidth(hostRight));
      pushBody(`${statusLeft}${' '.repeat(gap)}${hostRight}`);
      pushBody(s.fg('border', '─'.repeat(cardInner)));

      // Mode tabs
      const credActive = this.mode === 'credentials';
      const tokenActive = this.mode === 'token';
      const credLabel = credActive
        ? s.pill('accent', 'accentBg', `${GLYPHS.active} Account`, { isBold: true })
        : s.pill('muted', 'surface2', `${GLYPHS.pending} Account`);
      const tokenLabel = tokenActive
        ? s.pill('accent', 'accentBg', `${GLYPHS.active} API Key`, { isBold: true })
        : s.pill('muted', 'surface2', `${GLYPHS.pending} API Key`);
      const credWidth = visibleWidth(credLabel);
      const tokenWidth = visibleWidth(tokenLabel);
      const tabHint = cardInner >= 44 ? s.fg('faint', 'alt+1 / alt+2') : '';
      const tabGap = Math.max(1, cardInner - credWidth - tokenWidth - 1 - visibleWidth(tabHint));
      pushBody(`${credLabel} ${tokenLabel}${' '.repeat(tabGap)}${tabHint}`, [
        { type: 'tab', mode: 'credentials', relCol: 0, width: credWidth },
        { type: 'tab', mode: 'token', relCol: credWidth + 1, width: tokenWidth },
      ]);
      pushBody('');

      if (this.mode === 'credentials') {
        const emailValid = this.email.trim().length > 0 && EMAIL_RE.test(this.email.trim());
        const emailBadge = emailValid ? s.fg('success', GLYPHS.checked) : '';
        const emailField = this.renderField({
          label: 'email',
          field: 'email',
          value: this.email,
          cursor: this.emailCursor,
          placeholder: 'you@example.com',
          statusBadge: emailBadge,
          innerWidth: cardInner,
        });
        emailField.lines.forEach((line, idx) => pushBody(line, emailField.hits[idx]));

        const pwField = this.renderField({
          label: 'password',
          field: 'password',
          value: this.password,
          cursor: this.passwordCursor,
          placeholder: 'enter your password',
          secret: true,
          rightAction: { label: this.showSecret ? 'hide · ^r' : 'show · ^r' },
          innerWidth: cardInner,
        });
        pwField.lines.forEach((line, idx) => pushBody(line, pwField.hits[idx]));
      } else {
        const prefixOk = /^(gsk_|gst_)/.test(this.token.trim());
        const tokenBadge = prefixOk ? s.fg('success', `${GLYPHS.checked} key`) : '';
        const tokenField = this.renderField({
          label: 'api key or session token',
          field: 'token',
          value: this.token,
          cursor: this.tokenCursor,
          placeholder: 'gsk_... or gst_...',
          secret: true,
          statusBadge: tokenBadge,
          rightAction: { label: this.showSecret ? 'hide · ^r' : 'show · ^r' },
          innerWidth: cardInner,
        });
        tokenField.lines.forEach((line, idx) => pushBody(line, tokenField.hits[idx]));
        pushBody(s.fg('faint', truncateVisible('Paste an API key or session token (ctrl+v).', cardInner)));
      }

      // Error / feedback banner
      if (this.error) {
        pushBody('');
        let message = this.error.message;
        if (this.error.retryUntil > Date.now()) {
          const secs = Math.max(1, Math.ceil((this.error.retryUntil - Date.now()) / 1000));
          message = `Too many sign-in attempts. Try again in ${secs}s.`;
        }
        const tone = this.error.tone || 'danger';
        const bgTone = tone === 'warning' ? 'warningBg' : 'dangerBg';
        const glyph = tone === 'warning' ? '!' : GLYPHS.failed;
        const bannerText = ` ${glyph} ${truncateVisible(message, Math.max(8, cardInner - 4))} `;
        pushBody(paintSurface(padEndVisible(s.fg(tone, bannerText), cardInner), s, bgTone));
      }

      // Submit button
      pushBody('');
      const submitFocused = this.focus === 'submit' && !this.submitting;
      let btnLabel;
      if (this.submitting) {
        const spin = this.animations ? selectGlyph(SPINNER, this.tick) : GLYPHS.running;
        btnLabel = `${spin}  ${this.shimmer('signing in...')}`;
      } else {
        const verb = this.mode === 'token' ? 'Connect with key' : 'Sign in to Gatita';
        btnLabel = submitFocused
          ? s.bold(s.fg('ink', ` ${GLYPHS.caret} ${verb} `))
          : s.bold(s.fg('accent', ` ${GLYPHS.caret} ${verb} `));
      }
      const btnBg = this.submitting ? 'surface2' : (submitFocused ? 'accent' : 'accentBg');
      const btnWidth = Math.min(cardInner, Math.max(24, visibleWidth(btnLabel) + 6));
      const btnInner = centerVisible(btnLabel, btnWidth);
      const btnPadLeft = Math.max(0, Math.floor((cardInner - btnWidth) / 2));
      const btnRendered = `${' '.repeat(btnPadLeft)}${paintSurface(padEndVisible(btnInner, btnWidth), s, btnBg)}`;
      pushBody(btnRendered, [{ type: 'submit', relCol: btnPadLeft, width: btnWidth }]);
    }

    // Wrap body inside a sleek rounded card
    const innerBoxWidth = width - 2;
    const titleTag = this.successPayload ? ' signed in ' : ' sign in ';
    const border = this.successPayload ? 'success' : (this.error ? 'warning' : 'accent');
    const topFill = Math.max(0, innerBoxWidth - 1 - visibleWidth(titleTag));
    const cardTop = `${s.fg(border, '╭─')}${s.bold(s.fg(border, titleTag))}${s.fg(border, `${'─'.repeat(topFill)}╮`)}`;
    const cardMid = bodyLines.map((line) => {
      const padded = `  ${padEndVisible(truncateVisible(line, cardInner), cardInner)}  `;
      return `${s.fg(border, '│')}${paintSurface(padded, s, 'surface')}${s.fg(border, '│')}`;
    });
    const footerHint = this.successPayload
      ? 'ready · models: Gatita Fast · Gatita Max · Gatita Aura'
      : (this.submitting
        ? 'esc cancel'
        : 'tab next · enter sign in · ctrl+r reveal · ctrl+v paste · esc quit');
    const cardDiv = s.fg(border, `├${'─'.repeat(innerBoxWidth)}┤`);
    const cardFooter = `${s.fg(border, '│')}${paintSurface(`  ${padEndVisible(s.fg('faint', truncateVisible(footerHint, cardInner)), cardInner)}  `, s, 'surface')}${s.fg(border, '│')}`;
    const cardBot = s.fg(border, `╰${'─'.repeat(innerBoxWidth)}╯`);

    const block = [
      ...headerLines,
      '',
      cardTop,
      ...cardMid,
      cardDiv,
      cardFooter,
      cardBot,
    ];

    const leftPadCount = Math.max(0, Math.floor((cols - width) / 2));
    const leftPad = ' '.repeat(leftPadCount);
    const topPad = Math.max(0, Math.floor((rows - block.length) / 2));
    const inkBg = inkBackground(s);
    const bodyStartInBlock = headerLines.length + 2; // headerLines + blank + cardTop
    const cardContentOffset = leftPadCount + 3; // leftPad + '│' + 2 spaces

    this.hits = new Array(rows).fill(null);
    const output = [];
    for (let row = 0; row < rows; row += 1) {
      const blockIdx = row - topPad;
      if (blockIdx >= 0 && blockIdx < block.length) {
        const rendered = `${leftPad}${block[blockIdx]}`;
        const truncated = truncateVisible(rendered, cols);
        const rightPad = Math.max(0, cols - visibleWidth(truncated));
        output.push(paintRow(`${truncated}${inkBg}${' '.repeat(rightPad)}`, s));

        const bodyIdx = blockIdx - bodyStartInBlock;
        if (bodyIdx >= 0 && bodyIdx < bodyHits.length && bodyHits[bodyIdx]?.length) {
          this.hits[row] = bodyHits[bodyIdx].map((hit) => ({
            ...hit,
            col: cardContentOffset + (hit.relCol || 0),
          }));
        }
      } else {
        output.push(`${inkBg}${' '.repeat(cols)}`);
      }
    }
    return output;
  }
}

export async function runInteractiveLogin({
  config,
  createClient,
  saveAuth,
  saveUserConfig,
  initialEmail = '',
  initialMode = 'credentials',
  readClipboard = null,
  welcomeDelayMs = 650,
} = {}) {
  const terminal = new Terminal();
  let resolved = false;
  let animTimer = null;
  let welcomeTimer = null;
  let pendingResult = null;

  return new Promise((resolve, reject) => {
    const finish = (err, result) => {
      if (resolved) return;
      resolved = true;
      clearInterval(animTimer);
      clearTimeout(welcomeTimer);
      view.cancelInFlight();
      terminal.leave();
      if (err) reject(err);
      else resolve(result);
    };

    const view = new LoginView({
      serverUrl: config.serverUrl,
      theme: config.theme || 'dark',
      animations: config.animations !== false,
      initialEmail,
      initialMode,
      readClipboard,
      onCancel: () => finish(new Error('Cancelled.')),
      onComplete: () => {
        if (pendingResult) finish(null, pendingResult);
      },
      onSubmit: async (data, signal) => {
        terminal.requestRender();
        try {
          let client;
          let payload;
          if (data.mode === 'token') {
            client = createClient({ serverUrl: config.serverUrl, token: data.token });
            const me = await client.me({ timeoutMs: 15_000, signal });
            payload = { ...me, token: data.token, expiresAt: null };
            saveAuth(config.serverUrl, {
              token: data.token,
              expiresAt: null,
              email: me?.user?.email || '',
              displayName: me?.user?.displayName || '',
              plan: me?.plan?.id || me?.user?.plan || 'free',
            });
          } else {
            client = createClient({ serverUrl: config.serverUrl, token: '' });
            payload = await client.login(data.email, data.password, { signal });
            saveAuth(config.serverUrl, {
              token: payload.token,
              expiresAt: payload.expiresAt,
              email: payload.user?.email || data.email,
              displayName: payload.user?.displayName || '',
              plan: payload.plan?.id || payload.user?.plan || 'free',
            });
          }
          if (payload?.server?.defaultModel && !config.defaultModel) {
            config.defaultModel = payload.server.defaultModel;
            saveUserConfig?.(config);
          }
          const result = { client, me: payload, config, source: data.mode === 'token' ? 'session' : 'login' };
          pendingResult = result;
          view.setSuccess(payload);
          terminal.requestRender();
          welcomeTimer = setTimeout(() => finish(null, result), Math.max(0, welcomeDelayMs));
          welcomeTimer.unref?.();
        } catch (error) {
          if (signal.aborted) return;
          view.submitting = false;
          const status = Number(error?.status || 0);
          const message = error?.kind === 'api'
            ? error.message
            : 'Could not reach the Gatita server. Check your connection.';
          if (status === 401 && data.mode === 'credentials') {
            view.password = '';
            view.passwordCursor = 0;
            view.focus = 'password';
          }
          view.setError(message, {
            tone: status === 429 ? 'warning' : 'danger',
            retryAfter: error?.retryAfter || 0,
          });
          terminal.requestRender();
        }
      },
    });

    // Background health probe so the user sees live connection state immediately.
    const probeClient = createClient({ serverUrl: config.serverUrl, token: '' });
    probeClient.health({ timeoutMs: 6_000 }).then((health) => {
      if (resolved) return;
      const detail = health?.inference === 'ready' || health?.inference === true ? 'ready' : '';
      view.setServerStatus('online', detail);
      terminal.requestRender();
    }).catch(() => {
      if (resolved) return;
      view.setServerStatus('offline');
      terminal.requestRender();
    });

    terminal.onKey((key) => {
      view.handleKey(key);
      terminal.requestRender();
    });
    terminal.onResizeEvent(() => terminal.requestRender());
    terminal.enter();
    terminal.start(() => view.render(terminal.columns, terminal.rows));

    animTimer = setInterval(() => {
      view.tick += 1;
      if (view.animations && (view.submitting || view.serverStatus === 'checking' || view.successPayload || (view.error?.retryUntil > Date.now()))) {
        terminal.requestRender();
      }
    }, 90);
    animTimer.unref?.();
  });
}

// Re-exported for convenience when painting custom surfaces.
export { bgEscape };
