import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ToolError } from './errors.js';

const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_READ_LINES = 2000;
const MAX_OUTPUT_CHARS = 120_000;
const DEFAULT_IGNORES = new Set(['node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'coverage', '.next', '.cache', '.venv', 'venv', '__pycache__']);

const SENSITIVE_PATTERNS = [
  /[\\/]\.gatita-studio[\\/]auth\.json$/i,
  /[\\/]\.ssh[\\/](id_[^\\/]+|known_hosts)$/i,
  /[\\/]\.aws[\\/]credentials$/i,
  /[\\/]\.config[\\/]gcloud[\\/]credentials/i,
  /[\\/]AppData[\\/]Roaming[\\/]Microsoft[\\/]Credentials/i,
];

export function expandHome(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return text.replace(/^~(?=$|[\\/])/, os.homedir());
}

export function resolvePath(input, cwd) {
  const text = expandHome(input);
  if (!text) return cwd;
  return path.resolve(cwd, text);
}

export function displayPath(absPath, cwd) {
  const relative = path.relative(cwd, absPath);
  if (!relative) return '.';
  if (relative.startsWith('..') || path.isAbsolute(relative)) return absPath;
  return relative.split(path.sep).join('/');
}

function assertAllowed(absPath) {
  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.test(absPath)) {
      throw new ToolError('blocked_path', 'That file holds credentials and cannot be accessed by the agent.');
    }
  }
}

function isBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  for (let index = 0; index < sample.length; index += 1) {
    if (sample[index] === 0) return true;
  }
  return false;
}

function statSafe(absPath) {
  try {
    return fs.statSync(absPath);
  } catch {
    return null;
  }
}

function clip(text, max = MAX_OUTPUT_CHARS) {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n… output truncated (${value.length - max} more characters)`;
}

function lineNumbered(text, offset = 1) {
  const lines = text.split('\n');
  return lines.map((line, index) => {
    const number = String(index + offset).padStart(6, ' ');
    const safe = line.length > 4000 ? `${line.slice(0, 4000)}…` : line;
    return `${number}| ${safe}`;
  }).join('\n');
}

export function createReadTool({ cwd, ctx }) {
  return {
    name: 'read',
    group: 'read',
    description: 'Read a text file. Returns line-numbered content. Use offset and limit for large files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to the workspace.' },
        offset: { type: 'integer', description: 'First line to read, 1-based.' },
        limit: { type: 'integer', description: 'Maximum lines to read.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    async execute(args) {
      const absPath = resolvePath(args.path, cwd);
      assertAllowed(absPath);
      const stat = statSafe(absPath);
      if (!stat) throw new ToolError('not_found', `File not found: ${displayPath(absPath, cwd)}`);
      if (stat.isDirectory()) throw new ToolError('is_directory', `${displayPath(absPath, cwd)} is a directory. Use ls.`);
      if (!stat.isFile()) throw new ToolError('not_file', 'That path is not a regular file.');
      if (stat.size > 20 * 1024 * 1024) throw new ToolError('too_large', 'That file is larger than 20 MB.');
      const buffer = fs.readFileSync(absPath);
      if (isBinary(buffer)) throw new ToolError('binary', 'That file looks binary and cannot be read as text.');
      const offset = Math.max(1, Number(args.offset) || 1);
      const limit = Math.max(1, Math.min(MAX_READ_LINES, Number(args.limit) || MAX_READ_LINES));
      const allLines = buffer.subarray(0, MAX_READ_BYTES).toString('utf8').split('\n');
      const total = allLines.length;
      const slice = allLines.slice(offset - 1, offset - 1 + limit);
      const suffix = offset - 1 + slice.length < total
        ? `\n… ${total - (offset - 1 + slice.length)} more lines (use offset ${offset + slice.length})`
        : '';
      const header = `${displayPath(absPath, cwd)} (${total} lines, ${stat.size} bytes)`;
      return {
        title: `Read ${displayPath(absPath, cwd)}`,
        output: `${header}\n${lineNumbered(slice.join('\n'), offset)}${suffix}`,
        meta: { path: absPath, lines: total, bytes: stat.size },
      };
    },
  };
}

export function createWriteTool({ cwd, ctx }) {
  return {
    name: 'write',
    group: 'write',
    description: 'Create or overwrite a file with new content. Parent directories are created.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to the workspace.' },
        content: { type: 'string', description: 'Full file content.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    async execute(args) {
      const absPath = resolvePath(args.path, cwd);
      assertAllowed(absPath);
      const content = String(args.content ?? '');
      if (Buffer.byteLength(content, 'utf8') > 10 * 1024 * 1024) {
        throw new ToolError('too_large', 'Refusing to write more than 10 MB in one call.');
      }
      const stat = statSafe(absPath);
      if (stat?.isDirectory()) throw new ToolError('is_directory', 'That path is a directory.');
      const existed = Boolean(stat?.isFile());
      if (existed && ctx?.store?.saveSnapshot && ctx?.chatId) {
        try {
          ctx.store.saveSnapshot(ctx.chatId, absPath, fs.readFileSync(absPath, 'utf8'));
        } catch {
          // Snapshot is best effort.
        }
      }
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, content, 'utf8');
      const lines = content ? content.split('\n').length : 0;
      return {
        title: `${existed ? 'Updated' : 'Created'} ${displayPath(absPath, cwd)}`,
        output: `${existed ? 'Overwrote' : 'Created'} ${displayPath(absPath, cwd)} (${lines} lines, ${Buffer.byteLength(content)} bytes).`,
        meta: { path: absPath, created: !existed, lines },
      };
    },
  };
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let index = 0;
  while ((index = haystack.indexOf(needle, index)) !== -1) {
    count += 1;
    index += needle.length;
  }
  return count;
}

export function createEditTool({ cwd, ctx }) {
  return {
    name: 'edit',
    group: 'edit',
    description: 'Replace an exact string in a file. oldString must match the file exactly. Use replaceAll for every occurrence.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to the workspace.' },
        oldString: { type: 'string', description: 'Exact text to replace.' },
        newString: { type: 'string', description: 'Replacement text.' },
        replaceAll: { type: 'boolean', description: 'Replace every occurrence.' },
      },
      required: ['path', 'oldString', 'newString'],
      additionalProperties: false,
    },
    async execute(args) {
      const absPath = resolvePath(args.path, cwd);
      assertAllowed(absPath);
      const stat = statSafe(absPath);
      if (!stat?.isFile()) throw new ToolError('not_found', `File not found: ${displayPath(absPath, cwd)}`);
      const oldString = String(args.oldString ?? '');
      const newString = String(args.newString ?? '');
      if (!oldString) throw new ToolError('bad_arguments', 'oldString cannot be empty. Use write for new files.');
      if (oldString === newString) throw new ToolError('bad_arguments', 'oldString and newString are identical.');
      const original = fs.readFileSync(absPath, 'utf8');
      const count = countOccurrences(original, oldString);
      if (count === 0) {
        throw new ToolError('no_match', 'oldString was not found. Read the file again and copy the exact text, including indentation.');
      }
      if (count > 1 && !args.replaceAll) {
        throw new ToolError('multiple_matches', `oldString matched ${count} times. Add more context or set replaceAll.`);
      }
      if (ctx?.store?.saveSnapshot && ctx?.chatId) {
        try {
          ctx.store.saveSnapshot(ctx.chatId, absPath, original);
        } catch {
          // Best effort.
        }
      }
      const updated = args.replaceAll ? original.split(oldString).join(newString) : original.replace(oldString, newString);
      fs.writeFileSync(absPath, updated, 'utf8');
      const oldLines = oldString.split('\n').length;
      const newLines = newString.split('\n').length;
      return {
        title: `Edited ${displayPath(absPath, cwd)}`,
        output: `Edited ${displayPath(absPath, cwd)} (${args.replaceAll ? count : 1} replacement${count === 1 ? '' : 's'}, ${newLines - oldLines >= 0 ? '+' : ''}${newLines - oldLines} lines).`,
        meta: { path: absPath, replacements: args.replaceAll ? count : 1 },
      };
    },
  };
}

export function createLsTool({ cwd }) {
  return {
    name: 'ls',
    group: 'read',
    description: 'List files and directories at a path.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path, relative to the workspace.' },
        all: { type: 'boolean', description: 'Include hidden entries.' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      const absPath = resolvePath(args.path || '.', cwd);
      const stat = statSafe(absPath);
      if (!stat) throw new ToolError('not_found', `Directory not found: ${displayPath(absPath, cwd)}`);
      const target = stat.isDirectory() ? absPath : path.dirname(absPath);
      let entries = fs.readdirSync(target, { withFileTypes: true });
      if (!args.all) entries = entries.filter((entry) => !entry.name.startsWith('.') || entry.name === '.env');
      entries.sort((left, right) => {
        if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1;
        return left.name.localeCompare(right.name);
      });
      const shown = entries.slice(0, 500);
      const lines = shown.map((entry) => {
        const full = path.join(target, entry.name);
        const info = statSafe(full);
        const size = entry.isDirectory() ? '-' : String(info?.size ?? 0);
        return `${entry.isDirectory() ? 'dir ' : 'file'} ${entry.name}${entry.isDirectory() ? '/' : ''} ${size}`;
      });
      if (entries.length > shown.length) lines.push(`… ${entries.length - shown.length} more entries`);
      return {
        title: `Listed ${displayPath(target, cwd)}`,
        output: `${displayPath(target, cwd)}/\n${lines.join('\n') || '(empty)'}`,
        meta: { path: target, entries: entries.length },
      };
    },
  };
}

function globBase(cwd, input) {
  const abs = resolvePath(input || '.', cwd);
  const stat = statSafe(abs);
  if (stat?.isFile()) return { base: path.dirname(abs), pattern: path.basename(abs) };
  return { base: abs, pattern: '' };
}

export function createGlobTool({ cwd }) {
  return {
    name: 'glob',
    group: 'search',
    description: 'Find files matching a glob pattern, for example **/*.js or src/**/*.test.ts.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern.' },
        path: { type: 'string', description: 'Directory to search in.' },
        limit: { type: 'integer', description: 'Maximum results, default 200.' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    async execute(args) {
      const pattern = String(args.pattern || '').trim();
      if (!pattern) throw new ToolError('bad_arguments', 'pattern is required.');
      const { base, pattern: filePattern } = globBase(cwd, args.path);
      const stat = statSafe(base);
      if (!stat?.isDirectory()) throw new ToolError('not_found', `Directory not found: ${displayPath(base, cwd)}`);
      const effective = filePattern || pattern;
      let matches;
      try {
        matches = fs.globSync(effective, {
          cwd: base,
          exclude: (entry) => DEFAULT_IGNORES.has(entry.name),
        });
      } catch (error) {
        throw new ToolError('bad_pattern', `Invalid glob pattern: ${error.message}`);
      }
      const limit = Math.max(1, Math.min(1000, Number(args.limit) || 200));
      const sorted = matches
        .map((entry) => (path.isAbsolute(entry) ? path.relative(base, entry) : entry))
        .filter((entry) => !entry.split(/[\\/]/).some((part) => DEFAULT_IGNORES.has(part)))
        .sort((left, right) => left.localeCompare(right));
      const shown = sorted.slice(0, limit);
      return {
        title: `Glob ${pattern}`,
        output: shown.length
          ? `${shown.map((entry) => entry.split(path.sep).join('/')).join('\n')}${sorted.length > shown.length ? `\n… ${sorted.length - shown.length} more files` : ''}`
          : 'No files matched.',
        meta: { count: sorted.length, base },
      };
    },
  };
}

function walkFiles(base, limit = 5000) {
  const results = [];
  const stack = [base];
  while (stack.length && results.length < limit) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (DEFAULT_IGNORES.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) results.push(full);
      if (results.length >= limit) break;
    }
  }
  return results;
}

export function createGrepTool({ cwd }) {
  return {
    name: 'grep',
    group: 'search',
    description: 'Search file contents with a regular expression. Skips dependencies and binary files.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression.' },
        path: { type: 'string', description: 'Directory or file to search.' },
        include: { type: 'string', description: 'Optional glob filter, for example **/*.js.' },
        caseSensitive: { type: 'boolean', description: 'Match case exactly.' },
        limit: { type: 'integer', description: 'Maximum matching lines, default 100.' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    async execute(args) {
      let regex;
      try {
        regex = new RegExp(String(args.pattern || ''), args.caseSensitive ? '' : 'i');
      } catch (error) {
        throw new ToolError('bad_pattern', `Invalid regular expression: ${error.message}`);
      }
      const root = resolvePath(args.path || '.', cwd);
      const stat = statSafe(root);
      if (!stat) throw new ToolError('not_found', `Path not found: ${displayPath(root, cwd)}`);
      let files = [];
      if (stat.isFile()) files = [root];
      else {
        files = walkFiles(root);
        if (args.include) {
          try {
            files = files.filter((file) => path.matchesGlob(file, path.resolve(root, String(args.include))) || path.matchesGlob(file, String(args.include)));
          } catch {
            // Ignore an invalid include filter here; the pattern already validated above.
          }
        }
      }
      const limit = Math.max(1, Math.min(500, Number(args.limit) || 100));
      const matches = [];
      let filesScanned = 0;
      for (const file of files) {
        if (matches.length >= limit) break;
        const info = statSafe(file);
        if (!info?.isFile() || info.size > 1024 * 1024) continue;
        let buffer;
        try {
          buffer = fs.readFileSync(file);
        } catch {
          continue;
        }
        if (isBinary(buffer)) continue;
        filesScanned += 1;
        const lines = buffer.toString('utf8').split('\n');
        for (let index = 0; index < lines.length; index += 1) {
          if (matches.length >= limit) break;
          if (regex.test(lines[index])) {
            matches.push(`${displayPath(file, cwd)}:${index + 1}: ${lines[index].trim().slice(0, 300)}`);
          }
        }
      }
      return {
        title: `Grep ${args.pattern}`,
        output: matches.length ? clip(matches.join('\n')) : `No matches in ${filesScanned} files.`,
        meta: { matches: matches.length, filesScanned },
      };
    },
  };
}

export function createFsTools(deps) {
  return [
    createReadTool(deps),
    createWriteTool(deps),
    createEditTool(deps),
    createLsTool(deps),
    createGlobTool(deps),
    createGrepTool(deps),
  ];
}
