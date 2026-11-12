import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadConfig, saveConfig } from './config.js';
import { authToken, clearStoredAuth, getStoredAuth, maskToken, saveStoredAuth } from './authStore.js';
import { createApiClient, ApiError } from './api.js';
import { openLocalStore } from './store.js';
import { loadSkills } from '../skills/index.js';
import { loadPlugins } from '../plugins/index.js';
import { loadMcpConfig, createMcpManager } from '../mcp/index.js';
import { discoverMcpServers } from '../mcp/discover.js';
import { filePaths } from './paths.js';
import { createStyler } from './theme.js';
import { COMPUTER_HELPER_PATH } from '../computer/index.js';
import { roundedBox } from './tui/render.js';
import { formatDuration, formatTokens, formatDateTime, plural } from '../shared/util.js';
import { CLIENT_VERSION } from '../shared/protocol.js';
import { checkForUpdate, downloadUpdate, installTarball, isOutOfDate, formatUpdateNotice } from './update.js';

const styler = createStyler('dark');
const GLYPH_CAT = 'ᓚᘏᗢ';

function color(hex, text) {
  return stdout.isTTY ? styler.fg(hex, text) : String(text);
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
          // Drop arrow keys and other escape sequences instead of typing them.
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
    // Attach the handler before enabling raw mode so keys typed while the
    // sign-in banner was still printing are delivered instead of waiting
    // for another Enter.
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
    console.log(color('accent', `${'ᓚᘏᗢ'} Gatita Studio`));
    console.log(color('muted', 'Sign in with your Gatita account.'));
    console.log(color('faint', `server: ${config.serverUrl}`));
    return;
  }
  const styler = createStyler('dark', { enabled: true });
  const width = Math.max(34, Math.min(54, stdout.columns || 54));
  console.log();
  console.log(`${styler.fg('accent', GLYPH_CAT)}  ${styler.bold(styler.fg('text', 'GATITA STUDIO'))}`);
  console.log(styler.fg('muted', '  Your terminal. Her territory.'));
  console.log();
  const box = roundedBox({
    width,
    styler,
    title: 'sign in',
    padding: 1,
    background: 'surface',
    borderColor: 'accent',
    lines: [
      styler.fg('text', 'Welcome back.'),
      '',
      `${styler.fg('faint', 'server')}  ${styler.fg('muted', config.serverUrl)}`,
      `${styler.fg('faint', 'models')}  ${styler.fg('muted', 'Gatita Fast · Gatita Max · Gatita Aura')}`,
      `${styler.fg('faint', 'session')} ${styler.fg('muted', 'saved to this machine')}`,
    ],
  });
  for (const line of box) console.log(`  ${line}`);
  console.log();
}

export async function ensureLogin({ config = loadConfig(), force = false } = {}) {
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

  printSignInBanner(config);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const email = await ask('Email: ');
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

  if (command === 'discover') {
    console.log(color('muted', 'Probing localhost for MCP servers…'));
    const found = await discoverMcpServers({});
    if (!found.http.length && !found.processes.length) {
      console.log('No running MCP servers found on localhost.');
      console.log(color('muted', 'Start one (for example with npx -y @modelcontextprotocol/server-filesystem .) and run this again.'));
      return;
    }
    for (const hit of found.http) {
      const label = hit.serverName ? `${hit.serverName}${hit.serverVersion ? ` ${hit.serverVersion}` : ''}` : 'unknown server';
      console.log(`  ${color('success', '●')} ${hit.url} ${color('muted', `— ${label}`)}`);
    }
    for (const proc of found.processes) {
      console.log(`  ${color('info', '◇')} pid ${proc.pid} ${color('faint', proc.commandLine)}`);
    }
    console.log('');
    console.log(color('muted', 'Attach one with:'));
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
      console.log(color('success', `Connected to ${result.name}: ${result.tools.length} tool(s).`));
      for (const tool of result.tools) console.log(`    ${color('faint', tool)}`);
      if (result.file) console.log(color('muted', `Saved to ${result.file}.`));
      if (result.warning) console.log(color('warning', result.warning));
    } catch (error) {
      console.error(color('danger', error?.message || String(error)));
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
      console.log(color('success', `Removed ${result.name}.`));
      if (result.removedFrom.length) console.log(color('muted', `Was in: ${result.removedFrom.join(', ')}`));
      else console.log(color('muted', 'It was not configured anywhere.'));
    } catch (error) {
      console.error(color('danger', error?.message || String(error)));
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
    if (!status.servers.length && !status.errors.length) {
      console.log('No MCP servers configured.');
      console.log(color('muted', `Add one with "gst mcp add <name> --url <url>" or edit ${path.join(paths.home, 'mcp.json')} (a premade example ships with it).`));
      console.log(color('muted', 'Tip: "gst mcp discover" probes this machine for running servers.'));
      return;
    }
    for (const server of status.servers) {
      console.log(`  ${color('success', '●')} ${server.name} ${color('muted', `${server.tools} tool(s)${server.version ? ` · ${server.version}` : ''}`)}`);
      for (const tool of server.toolNames || []) console.log(`    ${color('faint', tool)}`);
    }
    for (const error of status.errors) {
      console.log(`  ${color('danger', '✗')} ${error.server} ${color('faint', error.message)}`);
    }
    console.log(color('muted', 'Tools appear in the app as mcp__<server>__<tool> and ask for approval.'));
  } finally {
    manager.closeAll();
  }
}

export async function runSkillsCommand() {
  const skills = loadSkills({ cwd: process.cwd() });
  const home = filePaths().home;
  if (!skills.length) {
    console.log('No skills installed.');
    console.log(color('muted', `Global skills live in ${path.join(home, 'skills')} — a premade example is there already.`));
    console.log(color('muted', 'Copy ~/.gatita-studio/skills/example to a new folder and edit SKILL.md.'));
    return;
  }
  console.log(`${color('accent', 'Skills')} ${color('faint', `· global folder: ${path.join(home, 'skills')}`)}`);
  for (const skill of skills) {
    console.log(`  ${color('accent', skill.name)} ${color('faint', `(${skill.source})`)}`);
    if (skill.description) console.log(`    ${color('muted', skill.description)}`);
  }
  console.log('');
  console.log(color('muted', 'Mention a skill with @name in the composer, or ask gatita to use it.'));
}

export async function runLogin() {
  const config = loadConfig();
  const { me } = await ensureLogin({ config, force: true });
  console.log(color('muted', `Server: ${config.serverUrl}`));
  console.log(color('muted', `Session saved to ${filePaths().auth}`));
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
  const token = authToken(config.serverUrl);
  const client = token ? createApiClient({ serverUrl: config.serverUrl, token }) : null;
  // Drop the local session first. The server call is only cleanup; it should
  // never keep someone waiting to get their terminal back.
  clearStoredAuth(config.serverUrl);
  console.log('Signed out.');
  await bestEffortLogout(client);
}

export async function runModels() {
  const config = loadConfig();
  const { client, me } = await ensureLogin({ config });
  const payload = await client.models();
  const plan = payload.plan?.displayName || me?.plan?.displayName || 'Free';
  console.log(`${color('accent', 'Gatita models')} ${color('faint', `· ${plan}`)}`);
  for (const model of payload.data) {
    const badges = [
      model.available ? '' : color('warning', `locked (${model.requiredPlan})`),
      model.tools ? color('muted', 'tools') : color('faint', 'chat'),
      model.vision ? color('info', 'vision') : '',
      model.reasoningLevels.length ? color('accent2', `reasoning: ${model.reasoningLevels.join('/')}`) : '',
      model.default ? color('success', 'default') : '',
    ].filter(Boolean).join('  ');
    const context = `${formatTokens(model.contextWindow)} ctx`;
    console.log(`  ${model.id === config.defaultModel ? color('accent', '›') : ' '} ${color('text', model.name.padEnd(18))} ${color('faint', context.padEnd(12))} ${badges}`);
    console.log(`    ${color('muted', model.description)}`);
  }
}

export async function runUsage() {
  const config = loadConfig();
  const { client } = await ensureLogin({ config });
  const report = await client.usage(30);
  console.log(`${color('accent', 'Usage')} ${color('faint', `· ${report.plan?.displayName || 'Free'}`)}`);
  for (const window of report.windows || []) {
    const width = 24;
    const filled = Math.round((window.percent / 100) * width);
    const bar = `${color('accent', '█'.repeat(filled))}${color('faint', '░'.repeat(width - filled))}`;
    const reset = window.resetAt ? `resets in ${formatDuration(Math.max(0, window.resetAt - Date.now()), { compact: true })}` : 'no reset scheduled';
    console.log(`  ${window.label.padEnd(8)} ${bar} ${formatTokens(window.used)} / ${formatTokens(window.limit)}  ${color('muted', reset)}`);
  }
  console.log(`  ${color('muted', `Last 30 days: ${formatTokens(report.totals.tokens)} tokens across ${plural(report.totals.requests, 'request')}.`)}`);
  for (const model of (report.models || []).slice(0, 8)) {
    console.log(`    ${color('muted', model.modelId.padEnd(18))} ${formatTokens(model.tokens).padStart(8)}  ${plural(model.requests, 'request')}`);
  }
}

export async function runDoctorCommand({ config: providedConfig } = {}) {
  const config = providedConfig || loadConfig();
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });
  add('Node', process.versions.node.split('.')[0] >= 24 ? 'ok' : 'fail', `v${process.versions.node} (need 24 or newer)`);
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
      add('Models', 'ok', `${models.data.length} public models, default ${models.defaultModel}`);
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
  add('Skills', 'ok', skills.length ? `${skills.length} installed (global: ${path.join(paths.skills)})` : `none yet · premade example in ${path.join(paths.skills, 'example', 'SKILL.md')}`);
  const plugins = await loadPlugins({ cwd: process.cwd(), config });
  add('Plugins', plugins.plugins.length ? 'ok' : 'warn', plugins.plugins.length ? plugins.plugins.map((plugin) => plugin.name).join(', ') : 'none installed');
  const mcp = loadMcpConfig({ cwd: process.cwd(), config });
  const mcpEnabled = Object.entries(mcp).filter(([, raw]) => raw == null || typeof raw !== 'object' || raw.enabled !== false);
  add('MCP servers', mcpEnabled.length ? 'ok' : 'warn', mcpEnabled.length ? `${mcpEnabled.length} configured (global: ${path.join(paths.home, 'mcp.json')})` : `none configured · gst mcp discover to find running ones · ${path.join(paths.home, 'mcp.json')} has a premade example`);
  add('Computer use', config.computerUse ? (fs.existsSync(COMPUTER_HELPER_PATH) ? 'ok' : 'warn') : 'warn', config.computerUse ? 'enabled' : 'off (run /computer on in the TUI)');

  let failures = 0;
  for (const check of checks) {
    const symbol = check.status === 'ok' ? color('success', '✓') : check.status === 'warn' ? color('warning', '!') : color('danger', '✗');
    if (check.status === 'fail') failures += 1;
    console.log(`${symbol} ${check.name.padEnd(16)} ${color('muted', check.detail)}`);
  }
  console.log('');
  console.log(failures ? color('danger', `${failures} check${failures === 1 ? '' : 's'} failed.`) : color('success', 'Everything looks good.'));
  if (failures) process.exitCode = 1;
}

export function printHelp() {
  console.log(`${color('accent', 'ᓚᘏᗢ Gatita Studio')} ${color('faint', 'Your terminal. Her territory.')}`);
  console.log('');
  console.log('Usage:');
  console.log(`  ${color('text', 'gatita-studio')} ${color('muted', '                 start the full-screen coding agent')}`);
  console.log(`  ${color('text', 'gatita-studio login')} ${color('muted', '           sign in with a Gatita account')}`);
  console.log(`  ${color('text', 'gatita-studio logout')} ${color('muted', '          remove the saved session')}`);
  console.log(`  ${color('text', 'gatita-studio models')} ${color('muted', '          list Gatita models')}`);
  console.log(`  ${color('text', 'gatita-studio usage')} ${color('muted', '           show token usage')}`);
  console.log(`  ${color('text', 'gatita-studio mcp')} ${color('muted', '              list MCP servers')}`);
  console.log(`  ${color('text', 'gatita-studio mcp discover')} ${color('muted', '    probe localhost for running MCP servers')}`);
  console.log(`  ${color('text', 'gatita-studio mcp add <name>')} ${color('muted', '   add an MCP server (--url or --command)')}`);
  console.log(`  ${color('text', 'gatita-studio mcp remove <name>')} ${color('muted', '  remove an MCP server')}`);
  console.log(`  ${color('text', 'gatita-studio skills')} ${color('muted', '           list installed skills')}`);
  console.log(`  ${color('text', 'gatita-studio update')} ${color('muted', '          check for and install updates')}`);
  console.log(`  ${color('text', 'gatita-studio doctor')} ${color('muted', '          check the install')}`);
}

export async function runUpdate() {
  const state = await checkForUpdate({ force: true });
  const notice = formatUpdateNotice(state);
  if (!notice) {
    console.log(`Gatita Studio is up to date (${CLIENT_VERSION}).`);
    return;
  }
  console.log(notice.message);
  if (notice.size) console.log(`  size: ${notice.size}`);
  const answer = await ask('Download and install now? [Y/n]: ', 'y');
  if (answer.toLowerCase() === 'n') {
    console.log('Update cancelled.');
    return;
  }
  try {
    console.log('Downloading update…');
    const buffer = await downloadUpdate({ tarballUrl: state.tarball });
    console.log('Installing…');
    installTarball(buffer, { sha256: state.sha256 });
    console.log('Gatita Studio updated. Please restart to use the new version.');
  } catch (error) {
    console.error(color('danger', `Update failed: ${error.message}`));
    process.exitCode = 1;
  }
}

export async function runCliCommand(command, rest = []) {
  if (command === 'login') return runLogin();
  if (command === 'logout') return runLogout();
  if (command === 'models') return runModels();
  if (command === 'usage') return runUsage();
  if (command === 'update') return runUpdate();
  if (command === 'mcp') return runMcpCommand(rest);
  if (command === 'skills') return runSkillsCommand();
  printHelp();
}
