import test from 'node:test';
import assert from 'node:assert/strict';
import { synthChimeWav, chimeNotes, playerCommands } from '../src/cli/sound.js';

test('the synthesized chime is a valid 16-bit PCM mono WAV', () => {
  for (const kind of ['prompt', 'done']) {
    const wav = synthChimeWav(kind);
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
    assert.equal(wav.toString('ascii', 36, 40), 'data');
    assert.equal(wav.readUInt32LE(16), 16, 'fmt chunk size');
    assert.equal(wav.readUInt16LE(20), 1, 'PCM format');
    assert.equal(wav.readUInt16LE(22), 1, 'mono');
    const dataSize = wav.readUInt32LE(40);
    assert.equal(dataSize, wav.length - 44, 'header matches payload');
    assert.equal(dataSize % 2, 0);
    // The bell must actually contain energy.
    let peak = 0;
    for (let offset = 44; offset < wav.length; offset += 2) {
      peak = Math.max(peak, Math.abs(wav.readInt16LE(offset)));
    }
    assert.ok(peak > 2_000, `expected audible energy, peak ${peak}`);
    assert.ok(peak <= 32_767);
  }
});

test('the done chime is longer than the prompt chime', () => {
  assert.ok(synthChimeWav('done').length > synthChimeWav('prompt').length);
  assert.equal(chimeNotes('done').length, 2);
  assert.equal(chimeNotes('prompt').length, 1);
});

test('each platform gets a player chain, with a bell fallback on Windows', () => {
  const win = playerCommands('win32', 'C:/tmp/chime.wav');
  assert.equal(win[0].command, 'powershell.exe');
  assert.match(win[0].args.join(' '), /Media\.SoundPlayer/);
  assert.ok(win[1].args.at(-1).includes('beep'), 'bell fallback on Windows');

  const mac = playerCommands('darwin', '/tmp/chime.wav');
  assert.deepEqual(mac, [{ command: 'afplay', args: ['/tmp/chime.wav'] }]);

  const linux = playerCommands('linux', '/tmp/chime.wav');
  assert.equal(linux[0].command, 'paplay');
  assert.ok(linux.some((entry) => entry.command === 'aplay'));
  assert.ok(linux.some((entry) => entry.command === 'play'));
});

test('the chime is a real prompt → silence pattern, not an immediate decay', () => {
  // Regression: the first chime decayed so fast it sounded like a tick.
  const wav = synthChimeWav('prompt');
  const samples = (wav.length - 44) / 2;
  const samplesPerMs = 22050 / 1000;
  const rms = (fromMs, toMs) => {
    let sum = 0;
    let count = 0;
    for (let index = Math.floor(fromMs * samplesPerMs); index < Math.min(samples, toMs * samplesPerMs); index += 1) {
      const value = wav.readInt16LE(44 + index * 2);
      sum += value * value;
      count += 1;
    }
    return count ? Math.sqrt(sum / count) : 0;
  };
  assert.ok(rms(0, 80) > 5_000, 'the attack must be audible');
  assert.ok(rms(150, 280) < rms(0, 80), 'the tail must decay below the attack');
  assert.ok(rms(280, 360) < 1_000, 'the end must fade to silence, not clip off');
});
