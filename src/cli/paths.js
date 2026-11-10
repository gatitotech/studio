import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { safeJsonParse } from '../shared/util.js';

export function studioHome() {
  const override = String(process.env.GATITA_STUDIO_HOME || '').trim();
  if (override) return path.resolve(override.replace(/^~(?=$|[\\/])/, os.homedir()));
  return path.join(os.homedir(), '.gatita-studio');
}

const EXAMPLE_MCP_JSON = {
  mcpServers: {
    'example-filesystem': {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
      enabled: false,
    },
    'example-remote': {
      type: 'http',
      url: 'https://mcp.example.com/mcp',
      enabled: false,
    },
  },
};

const EXAMPLE_SKILL = `---
name: example
description: How skills work in Gatita Studio. Copy this folder to make your own.
---

This folder is a premade example so setting up a skill is mostly copy and paste.

To make your own skill:

1. Copy this folder to a new name, for example ~/.gatita-studio/skills/deploy
2. Edit the SKILL.md file. The frontmatter needs a name and a one-line description.
3. Write whatever instructions should kick in when the skill is used.
4. Type @ in the composer and pick your skill, or just tell Gatita to use it.

Tips:

- Skills live globally in ~/.gatita-studio/skills (they work in every project).
  A project can also override or add skills in <project>/.gatita/skills.
- Keep the body focused: what to do, what to avoid, and when it applies.
- The name in the frontmatter is what you mention with @name.
`;

function writeIfMissing(file, content) {
  try {
    if (fs.existsSync(file)) return;
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, content, { mode: 0o600 });
  } catch {
    // Premade examples are a convenience, never a reason to fail startup.
  }
}

export function ensureHome() {
  const home = studioHome();
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  // Premade files so adding MCP servers and skills is copy-and-paste, not archaeology.
  writeIfMissing(path.join(home, 'mcp.json'), `${JSON.stringify(EXAMPLE_MCP_JSON, null, 2)}\n`);
  writeIfMissing(path.join(home, 'skills', 'example', 'SKILL.md'), EXAMPLE_SKILL);
  return home;
}

export function filePaths() {
  const home = ensureHome();
  return {
    home,
    config: path.join(home, 'config.json'),
    auth: path.join(home, 'auth.json'),
    db: path.join(home, 'studio.db'),
    history: path.join(home, 'history'),
    skills: path.join(home, 'skills'),
    plugins: path.join(home, 'plugins'),
    logs: path.join(home, 'logs'),
    lock: path.join(home, 'studio.lock'),
  };
}

export function readJsonFile(file, fallback = null) {
  try {
    return safeJsonParse(fs.readFileSync(file, 'utf8'), fallback) ?? fallback;
  } catch {
    return fallback;
  }
}

export function writeJsonFile(file, value, { mode = 0o600 } = {}) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.renameSync(temp, file);
  try {
    fs.chmodSync(file, mode);
  } catch {
    // Windows does not apply POSIX modes; the file still lives in the user profile.
  }
}

export default {
  studioHome,
  ensureHome,
  filePaths,
  readJsonFile,
  writeJsonFile,
};
