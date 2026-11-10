import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  DOWNLOAD_URL,
  MANIFEST_URL,
  compareVersions,
  formatUpdateNotice,
  resolveDownloadUrl,
  verifyTarball,
} from '../src/cli/update.js';

test('the update client uses the fixed public release endpoints', () => {
  assert.equal(MANIFEST_URL, 'https://api.gatita.tech/studio/install/manifest.json');
  assert.equal(DOWNLOAD_URL, 'https://api.gatita.tech/studio/download/gatita-studio-latest.tgz');
});

test('version comparison only reports genuinely newer releases', () => {
  assert.equal(compareVersions('0.1.1', '0.1.0'), 1);
  assert.equal(compareVersions('0.1.0', '0.1.1'), -1);
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('', '1.0.0'), -1);
});

test('download URLs stay on the fixed release host', () => {
  assert.equal(
    resolveDownloadUrl('gatita-studio-latest.tgz'),
    'https://api.gatita.tech/studio/download/gatita-studio-latest.tgz',
  );
  assert.equal(
    resolveDownloadUrl('https://api.gatita.tech/studio/download/gatita-studio-latest.tgz'),
    'https://api.gatita.tech/studio/download/gatita-studio-latest.tgz',
  );
  assert.equal(
    resolveDownloadUrl('https://evil.example/gatita.tgz'),
    'https://api.gatita.tech/studio/download/gatita-studio-latest.tgz',
  );
  assert.equal(
    resolveDownloadUrl('http://api.gatita.tech/studio/download/gatita.tgz'),
    'https://api.gatita.tech/studio/download/gatita-studio-latest.tgz',
  );
});

test('tarball checksums are required and verified', () => {
  const buffer = Buffer.from('gatita-studio-test-release');
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  assert.equal(verifyTarball(buffer, hash), hash);
  assert.throws(() => verifyTarball(buffer, '0'.repeat(64)), /checksum mismatch/i);
  assert.throws(() => verifyTarball(buffer, ''), /sha-256/i);
});

test('update notices carry only version, size, and public instructions', () => {
  const notice = formatUpdateNotice({
    latestVersion: '9.9.9',
    outOfDate: true,
    size: 2048,
  });
  assert.equal(notice.current, '0.2.0');
  assert.equal(notice.latest, '9.9.9');
  assert.equal(notice.size, '2 KB');
  assert.match(notice.message, /gatita-studio update/);
  assert.equal(formatUpdateNotice({ latestVersion: '0.0.9', outOfDate: false }), null);
});
