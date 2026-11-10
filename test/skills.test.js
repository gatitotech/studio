import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSkills, createSkillTool } from '../src/skills/index.js';
import { loadPlugins, createPluginToolWrappers, runHook } from '../src/plugins/index.js';

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `gatita-${name}-`));
}

function withEnv(value, fn) {
  const previous = process.env.GATITA_STUDIO_HOME;
  process.env.GATITA_STUDIO_HOME = value;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (previous === undefined) delete process.env.GATITA_STUDIO_HOME;
      else process.env.GATITA_STUDIO_HOME = previous;
    });
}

test('skills load from the global folder and the project folder', async () => {
  const home = tempDir('skills-home');
  const cwd = tempDir('skills-project');
  await withEnv(home, async () => {
    fs.mkdirSync(path.join(home, 'skills', 'deploy'), { recursive: true });
    fs.writeFileSync(path.join(home, 'skills', 'deploy', 'SKILL.md'), [
      '---',
      'name: deploy',
      'description: Ship the app safely',
      '---',
      '',
      'Run the checks, then deploy.',
    ].join('\n'));
    fs.mkdirSync(path.join(cwd, '.gatita', 'skills', 'review'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.gatita', 'skills', 'review', 'SKILL.md'), '# Review\n\nLook for bugs first.');

    const skills = loadSkills({ cwd });
    assert.deepEqual(skills.map((skill) => skill.name), ['deploy', 'review']);
    const deploy = skills.find((skill) => skill.name === 'deploy');
    assert.equal(deploy.description, 'Ship the app safely');
    assert.equal(deploy.source, 'global');

    const tool = createSkillTool({ skills });
    const listed = await tool.execute({});
    assert.match(listed.output, /deploy/);
    assert.match(listed.output, /review/);
    const loaded = await tool.execute({ name: 'deploy' });
    assert.match(loaded.output, /Run the checks, then deploy/);
    await assert.rejects(() => tool.execute({ name: 'missing' }), /No skill named missing/);
  });
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('plugins contribute tools, commands and hooks', async () => {
  const home = tempDir('plugins-home');
  const cwd = tempDir('plugins-project');
  await withEnv(home, async () => {
    fs.mkdirSync(path.join(cwd, '.gatita', 'plugins'), { recursive: true });
    const pluginFile = path.join(cwd, '.gatita', 'plugins', 'hello.mjs');
    fs.writeFileSync(pluginFile, `
export default {
  name: 'hello',
  version: '2.0.0',
  tools: [{
    name: 'hello_tool',
    group: 'plugin',
    description: 'Say hello',
    parameters: { type: 'object', properties: { name: { type: 'string' } } },
    async execute(args) { return { title: 'hello', output: 'hello ' + (args.name || 'world') }; },
  }],
  commands: [{
    name: 'hello',
    description: 'Greet from a plugin',
    async run({ args }) { return 'plugin says ' + args; },
  }],
  hooks: [{
    event: 'beforeTool',
    async run(payload) { return { ...payload, args: { ...payload.args, name: 'hooked' } }; },
  }],
};
`, 'utf8');

    const loaded = await loadPlugins({ cwd, config: { plugins: true } });
    assert.equal(loaded.plugins.length, 1);
    assert.equal(loaded.plugins[0].name, 'hello');
    assert.equal(loaded.tools.length, 1);
    assert.equal(loaded.commands[0].name, 'hello');
    assert.equal(await loaded.commands[0].run({ args: 'there' }), 'plugin says there');

    const wrappers = createPluginToolWrappers(loaded.tools);
    const result = await wrappers[0].execute({ name: 'world' });
    assert.equal(result.output, 'hello world');

    const payload = await runHook(loaded.hooks, 'beforeTool', { args: { name: 'x' } });
    assert.equal(payload.args.name, 'hooked');
  });
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('plugins can be disabled entirely', async () => {
  const home = tempDir('plugins-off');
  const cwd = tempDir('plugins-off-project');
  await withEnv(home, async () => {
    fs.mkdirSync(path.join(cwd, '.gatita', 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.gatita', 'plugins', 'x.mjs'), 'export default { name: "x", tools: [] };');
    const loaded = await loadPlugins({ cwd, config: { plugins: false } });
    assert.equal(loaded.plugins.length, 0);
  });
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});
