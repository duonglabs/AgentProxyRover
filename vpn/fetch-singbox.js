'use strict';

/**
 * Downloads the pinned sing-box release for Windows and drops sing-box.exe +
 * libcronet.dll into vpn/bin/. Verifies the SHA256 of the exe before use.
 *
 *   node vpn/fetch-singbox.js
 *
 * The zip is fetched from the official SagerNet/sing-box GitHub release over
 * HTTPS. The hash below pins the build we reviewed; if a re-download ever
 * differs, the script refuses to install it.
 */

const https = require('node:https');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SINGBOX_VERSION = '1.14.4';
const URL_ZIP = `https://github.com/SagerNet/sing-box/releases/download/v${SINGBOX_VERSION}/sing-box-${SINGBOX_VERSION}-windows-amd64.zip`;
// SHA256 pins of the two binaries inside that zip (recorded on first download,
// 2026-11-08). Both run elevated — a mismatch refuses the install.
const EXE_SHA256 = '8f30682ee198855440d2a7fe070d5d3653793b2d01bb8c85eea88f93bbe7c8b9';
const DLL_SHA256 = '3217c6260fbca5f16072e0b79735742f40109a63bb0ff88fd6b96dd6b54a2928';

const destBin = path.resolve(__dirname, 'bin');
// zip cache INSIDE the repo (vpn/.cache/ is gitignored) — not in a parent dir
const tmpDir = path.resolve(__dirname, '.cache', `sing-box-${SINGBOX_VERSION}`);

function fetchToBuffer(url) {
  return new Promise((resolve, reject) => {
    const get = (u, redirects = 0) => {
      https
        .get(u, { headers: { 'User-Agent': 'agentproxy-vpn-poc' } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            if (redirects > 5) return reject(new Error('too many redirects'));
            res.resume();
            return get(res.headers.location, redirects + 1);
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
          }
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks)));
          res.on('error', reject);
        })
        .on('error', reject);
    };
    get(url);
  });
}

async function main() {
  if (!fs.existsSync(destBin)) fs.mkdirSync(destBin, { recursive: true });
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const zipPath = path.join(tmpDir, `sing-box-${SINGBOX_VERSION}-windows-amd64.zip`);
  const exeInZip = path.join(tmpDir, `sing-box-${SINGBOX_VERSION}-windows-amd64`, 'sing-box.exe');

  if (!fs.existsSync(zipPath)) {
    console.log(`downloading ${URL_ZIP} ...`);
    const buf = await fetchToBuffer(URL_ZIP);
    fs.writeFileSync(zipPath, buf);
    console.log(`saved ${zipPath} (${(buf.length / 1e6).toFixed(1)} MB)`);
  } else {
    console.log('zip already downloaded:', zipPath);
  }

  if (!fs.existsSync(exeInZip)) {
    console.log('extracting ...');
    execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${tmpDir}" -Force`,
    ], { stdio: 'inherit' });
  }

  const zipDir = path.dirname(exeInZip);
  const pins = [
    ['sing-box.exe', EXE_SHA256],
    ['libcronet.dll', DLL_SHA256],
  ];
  for (const [name, expected] of pins) {
    const src = path.join(zipDir, name);
    if (!fs.existsSync(src)) {
      console.error(
        `REFUSING to install: ${name} missing from the extracted zip — ` +
          `release layout changed? Update vpn/fetch-singbox.js.`,
      );
      process.exit(1);
    }
    const hash = crypto.createHash('sha256').update(fs.readFileSync(src)).digest('hex');
    if (hash.toLowerCase() !== expected) {
      console.error(`REFUSING to install ${name}: sha256 mismatch\n  expected ${expected}\n  got      ${hash}`);
      process.exit(1);
    }
    console.log(`sha256 OK (${name}):`, hash);
    fs.copyFileSync(src, path.join(destBin, name));
    console.log('installed', path.join(destBin, name));
  }
  console.log('\ndone — VPN mode is ready.');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
