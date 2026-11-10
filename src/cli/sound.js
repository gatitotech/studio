import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A tiny synthesized chime, no audio assets shipped. The WAV is built at
// runtime and played through the operating system's own player so it sounds
// on every platform (including RDP sessions and minimal Linux installs).

const SAMPLE_RATE = 22_050;
// Chimes are peak-normalized to this amplitude — deliberately quiet, so the
// notification nudges you without shouting across the room.
const TARGET_PEAK = 0.3;

// Soft notification "ping": near-pure fundamental, a whisper of 2nd/3rd
// harmonic, a few-millisecond cosine attack, short exponential decay.
function voice(t, { freq, start, duration, gain }) {
  if (t < start) return 0;
  const local = t - start;
  const attack = 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, local / 0.006));
  const decay = Math.exp((-3.2 * local) / duration);
  const envelope = attack * decay;
  const harmonic = (Math.sin(2 * Math.PI * freq * local) * 1.0)
    + (Math.sin(2 * Math.PI * freq * 2 * local) * 0.08)
    + (Math.sin(2 * Math.PI * freq * 3 * local) * 0.035);
  return harmonic * gain * envelope;
}

const CHIMES = {
  // One soft ping: "Gatita needs you".
  prompt: [{ freq: 880.0, start: 0, duration: 0.32, gain: 1.0 }],
  // Two quick ascending pings: "the task is done".
  done: [
    { freq: 783.99, start: 0, duration: 0.22, gain: 0.9 }, // G5
    { freq: 1174.66, start: 0.09, duration: 0.32, gain: 1.0 }, // D6
  ],
};

export function chimeNotes(kind) {
  return CHIMES[kind] || CHIMES.prompt;
}

export function synthChimeWav(kind) {
  const notes = chimeNotes(kind);
  const duration = Math.max(...notes.map((note) => note.start + note.duration)) + 0.05;
  const sampleCount = Math.floor(duration * SAMPLE_RATE);
  const dataSize = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16); // PCM fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM format
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);

  const samples = new Float32Array(sampleCount);
  let peak = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const t = index / SAMPLE_RATE;
    let sample = 0;
    for (const note of notes) sample += voice(t, note);
    samples[index] = sample;
    if (Math.abs(sample) > peak) peak = Math.abs(sample);
  }
  for (let index = 0; index < sampleCount; index += 1) {
    const boosted = peak > 0 ? (samples[index] / peak) * TARGET_PEAK : 0;
    buffer.writeInt16LE(Math.floor(Math.max(-1, Math.min(1, boosted)) * 32_767), 44 + index * 2);
  }
  return buffer;
}

function chimeFile(kind) {
  const file = path.join(os.tmpdir(), `gatita-chime-${kind}.wav`);
  try {
    const wanted = synthChimeWav(kind);
    let current = null;
    try {
      current = fs.readFileSync(file);
    } catch {
      current = null;
    }
    if (!current || current.length !== wanted.length || !current.equals(wanted)) {
      fs.writeFileSync(file, wanted);
    }
    return file;
  } catch {
    return '';
  }
}

// Ordered player candidates per platform. The first one that exists wins.
// SoundPlayer.PlaySync() silently drops audio when the process has no UI
// message loop (a detached child), so playback here is waited-for, not
// fire-and-forget. The chimes are short, so the cost is negligible.
export function playerCommands(platform, file) {
  if (platform === 'win32') {
    return [
      { command: 'powershell.exe', args: ['-NoProfile', '-Command', `(New-Object Media.SoundPlayer '${file}').PlaySync()`] },
      { command: 'powershell.exe', args: ['-NoProfile', '-Command', '[console]::beep(880, 180)'] },
    ];
  }
  if (platform === 'darwin') {
    return [{ command: 'afplay', args: [file] }];
  }
  return [
    { command: 'paplay', args: [file] },
    { command: 'aplay', args: ['-q', file] },
    { command: 'play', args: ['-q', file] },
    { command: 'ffplay', args: ['-nodisp', '-autoexit', '-loglevel', 'quiet', file] },
  ];
}

function tryPlayer(candidates, index, onDone) {
  if (index >= candidates.length) {
    onDone?.(false);
    return;
  }
  const attempt = candidates[index];
  let child;
  try {
    child = spawn(attempt.command, attempt.args, { stdio: 'ignore', windowsHide: true });
  } catch {
    tryPlayer(candidates, index + 1, onDone);
    return;
  }
  child.on('error', () => tryPlayer(candidates, index + 1, onDone));
  child.on('close', (code) => {
    if (code === 0) onDone?.(true);
    else tryPlayer(candidates, index + 1, onDone);
  });
}

export function playChime(kind, customFile = '', { onExhausted } = {}) {
  const override = String(customFile || '').trim();
  const file = override && fs.existsSync(override) ? override : chimeFile(kind);
  if (!file) {
    onExhausted?.();
    return;
  }
  tryPlayer(playerCommands(process.platform, file), 0, (played) => {
    if (!played) onExhausted?.();
  });
}
