import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadConfig, saveConfig } from './config.js';
import { authToken, clearStoredAuth, getStoredAuth, maskToken, readAuthFile, saveStoredAuth } from './authStore.js';
import { createApiClient, ApiError } from './api.js';
import { openLocalStore } from './store.js';
import { loadSkills } from '../skills/index.js';
import { loadPlugins } from '../plugins/index.js';
import { loadMcpConfig, createMcpManager } from '../mcp/index.js';
import { discoverMcpServers } from '../mcp/discover.js';
import { filePaths } from './paths.js';
import { createStyler, GLYPHS, padEndVisible, truncateVisible, visibleWidth } from './theme.js';
import { COMPUTER_HELPER_PATH } from '../computer/index.js';
import { progressBar, roundedBox } from './tui/render.js';
import { runInteractiveLogin } from './tui/login.js';
import { readClipboard } from './clipboard.js';
import { formatDuration, formatTokens, plural } from '../shared/util.js';
import { CLIENT_VERSION } from '../shared/protocol.js';
import { checkForUpdate, downloadUpdate, installTarball, formatUpdateNotice } from './update.js';

function activeStyler(theme = 'dark') {
  return createStyler(theme, { enabled: Boolean(stdout.isTTY) });
}

const styler = createStyler('dark');

function color(hex, text) {
  return stdout.isTTY ? styler.fg(hex, text) : String(text);
}

function cliWidth(max = 76) {
  return Math.max(44, Math.min(max, (stdout.columns || max) - 4));
}

function printHeader(title, subtitle = '', theme = 'dark') {
  const s = activeStyler(theme);
  console.log();
  const badge = subtitle ? `  ${s.pill('accent', 'accentBg', subtitle, { isBold: true })}` : '';
  console.log(`  ${s.fg('accent', GLYPHS.cat)}  ${s.bold(s.fg('text', title))}${badge}`);
}

async function readLineWithReadline(prompt) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

async function readLine(prompt, { secret = false } = {}) {
  if (!stdin.isTTY) return (await readLineWithReadline(prompt)).trim();

  return new Promise((resolve, reject) => {
    let value = '';
    let done = false;
    const cleanup = () => {
      stdin.removeListener('data', onData);
      try {
        stdin.setRawMode(false);
      } catch {
        // Ignore.
      }
      stdin.pause();
    };
    const finish = (error) => {
      if (done) return;
      done = true;
      cleanup();
      stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      const text = String(chunk);
      for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        if (char === '\u001b') {
          index += 1;
          if (text[index] === '[' || text[index] === 'O') {
            while (index + 1 < text.length && /[0-9;]/.test(text[index + 1])) index += 1;
            index += 1;
          }
          continue;
        }
        if (char === '\r' || char === '\n') {
          finish();
          return;
        }
        if (char === '\u0003') {
          finish(new Error('Cancelled'));
          return;
        }
        if (char === '\u0004') {
          if (!value) {
            finish(new Error('Cancelled'));
            return;
          }
          continue;
        }
        if (char === '\u007f' || char === '\b') {
          if (value.length) {
            value = value.slice(0, -1);
            stdout.write('\b \b');
          }
          continue;
        }
        if (char >= ' ') {
          value += char;
          stdout.write(secret ? '•' : char);
        }
      }
    };
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    try {
      stdin.setRawMode(true);
    } catch {
      finish(new Error('This terminal cannot read input.'));
      return;
    }
    stdout.write(prompt);
    stdin.resume();
  });
}

async function ask(question, fallback = '') {
  const answer = await readLine(question);
  return answer.trim() || fallback;
}

export async function readSecret(prompt) {
  return readLine(prompt, { secret: true });
}

function printSignInBanner(config) {
  if (!stdout.isTTY) {
    console.log(color('accent', `${GLYPHS.cat} Gatita Studio v${CLIENT_VERSION}`));
    console.log(color('muted', 'Sign in with your Gatita account.'));
    console.log(color('faint', `server: ${config.serverUrl}`));
    return;
  }
  const s = createStyler(config.theme || 'dark', { enabled: true });
  const width = Math.max(36, Math.min(56, (stdout.columns || 56) - 4));
  console.log();
  console.log(`  ${s.fg('accent', GLYPHS.cat)}  ${s.bold(s.fg('text', 'G A T I T A   S T U D I O'))}  ${s.fg('faint', `v${CLIENT_VERSION}`)}`);
  console.log(`     ${s.fg('muted', 'Your terminal. Her territory.')}`);
  console.log();
  const box = roundedBox({
    width,
    styler: s,
    title: 'sign in',
    padding: 1,
    background: 'surface',
    borderColor: 'accent',
    lines: [
      s.fg('text', 'Welcome back.'),
      '',
      `${s.fg('faint', 'server ')} ${s.fg('muted', config.serverUrl)}`,
      `${s.fg('faint', 'models ')} ${s.fg('muted', 'Gatita Fast · Gatita Max · Gatita Aura')}`,
      `${s.fg('faint', 'session')} ${s.fg('muted', 'saved securely to this machine')}`,
    ],
  });
  for (const line of box) console.log(`  ${line}`);
  console.log();
}

export async function ensureLogin({
  config = loadConfig(),
  force = false,
  initialEmail = '',
  initialMode = 'credentials',
  tokenOverride = '',
} = {}) {
  const directToken = String(tokenOverride || '').trim();
  if (directToken) {
    const client = createApiClient({ serverUrl: config.serverUrl, token: directToken });
    const me = await client.me({ timeoutMs: 15_000 });
    saveStoredAuth(config.serverUrl, {
      token: directToken,
      expiresAt: null,
      email: me?.user?.email || '',
      displayName: me?.user?.displayName || '',
      plan: me?.plan?.id || me?.user?.plan || 'free',
    });
    return { client, me, config, source: 'session' };
  }

  let token = force ? '' : authToken(config.serverUrl);
  if (token) {
    const client = createApiClient({ serverUrl: config.serverUrl, token });
    try {
      const me = await client.me({ timeoutMs: 10_000 });
      return { client, me, config, source: 'session' };
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        clearStoredAuth(config.serverUrl);
      } else {
        throw error;
      }
    }
  }

  const savedEntry = readAuthFile().servers?.[String(config.serverUrl)] || null;
  const prefillEmail = String(initialEmail || savedEntry?.email || '').trim();

  if (stdin.isTTY && stdout.isTTY && process.env.GATITA_SIMPLE_LOGIN !== '1') {
    return runInteractiveLogin({
      config,
      createClient: createApiClient,
      saveAuth: saveStoredAuth,
      saveUserConfig: saveConfig,
      initialEmail: prefillEmail,
      initialMode,
      readClipboard,
    });
  }

  printSignInBanner(config);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const emailPrompt = prefillEmail ? `Email [${prefillEmail}]: ` : 'Email: ';
    const email = await ask(emailPrompt, prefillEmail);
    if (!email) continue;
    const password = await readSecret('Password: ');
    if (!password) continue;
    const client = createApiClient({ serverUrl: config.serverUrl, token: '' });
    try {
      console.log(color('muted', 'Signing in…'));
      const payload = await client.login(email, password);
      saveStoredAuth(config.serverUrl, {
        token: payload.token,
        expiresAt: payload.expiresAt,
        email: payload.user?.email || email,
        displayName: payload.user?.displayName || '',
        plan: payload.plan?.id || payload.user?.plan || 'free',
      });
      config.defaultModel = config.defaultModel || payload.server?.defaultModel;
      saveConfig(config);
      console.log(color('success', `Signed in as ${payload.user?.displayName || email} on ${payload.plan?.displayName || 'Free'}.`));
      return { client, me: payload, config, source: 'login' };
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'Could not reach the server.';
      console.error(color('danger', message));
      if (error instanceof ApiError && error.status === 401) continue;
      const retry = await ask('Try again? [Y/n]: ', 'y');
      if (retry.toLowerCase() === 'n') break;
    }
  }
  throw new Error('Sign in failed.');
}

// --- MCP and skills: make adding them a copy-paste, not a research project ---

function tokenizeArgs(input) {
  const tokens = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  const text = String(input || '');
  while ((match = pattern.exec(text)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

function parseKeyValues(values) {
  const output = {};
  for (const entry of values) {
    const index = String(entry).indexOf('=');
    if (index === -1) continue;
    output[String(entry).slice(0, index).trim()] = String(entry).slice(index + 1).trim();
  }
  return output;
}

function takeFlags(rest) {
  const flags = { env: [], header: [] };
  const positional = [];
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--url') flags.url = rest[++index];
    else if (arg === '--command') flags.command = rest[++index];
    else if (arg === '--args') flags.args = rest[++index];
    else if (arg === '--cwd') flags.cwd = rest[++index];
    else if (arg === '--scope') flags.scope = String(rest[++index] || '').toLowerCase();
    else if (arg === '--env') flags.env.push(rest[++index]);
    else if (arg === '--header') flags.header.push(rest[++index]);
    else positional.push(arg);
  }
  return { flags, positional };
}

export async function runMcpCommand(rest = []) {
  const [sub = 'list', ...tail] = rest;
  const command = String(sub || 'list').toLowerCase();
  const config = loadConfig();
  const paths = filePaths();
  const s = activeStyler(config.theme);

  if (command === 'discover') {
    console.log(s.fg('muted', 'Probing localhost for MCP servers…'));
    const found = await discoverMcpServers({});
    if (!found.http.length && !found.processes.length) {
      console.log('No running MCP servers found on localhost.');
      console.log(s.fg('muted', 'Start one (for example with npx -y @modelcontextprotocol/server-filesystem .) and run this again.'));
      return;
    }
    for (const hit of found.http) {
      const label = hit.serverName ? `${hit.serverName}${hit.serverVersion ? ` ${hit.serverVersion}` : ''}` : 'unknown server';
      console.log(`  ${s.fg('success', '●')} ${hit.url} ${s.fg('muted', `· ${label}`)}`);
    }
    for (const proc of found.processes) {
      console.log(`  ${s.fg('info', '◇')} pid ${proc.pid} ${s.fg('faint', proc.commandLine)}`);
    }
    console.log('');
    console.log(s.fg('muted', 'Attach one with:'));
    console.log('  gst mcp add <name> --url http://127.0.0.1:8000/mcp');
    return;
  }

  if (command === 'add') {
    const { flags, positional } = takeFlags(tail);
    const name = positional[0];
    if (!name) {
      console.log('Usage: gst mcp add <name> (--url <url> | --command <cmd> [--args "<args>"]) [--scope global|project] [--env KEY=VALUE]…');
      process.exitCode = 1;
      return;
    }
    const manager = createMcpManager({ cwd: process.cwd(), config });
    try {
      const args = flags.args ? tokenizeArgs(flags.args) : [];
      const result = await manager.addServer(name, {
        url: flags.url,
        command: flags.command,
        args,
        cwd: flags.cwd,
        env: parseKeyValues(flags.env),
        headers: parseKeyValues(flags.header),
      }, { scope: flags.scope === 'project' ? 'project' : 'global' });
      console.log(s.fg('success', `${GLYPHS.checked} Connected to ${result.name}: ${result.tools.length} tool(s).`));
      for (const tool of result.tools) console.log(`    ${s.fg('faint', tool)}`);
      if (result.file) console.log(s.fg('muted', `Saved to ${result.file}.`));
      if (result.warning) console.log(s.fg('warning', result.warning));
    } catch (error) {
      console.error(s.fg('danger', error?.message || String(error)));
      process.exitCode = 1;
    } finally {
      manager.closeAll();
    }
    return;
  }

  if (command === 'remove') {
    const name = String(tail[0] || '').trim();
    if (!name) {
      console.log('Usage: gst mcp remove <name>');
      process.exitCode = 1;
      return;
    }
    const manager = createMcpManager({ cwd: process.cwd(), config });
    try {
      const result = manager.removeServer(name);
      console.log(s.fg('success', `${GLYPHS.checked} Removed ${result.name}.`));
      if (result.removedFrom.length) console.log(s.fg('muted', `Was in: ${result.removedFrom.join(', ')}`));
      else console.log(s.fg('muted', 'It was not configured anywhere.'));
    } catch (error) {
      console.error(s.fg('danger', error?.message || String(error)));
      process.exitCode = 1;
    } finally {
      manager.closeAll();
    }
    return;
  }

  // list
  const manager = createMcpManager({ cwd: process.cwd(), config });
  try {
    await manager.connectAll();
    const status = manager.status();
    printHeader('MCP SERVERS', `${status.servers.length} connected`, config.theme);
    console.log();
    if (!status.servers.length && !status.errors.length) {
      console.log(`  ${s.fg('muted', 'No MCP servers configured.')}`);
      console.log(`  ${s.fg('faint', `Add one with "gst mcp add <name> --url <url>" or edit ${path.join(paths.home, 'mcp.json')}.`)}`);
      console.log(`  ${s.fg('faint', 'Tip: "gst mcp discover" probes this machine for running servers.')}`);
      console.log();
      return;
    }
    for (const server of status.servers) {
      console.log(`  ${s.fg('success', '●')} ${s.bold(s.fg('text', server.name))} ${s.fg('muted', `${server.tools} tool(s)${server.version ? ` · ${server.version}` : ''}`)}`);
      for (const tool of server.toolNames || []) console.log(`    ${s.fg('faint', tool)}`);
    }
    for (const error of status.errors) {
      console.log(`  ${s.fg('danger', '✗')} ${s.fg('text', error.server)} ${s.fg('faint', error.message)}`);
    }
    console.log();
    console.log(`  ${s.fg('faint', 'Tools appear in the app as mcp__<server>__<tool> and ask for approval.')}`);
    console.log();
  } finally {
    manager.closeAll();
  }
}

export async function runSkillsCommand() {
  const config = loadConfig();
  const s = activeStyler(config.theme);
  const skills = loadSkills({ cwd: process.cwd() });
  const home = filePaths().home;
  printHeader('SKILLS', `${skills.length} installed`, config.theme);
  console.log();
  if (!skills.length) {
    console.log(`  ${s.fg('muted', 'No skills installed yet.')}`);
    console.log(`  ${s.fg('faint', `Global skills live in ${path.join(home, 'skills')} (a premade example ships there).`)}`);
    console.log(`  ${s.fg('faint', 'Copy ~/.gatita-studio/skills/example to a new folder and edit SKILL.md.')}`);
    console.log();
    return;
  }
  for (const skill of skills) {
    console.log(`  ${s.fg('accent', GLYPHS.spark)} ${s.bold(s.fg('text', skill.name))} ${s.fg('faint', `(${skill.source})`)}`);
    if (skill.description) console.log(`    ${s.fg('muted', skill.description)}`);
  }
  console.log();
  console.log(`  ${s.fg('faint', 'Mention a skill with @name in the composer, or ask Gatita to use it.')}`);
  console.log();
}

export async function runLogin(rest = []) {
  const config = loadConfig();
  let initialEmail = '';
  let tokenOverride = '';
  let initialMode = 'credentials';
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--email' && rest[i + 1]) initialEmail = rest[++i];
    else if (arg === '--token' && rest[i + 1]) tokenOverride = rest[++i];
    else if (arg === '--key' || arg === '--api-key') initialMode = 'token';
  }
  const { me } = await ensureLogin({ config, force: true, initialEmail, initialMode, tokenOverride });
  const s = activeStyler(config.theme);
  const who = me?.user?.displayName || me?.user?.email || 'your account';
  const plan = me?.plan?.displayName || 'Free';
  if (stdout.isTTY) {
    const box = roundedBox({
      width: cliWidth(60),
      styler: s,
      title: 'session active',
      borderColor: 'success',
      titleColor: 'success',
      lines: [
        `${s.fg('success', GLYPHS.checked)} ${s.bold(s.fg('text', who))}  ${s.pill('accent', 'accentBg', plan.replace(/^Gatita\s+/i, '').toUpperCase(), { isBold: true })}`,
        '',
        `${s.fg('faint', 'server ')} ${s.fg('muted', config.serverUrl)}`,
        `${s.fg('faint', 'saved  ')} ${s.fg('muted', filePaths().auth)}`,
        '',
        s.fg('faint', 'Run "gst" or "gatita-studio" to open Gatita Studio.'),
      ],
    });
    console.log();
    for (const line of box) console.log(`  ${line}`);
    console.log();
  } else {
    console.log(s.fg('success', `Signed in as ${who} on ${plan}.`));
    console.log(s.fg('muted', `Server: ${config.serverUrl}`));
    console.log(s.fg('muted', `Session saved to ${filePaths().auth}`));
  }
  return me;
}

export function bestEffortLogout(client) {
  if (!client) return Promise.resolve();
  const timeout = new Promise((resolve) => {
    setTimeout(resolve, 1_000).unref?.();
  });
  return Promise.race([client.logout({ timeoutMs: 1_000 }).catch(() => {}), timeout]);
}

export async function runLogout() {
  const config = loadConfig();
  const s = activeStyler(config.theme);
  const token = authToken(config.serverUrl);
  const client = token ? createApiClient({ serverUrl: config.serverUrl, token }) : null;
  clearStoredAuth(config.serverUrl);
  console.log(`${s.fg('success', GLYPHS.checked)} Signed out.`);
  await bestEffortLogout(client);
}

export async function runModels() {
  const config = loadConfig();
  const s = activeStyler(config.theme);
  const { client, me } = await ensureLogin({ config });
  const payload = await client.models();
  const plan = (payload.plan?.displayName || me?.plan?.displayName || 'Free').replace(/^Gatita\s+/i, '');
  printHeader('GATITA MODELS', plan.toUpperCase(), config.theme);
  console.log();
  const lines = [];
  for (const model of payload.data) {
    const active = model.id === config.defaultModel;
    const marker = active ? s.fg('accent', GLYPHS.active) : s.fg('faint', GLYPHS.pending);
    const badges = [
      model.available ? '' : s.pill('warning', 'warningBg', `needs ${model.requiredPlan}`),
      model.tools ? s.pill('muted', 'surface2', 'tools') : s.pill('faint', 'surface2', 'chat'),
      model.vision ? s.pill('info', 'infoBg', 'vision') : '',
      model.reasoningLevels.length ? s.pill('accent2', 'accent2Bg', `think ${model.reasoningLevels.join('/')}`) : '',
      model.default ? s.pill('success', 'successBg', 'default') : '',
    ].filter(Boolean).join(' ');
    const context = `${formatTokens(model.contextWindow)} ctx`;
    lines.push(`${marker} ${s.bold(s.fg(active ? 'accent' : 'text', padEndVisible(model.name, 16)))} ${s.fg('faint', context.padEnd(10))} ${badges}`);
    lines.push(`  ${s.fg('muted', model.description)}`);
    lines.push('');
  }
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (stdout.isTTY) {
    const box = roundedBox({
      width: cliWidth(78),
      styler: s,
      title: 'catalog',
      subtitle: `${payload.data.length} models`,
      footer: 'switch anytime in the TUI with /model',
      borderColor: 'border',
      lines,
    });
    for (const line of box) console.log(`  ${line}`);
    console.log();
  } else {
    for (const line of lines) console.log(`  ${line}`);
  }
}

export async function runUsage() {
  const config = loadConfig();
  const s = activeStyler(config.theme);
  const { client } = await ensureLogin({ config });
  const report = await client.usage(30);
  const plan = (report.plan?.displayName || 'Free').replace(/^Gatita\s+/i, '');
  printHeader('USAGE', plan.toUpperCase(), config.theme);
  console.log();
  const lines = [];
  for (const window of report.windows || []) {
    const pct = Math.max(0, Math.min(100, Number(window.percent) || 0));
    const barColor = pct >= 90 ? 'danger' : pct >= 75 ? 'warning' : 'accent';
    const bar = progressBar(pct, 24, s, barColor);
    const reset = window.resetAt ? `resets in ${formatDuration(Math.max(0, window.resetAt - Date.now()), { compact: true })}` : 'no reset scheduled';
    lines.push(`${s.bold(s.fg('text', window.label.padEnd(8)))} ${bar}  ${s.fg('text', formatTokens(window.used))} ${s.fg('faint', '/')} ${s.fg('muted', formatTokens(window.limit))}`);
    lines.push(`         ${s.fg('faint', `${pct.toFixed(pct < 10 ? 1 : 0)}% used · ${reset}`)}`);
  }
  if (report.bankedResets?.count > 0) {
    lines.push('');
    lines.push(`${s.fg('accent', GLYPHS.diamond)} ${s.fg('text', `${report.bankedResets.count} banked reset${report.bankedResets.count === 1 ? '' : 's'} available`)} ${s.fg('faint', '· use /reset in the TUI')}`);
  }
  lines.push('');
  lines.push(s.fg('muted', `Last 30 days: ${formatTokens(report.totals.tokens)} tokens across ${plural(report.totals.requests, 'request')}.`));
  const models = (report.models || []).slice(0, 8);
  if (models.length) {
    const topTokens = Math.max(1, ...models.map((m) => Number(m.tokens) || 0));
    lines.push('');
    for (const model of models) {
      const share = Math.round(((Number(model.tokens) || 0) / topTokens) * 100);
      lines.push(`  ${s.fg('text', model.modelId.padEnd(16))} ${progressBar(share, 12, s, 'info')} ${s.fg('muted', formatTokens(model.tokens).padStart(7))}  ${s.fg('faint', plural(model.requests, 'request'))}`);
    }
  }
  if (stdout.isTTY) {
    const box = roundedBox({
      width: cliWidth(76),
      styler: s,
      title: 'quota & history',
      borderColor: 'border',
      lines,
    });
    for (const line of box) console.log(`  ${line}`);
    console.log();
  } else {
    for (const line of lines) console.log(`  ${line}`);
  }
}

export async function runDoctorCommand({ config: providedConfig } = {}) {
  const config = providedConfig || loadConfig();
  const s = activeStyler(config.theme);
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });
  add('Version', 'ok', `v${CLIENT_VERSION}`);
  add('Node', Number(process.versions.node.split('.')[0]) >= 24 ? 'ok' : 'fail', `v${process.versions.node} (need 24 or newer)`);
  add('Platform', 'ok', `${process.platform} ${process.arch}`);

  const paths = filePaths();
  try {
    const probe = path.join(paths.home, '.write-test');
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
    add('Data directory', 'ok', paths.home);
  } catch (error) {
    add('Data directory', 'fail', error.message);
  }
  add('Server URL', 'ok', config.serverUrl);
  const token = authToken(config.serverUrl);
  const session = token ? getStoredAuth(config.serverUrl) : null;
  add('Session', token ? 'ok' : 'warn', token ? `${session?.source === 'env' ? 'environment token' : 'saved auth file'} (${maskToken(token)})` : 'not signed in');

  const client = createApiClient({ serverUrl: config.serverUrl, token: authToken(config.serverUrl) });
  try {
    const health = await client.health({ timeoutMs: 8_000 });
    add('Server', 'ok', `reachable, inference ${health.inference}`);
  } catch (error) {
    const detail = error.status === 403 ? `${error.message}. Studio is not exposed at ${config.serverUrl} yet.` : error.message;
    add('Server', 'fail', detail);
  }
  if (authToken(config.serverUrl)) {
    try {
      const me = await client.me({ timeoutMs: 10_000 });
      add('Account', 'ok', `${me.user.email} on ${me.plan.displayName}`);
    } catch (error) {
      add('Account', 'fail', error.message);
    }
    try {
      const models = await client.models();
      add('Models', 'ok', `${models.data.length} Gatita models, default ${models.defaultModel}`);
    } catch (error) {
      add('Models', 'warn', error.message);
    }
  }

  try {
    const store = openLocalStore(paths.db);
    store.listChats({ limit: 1 });
    store.close();
    add('Local database', 'ok', paths.db);
  } catch (error) {
    add('Local database', 'fail', error.message);
  }

  const skills = loadSkills({ cwd: process.cwd() });
  add('Skills', 'ok', skills.length ? `${skills.length} installed (${paths.skills})` : `none yet · example in ${path.join(paths.skills, 'example', 'SKILL.md')}`);
  const plugins = await loadPlugins({ cwd: process.cwd(), config });
  add('Plugins', plugins.plugins.length ? 'ok' : 'warn', plugins.plugins.length ? plugins.plugins.map((plugin) => plugin.name).join(', ') : 'none installed');
  const mcp = loadMcpConfig({ cwd: process.cwd(), config });
  const mcpEnabled = Object.entries(mcp).filter(([, raw]) => raw == null || typeof raw !== 'object' || raw.enabled !== false);
  add('MCP servers', mcpEnabled.length ? 'ok' : 'warn', mcpEnabled.length ? `${mcpEnabled.length} configured (${path.join(paths.home, 'mcp.json')})` : `none configured · run gst mcp discover`);
  add('Computer use', config.computerUse ? (fs.existsSync(COMPUTER_HELPER_PATH) ? 'ok' : 'warn') : 'warn', config.computerUse ? 'enabled' : 'off (run /computer on in the TUI)');

  let failures = 0;
  let warnings = 0;
  const lines = [];
  for (const check of checks) {
    const symbol = check.status === 'ok' ? s.fg('success', GLYPHS.checked) : check.status === 'warn' ? s.fg('warning', '!') : s.fg('danger', GLYPHS.failed);
    if (check.status === 'fail') failures += 1;
    if (check.status === 'warn') warnings += 1;
    lines.push(`${symbol} ${s.fg('text', check.name.padEnd(15))} ${s.fg('muted', check.detail)}`);
  }
  const summary = failures
    ? s.fg('danger', `${failures} check${failures === 1 ? '' : 's'} failed.`)
    : warnings
      ? s.fg('success', `Everything looks good (${warnings} optional notice${warnings === 1 ? '' : 's'}).`)
      : s.fg('success', 'Everything looks good.');

  if (stdout.isTTY) {
    printHeader('GATITA DOCTOR', `v${CLIENT_VERSION}`, config.theme);
    console.log();
    const box = roundedBox({
      width: cliWidth(78),
      styler: s,
      title: 'diagnostics',
      borderColor: failures ? 'danger' : 'border',
      titleColor: failures ? 'danger' : 'accent',
      lines: [...lines, '', summary],
    });
    for (const line of box) console.log(`  ${line}`);
    console.log();
  } else {
    for (const line of lines) console.log(line);
    console.log('');
    console.log(summary);
  }
  if (failures) process.exitCode = 1;
}

export function printHelp({ includeServe = false } = {}) {
  const s = activeStyler('dark');
  const rows = [
    [s.bold(s.fg('accent', 'SESSION')), ''],
    ['gst / gatita-studio', 'start the full-screen coding agent'],
    ['gst login [--key]', 'interactive sign in (account or API key)'],
    ['gst logout', 'remove the saved session'],
    ['gst models', 'list available Gatita models'],
    ['gst usage', 'show token quota and 30-day usage'],
    ['', ''],
    [s.bold(s.fg('accent', 'WORKSPACE & TOOLS')), ''],
    ['gst mcp', 'list connected MCP servers'],
    ['gst mcp discover', 'probe localhost for running MCP servers'],
    ['gst mcp add <name>', 'add an MCP server (--url or --command)'],
    ['gst mcp remove <name>', 'remove a configured MCP server'],
    ['gst skills', 'list installed skills'],
    ['', ''],
    [s.bold(s.fg('accent', 'SYSTEM')), ''],
    ['gst update', 'check for and install updates'],
    ['gst doctor', 'verify install, auth, and connection'],
    ...(includeServe ? [['gatita-studio serve', 'run the Gatita Studio server']] : []),
  ];

  if (stdout.isTTY) {
    printHeader('G A T I T A   S T U D I O', `v${CLIENT_VERSION}`, 'dark');
    console.log(`     ${s.fg('muted', 'Your terminal. Her territory.')}`);
    console.log();
    const lines = rows.map(([cmd, desc]) => {
      if (!cmd && !desc) return '';
      if (!desc) return cmd;
      return `  ${s.fg('text', padEndVisible(cmd, 24))} ${s.fg('muted', desc)}`;
    });
    const box = roundedBox({
      width: cliWidth(72),
      styler: s,
      title: 'commands',
      subtitle: 'aliases: gatita-studio · gst',
      footer: 'flags: --new (fresh chat) · --model <id> · --version · --help',
      borderColor: 'border',
      lines,
    });
    for (const line of box) console.log(`  ${line}`);
    console.log();
    return;
  }

  console.log(`${s.fg('accent', `${GLYPHS.cat} Gatita Studio v${CLIENT_VERSION}`)} ${s.fg('faint', 'Your terminal. Her territory.')}`);
  console.log('');
  console.log('Usage:');
  for (const [cmd, desc] of rows) {
    if (!cmd || !desc) continue;
    console.log(`  ${cmd.padEnd(28)} ${desc}`);
  }
}

export async function runUpdate() {
  const config = loadConfig();
  const s = activeStyler(config.theme);
  const state = await checkForUpdate({ force: true });
  const notice = formatUpdateNotice(state);
  if (!notice) {
    console.log(`${s.fg('success', GLYPHS.checked)} Gatita Studio is up to date (v${CLIENT_VERSION}).`);
    return;
  }
  console.log(notice.message);
  if (notice.size) console.log(s.fg('muted', `  size: ${notice.size}`));
  const answer = await ask('Download and install now? [Y/n]: ', 'y');
  if (answer.toLowerCase() === 'n') {
    console.log('Update cancelled.');
    return;
  }
  try {
    console.log(s.fg('muted', 'Downloading update…'));
    const buffer = await downloadUpdate({ tarballUrl: state.tarball });
    console.log(s.fg('muted', 'Installing…'));
    installTarball(buffer, { sha256: state.sha256 });
    console.log(s.fg('success', `${GLYPHS.checked} Gatita Studio updated. Please restart to use the new version.`));
  } catch (error) {
    console.error(s.fg('danger', `Update failed: ${error.message}`));
    process.exitCode = 1;
  }
}

export async function runCliCommand(command, rest = []) {
  if (command === 'login') return runLogin(rest);
  if (command === 'logout') return runLogout();
  if (command === 'models') return runModels();
  if (command === 'usage') return runUsage();
  if (command === 'update') return runUpdate();
  if (command === 'mcp') return runMcpCommand(rest);
  if (command === 'skills') return runSkillsCommand();
  printHelp();
}
