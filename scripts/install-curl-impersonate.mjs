#!/usr/bin/env node
/**
 * Download curl-impersonate into .tools/.
 *
 * hltv.org's Cloudflare rule accepts Chrome's TLS fingerprint but rejects node's
 * and older/newer profiles, so the client talks HTTP through this binary
 * (profile chrome131 by default) instead of driving a browser.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const VERSION = 'v2.3.2';
const TOOLS = join(process.cwd(), '.tools');

function platformAsset() {
  const arch = process.arch;
  if (process.platform === 'win32') {
    if (arch !== 'x64') throw new Error(`Unsupported Windows arch: ${arch}`);
    return `curl-impersonate-${VERSION}.x86_64-win32.tar.gz`;
  }
  if (process.platform === 'darwin') {
    return `curl-impersonate-${VERSION}.${arch === 'arm64' ? 'arm64' : 'x86_64'}-macos.tar.gz`;
  }
  return `curl-impersonate-${VERSION}.${arch === 'arm64' ? 'aarch64' : 'x86_64'}-linux-gnu.tar.gz`;
}

const binaryName = process.platform === 'win32' ? 'curl-impersonate.exe' : 'curl-impersonate';
const target = join(TOOLS, binaryName);

if (existsSync(target)) {
  console.log(`curl-impersonate already present at ${target}`);
  process.exit(0);
}

const asset = platformAsset();
const url = `https://github.com/lexiforest/curl-impersonate/releases/download/${VERSION}/${asset}`;
const archive = join(TOOLS, 'curl-impersonate.tar.gz');

await mkdir(TOOLS, { recursive: true });
console.log(`Downloading ${asset}…`);
const res = await fetch(url, { redirect: 'follow' });
if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} for ${url}`);
await writeFile(archive, Buffer.from(await res.arrayBuffer()));

console.log('Extracting…');
await execFileAsync('tar', ['xzf', archive, '-C', TOOLS], { timeout: 120_000 });
await rm(archive, { force: true });

if (!existsSync(target)) {
  throw new Error(`Extracted archive but ${target} is missing. Check the release layout.`);
}
console.log(`Ready: ${target}`);
