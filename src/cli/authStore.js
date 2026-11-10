import { filePaths, readJsonFile, writeJsonFile } from './paths.js';

const EMPTY = { version: 1, servers: {} };

export function readAuthFile() {
  const data = readJsonFile(filePaths().auth, null);
  if (!data || typeof data !== 'object' || !data.servers || typeof data.servers !== 'object') return { ...EMPTY };
  return { version: 1, servers: { ...data.servers } };
}

export function getStoredAuth(serverUrl) {
  if (process.env.GATITA_STUDIO_TOKEN) {
    return { token: String(process.env.GATITA_STUDIO_TOKEN).trim(), source: 'env' };
  }
  const file = readAuthFile();
  const entry = file.servers[String(serverUrl)] || null;
  if (!entry?.token) return null;
  if (entry.expiresAt && Number(entry.expiresAt) <= Date.now()) return null;
  return { ...entry, source: 'file' };
}

export function saveStoredAuth(serverUrl, entry) {
  const file = readAuthFile();
  file.servers[String(serverUrl)] = {
    ...entry,
    savedAt: Date.now(),
  };
  writeJsonFile(filePaths().auth, file);
}

export function clearStoredAuth(serverUrl) {
  const file = readAuthFile();
  if (serverUrl) delete file.servers[String(serverUrl)];
  else file.servers = {};
  writeJsonFile(filePaths().auth, file);
}

export function listStoredServers() {
  return Object.keys(readAuthFile().servers);
}

export function authToken(serverUrl) {
  return getStoredAuth(serverUrl)?.token || '';
}

export function maskToken(token) {
  const text = String(token || '');
  if (text.length <= 12) return text ? '***' : '';
  return `${text.slice(0, 7)}…${text.slice(-4)}`;
}
