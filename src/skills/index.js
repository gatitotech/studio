import fs from 'node:fs';
import path from 'node:path';
import { ToolError } from '../tools/errors.js';
import { studioHome } from '../cli/paths.js';

const MAX_SKILL_BYTES = 200 * 1024;

function parseFrontmatter(text) {
  const source = String(text || '');
  if (!source.startsWith('---')) return { meta: {}, body: source };
  const end = source.indexOf('\n---', 3);
  if (end === -1) return { meta: {}, body: source };
  const header = source.slice(3, end).trim();
  const body = source.slice(end + 4).replace(/^\r?\n/, '');
  const meta = {};
  for (const line of header.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (match) meta[match[1].toLowerCase()] = match[2].replace(/^["']|["']$/g, '').trim();
  }
  return { meta, body };
}

function readSkillFile(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_SKILL_BYTES) return null;
    const text = fs.readFileSync(file, 'utf8');
    const { meta, body } = parseFrontmatter(text);
    const fallbackName = path.basename(path.dirname(file)) === path.basename(file, path.extname(file))
      ? path.basename(file, path.extname(file))
      : path.basename(path.dirname(file));
    const name = String(meta.name || fallbackName).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 64);
    if (!name) return null;
    return {
      name,
      description: String(meta.description || body.split(/\r?\n/).find((line) => line.trim()) || '').trim().slice(0, 300),
      content: body.trim(),
      path: file,
      source: meta.source || '',
    };
  } catch {
    return null;
  }
}

function scanDirectory(dir, skills, source) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const candidate of ['SKILL.md', 'skill.md', 'README.md']) {
        const file = path.join(full, candidate);
        if (fs.existsSync(file)) {
          const skill = readSkillFile(file);
          if (skill) skills.set(skill.name, { ...skill, source });
          break;
        }
      }
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      const skill = readSkillFile(full);
      if (skill) skills.set(skill.name, { ...skill, source });
    }
  }
}

export function loadSkills({ cwd = process.cwd() } = {}) {
  const skills = new Map();
  scanDirectory(path.join(studioHome(), 'skills'), skills, 'global');
  scanDirectory(path.join(cwd, '.gatita', 'skills'), skills, 'project');
  scanDirectory(path.join(cwd, '.gatita-studio', 'skills'), skills, 'project');
  return [...skills.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function skillSuggestions(input, skills) {
  const match = /(?:^|\s)@([a-z0-9._-]*)$/i.exec(String(input || ''));
  if (!match) return [];
  const term = match[1].toLowerCase();
  const list = (Array.isArray(skills) ? skills : [])
    .filter((skill) => skill.name.startsWith(term) || skill.name.includes(term) || term === '')
    .sort((left, right) => {
      const leftStarts = left.name.startsWith(term) ? 0 : 1;
      const rightStarts = right.name.startsWith(term) ? 0 : 1;
      if (leftStarts !== rightStarts) return leftStarts - rightStarts;
      return left.name.localeCompare(right.name);
    });
  return list;
}

export function extractSkillMentions(text, skills) {
  const source = String(text || '');
  const list = Array.isArray(skills) ? skills : [];
  const mentions = [];
  const seen = new Set();
  const pattern = /(^|\s)@([a-z0-9._-]{2,64})/gi;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const name = match[2].toLowerCase();
    if (seen.has(name)) continue;
    const skill = list.find((entry) => entry.name === name);
    if (skill) {
      seen.add(name);
      mentions.push(skill);
    }
  }
  return mentions;
}

export function createSkillTool({ skills }) {
  return {
    name: 'skill',
    group: 'read',
    description: 'Load a skill: specialized instructions for a task. Call with no name to list available skills.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name. Omit to list skills.' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      const name = String(args.name || '').trim().toLowerCase();
      if (!name) {
        if (!skills.length) return { title: 'Skills', output: 'No skills are installed. Add one under ~/.gatita-studio/skills/<name>/SKILL.md.' };
        return {
          title: `${skills.length} skills`,
          output: skills.map((skill) => `- ${skill.name}: ${skill.description || 'No description.'} (${skill.source})`).join('\n'),
        };
      }
      const skill = skills.find((entry) => entry.name === name);
      if (!skill) {
        throw new ToolError('skill_not_found', `No skill named ${name}. Use skill with no arguments to list them.`);
      }
      return {
        title: `Loaded skill ${skill.name}`,
        output: `# Skill: ${skill.name}\n\n${skill.content}`,
        meta: { path: skill.path, source: skill.source },
      };
    },
  };
}

export function skillsPrompt(skills) {
  if (!skills.length) return '';
  const lines = skills.slice(0, 40).map((skill) => `- ${skill.name}: ${skill.description || 'No description.'}`);
  return `\n\nAvailable skills. Load one with the skill tool when the task matches:\n${lines.join('\n')}`;
}
