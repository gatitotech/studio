import { DEFAULT_SERVER_URL } from '../shared/protocol.js';
import { parseBoolean } from '../shared/util.js';
import { filePaths, readJsonFile, writeJsonFile } from './paths.js';

export const CONFIG_DEFAULTS = {
  serverUrl: DEFAULT_SERVER_URL,
  defaultModel: 'gatita-fast',
  reasoning: 'off',
  theme: 'dark',
  animations: true,
  sounds: true,
  soundFile: '',
  showReasoning: false,
  showWork: false,
  mode: 'build',
  autoApprove: {
    read: true,
    search: true,
    todo: true,
    edit: false,
    write: false,
    shell: false,
    web: true,
    computer: false,
  },
  computerUse: false,
  maxSteps: 40,
  // 0 lets shell tools run until they finish or the user stops them.
  shellTimeoutMs: 0,
  mcp: {},
  plugins: true,
  lastFolderId: null,
  lastChatId: null,
};

function mergeDeep(base, extra) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return base;
  const output = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      output[key] = mergeDeep(base[key], value);
    } else if (value !== undefined) {
      output[key] = value;
    }
  }
  return output;
}

export function loadConfig() {
  const paths = filePaths();
  const file = readJsonFile(paths.config, {});
  const config = mergeDeep(CONFIG_DEFAULTS, file || {});
  if (process.env.GATITA_STUDIO_MODEL) config.defaultModel = String(process.env.GATITA_STUDIO_MODEL).trim();
  if (process.env.GATITA_NO_ANIMATION) config.animations = !parseBoolean(process.env.GATITA_NO_ANIMATION, false);
  // The endpoint is part of the product, not a preference. Ignore old config
  // files and environment variables that tried to point somewhere else.
  config.serverUrl = DEFAULT_SERVER_URL;
  config.paths = paths;
  return config;
}

export function saveConfig(config) {
  const paths = filePaths();
  const { paths: _paths, serverUrl: _serverUrl, ...persisted } = config;
  writeJsonFile(paths.config, persisted);
  return config;
}

export function updateConfig(patch) {
  const config = mergeDeep(loadConfig(), patch);
  return saveConfig(config);
}

export function loadTheme(themeName) {
  return themeName === 'paper' ? 'paper' : 'dark';
}
