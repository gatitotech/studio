import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CLIENT_VERSION, DEFAULT_SERVER_URL, USER_AGENT } from '../shared/protocol.js';
import { filePaths, readJsonFile, writeJsonFile } from './paths.js';
import { formatBytes } from '../shared/util.js';

const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const MAX_UPDATE_BYTES = 100 * 1024 * 1024;

export const MANIFEST_URL = `${DEFAULT_SERVER_URL}/install/manifest.json`;
export const DOWNLOAD_URL = `${DEFAULT_SERVER_URL}/download/gatita-studio-latest.tgz`;

export function updateStatePath() {
  return path.join(filePaths().home, 'update-state.json');
}

export function readUpdateState() {
  return readJsonFile(updateStatePath(), {}) || {};
}

export function writeUpdateState(state) {
  writeJsonFile(updateStatePath(), state);
}

export function compareVersions(left, right) {
  const parse = (value) => String(value || '')
    .trim()
    .replace(/^v/i, '')
    .split(/[.+-]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function normalizeSha256(value) {
  const text = String(value || '').trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(text) ? text : null;
}

export function resolveDownloadUrl(value) {
  const fallback = DOWNLOAD_URL;
  if (!value) return fallback;
  try {
    const url = new URL(String(value), `${DEFAULT_SERVER_URL}/download/`);
    const base = new URL(DEFAULT_SERVER_URL);
    if (url.origin !== base.origin) return fallback;
    if (!url.href.startsWith(`${DEFAULT_SERVER_URL}/`)) return fallback;
    if (url.protocol !== 'https:') return fallback;
    return url.href;
  } catch {
    return fallback;
  }
}

async function fetchJson(url, { timeoutMs = 10_000 } = {}) {
  if (!String(url).startsWith('https://')) {
    throw new Error('Update checks must use HTTPS.');
  }
  const response = await fetch(url, {
    headers: { 'user-agent': USER_AGENT },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`manifest request failed with status ${response.status}`);
  }
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('manifest response was not valid JSON');
  }
}

export async function checkForUpdate({ force = false } = {}) {
  const state = readUpdateState();
  const now = Date.now();
  const lastCheck = Number(state.lastCheckAt || 0);
  if (!force && lastCheck && now - lastCheck < UPDATE_CHECK_INTERVAL_MS) {
    return { ...state, checked: false };
  }

  let latest;
  try {
    latest = await fetchJson(MANIFEST_URL);
  } catch (error) {
    const message = String(error?.message || error);
    writeUpdateState({ ...state, lastCheckAt: now, error: message });
    return { ...state, checked: false, error: message };
  }

  const version = String(latest?.version || '').trim();
  const outOfDate = Boolean(version) && compareVersions(version, CLIENT_VERSION) > 0;
  const nextState = {
    ...state,
    lastCheckAt: now,
    checked: true,
    latestVersion: version,
    outOfDate,
    tarball: resolveDownloadUrl(latest?.download || latest?.tarball),
    sha256: normalizeSha256(latest?.sha256),
    size: Number(latest?.size) || null,
    error: null,
  };
  writeUpdateState(nextState);
  return nextState;
}

export function isOutOfDate(state) {
  return Boolean(state?.outOfDate && state?.latestVersion && compareVersions(state.latestVersion, CLIENT_VERSION) > 0);
}

export function formatUpdateNotice(state) {
  if (!isOutOfDate(state)) return null;
  return {
    current: CLIENT_VERSION,
    latest: state.latestVersion,
    message: `Gatita Studio ${state.latestVersion} is available (you have ${CLIENT_VERSION}). Run /update or gatita-studio update to upgrade.`,
    size: state.size ? formatBytes(state.size) : null,
  };
}

export async function downloadUpdate({ tarballUrl, onProgress, timeoutMs = 60_000 } = {}) {
  if (!tarballUrl) throw new Error('No update tarball URL available.');
  if (!String(tarballUrl).startsWith('https://')) {
    throw new Error('Update downloads must use HTTPS.');
  }
  const response = await fetch(tarballUrl, {
    headers: { 'user-agent': USER_AGENT },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`download failed with status ${response.status}`);
  }
  const total = Number(response.headers.get('content-length') || 0);
  if (total > MAX_UPDATE_BYTES) {
    throw new Error('The update download is larger than expected.');
  }
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    onProgress?.({ received: buffer.length, total });
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_UPDATE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error('The update download is larger than expected.');
    }
    chunks.push(Buffer.from(value));
    onProgress?.({ received, total });
  }
  return Buffer.concat(chunks);
}

export function verifyTarball(buffer, expectedSha256) {
  const expected = normalizeSha256(expectedSha256);
  if (!expected) {
    throw new Error('The update manifest did not include a valid SHA-256 checksum.');
  }
  const actual = crypto.createHash('sha256').update(buffer).digest('hex');
  if (actual !== expected) {
    throw new Error(`Checksum mismatch (expected ${expected}, got ${actual}). Update aborted.`);
  }
  return actual;
}

function npmCliCandidates() {
  const binDir = path.dirname(process.execPath);
  return [
    process.env.npm_execpath,
    path.join(binDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(binDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    '/usr/lib/node_modules/npm/bin/npm-cli.js',
    '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
  ].filter(Boolean);
}

function npmInvocation(tarballPath) {
  for (const candidate of npmCliCandidates()) {
    if (fs.existsSync(candidate)) {
      return {
        file: process.execPath,
        args: [candidate, 'install', '-g', tarballPath],
        shell: false,
      };
    }
  }
  return {
    file: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    args: ['install', '-g', tarballPath],
    shell: process.platform === 'win32',
  };
}

export function installTarball(buffer, { sha256 } = {}) {
  verifyTarball(buffer, sha256);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatita-update-'));
  const tarballPath = path.join(tmpDir, 'gatita-studio.tgz');
  fs.writeFileSync(tarballPath, buffer);

  try {
    const invocation = npmInvocation(tarballPath);
    const output = execFileSync(invocation.file, invocation.args, {
      encoding: 'utf8',
      shell: invocation.shell,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, output: String(output || '').trim() };
  } catch (error) {
    const detail = String(error?.stderr || error?.stdout || error?.message || 'npm install failed.').trim();
    throw new Error(`npm install failed: ${detail.slice(0, 1000)}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
