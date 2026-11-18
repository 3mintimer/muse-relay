#!/usr/bin/env node
// Export reviewed files only. No Git commands, credentials, deployment or cleanup.
import { constants } from 'node:fs';
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestName = 'PUBLIC-SOURCE-MANIFEST.json';
class ExportError extends Error {}
const publicHosts = new Set([
  'muse-relay-guide.spicy-cup-4319.chatgpt.site',
  'github.com', 'api.github.com', 'gist.github.com', 'gist.githubusercontent.com',
  'raw.githubusercontent.com', 'docs.github.com', 'registry.npmjs.org', 'www.npmjs.com',
  'www.w3.org', 'www.apache.org', 'opensource.org', 'www.gnu.org', 'gnu.org',
  'hub.evenrealities.com', 'gadgets.muse.ai', 'console.soniox.com', 'docs.soniox.com', 'api.soniox.com', 'stt-rt.soniox.com',
  'developers.cloudflare.com', 'docs.espressif.com', 'dl.espressif.com', 'docs.m5stack.com',
  'nodejs.org', 'vite.dev', 'www.typescriptlang.org', 'docs.docker.com',
]);
const packageHosts = new Set(['opencollective.com', 'feross.org', 'www.patreon.com', 'paulmillr.com', 'thanks.dev', 'tidelift.com', 'tsx.is', "tsx.hirok.io"]);
const findings = [];
const report = (file, kind) => findings.push({ file, kind });
const fixture = file => /(?:^tests\/|\.test\.[cm]?[jt]s$)/.test(file);
const isExampleHost = host => /(?:^|\.)(?:example(?:\.com|\.org|\.net)?|test|invalid|localhost|local)$/.test(host);
const relativePath = value => value && !isAbsolute(value) && value.split('/').every(part => part && part !== '.' && part !== '..') && !value.includes('\\');

export function auditText(file, text) {
  const issues = [];
  const add = kind => issues.push(kind);
  const patterns = [
    ['provider credential', /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,})/],
    ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
    ['JWT credential', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
    ['literal bearer credential', /\bBearer\s+[A-Za-z0-9._-]{24,}/],
    ['personal absolute path', /\/(?:Users|home)\/[^/\s"'<>`]+\/|[A-Z]:\\Users\\[^\\\s]+\\/],
    ['private development record', /(?:docs\/)?verification-\d{4}|(?:docs\/)?verification-\d+\.\d+|store-description\.txt|branding\/candidates-/],
  ];
  for (const [kind, pattern] of patterns) if (pattern.test(text)) add(kind);
  for (const match of text.matchAll(/(?<![\w.])(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?![\w.])/g)) {
    // These two addresses appear below only to recognize the existing rejection-test fixtures.
    const fixtureRule = file === 'scripts/export-public.mjs' && ['192.168.1.2', '10.0.0.1'].includes(match[0]);
    if (!fixture(file) && !fixtureRule) add('private network address');
  }
  for (const match of text.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)) {
    if (!isExampleHost(match[1]) && match[1] !== 'users.noreply.github.com') add('email address');
  }
  const credential = /\b[A-Za-z_]*(?:token|password|passwd|secret|api[_-]?key)[A-Za-z_]*\s*["']?\s*[:=]\s*["'`]([A-Za-z0-9_=-]{24,})["'`]/gi;
  for (const match of text.matchAll(credential)) {
    const value = match[1];
    const dummy = /(?:replace|example|placeholder|generate|change.me)/i.test(value)
      || (fixture(file) && /(?:test|synthetic|do-not-copy)/i.test(value));
    if (!dummy) add('credential-shaped literal');
  }
  if (file.endsWith('.env.example')) for (const line of text.split('\n')) {
    const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (!match || !/(?:TOKEN|KEY|PASSWORD|PASSWD|SSID|GIST_ID)/.test(match[1])) continue;
    const value = match[2].replace(/^["']|["']$/g, '');
    if (value && !/(?:replace|example|placeholder|generate|change.me|your[_ -])/i.test(value)) add('non-placeholder example credential');
  }
  for (const match of text.matchAll(/(?:https?|wss?):\/\/[^\s"'<>`\\)\],]+/g)) {
    const authority = match[0].split('://')[1].split('/')[0];
    if (/[${}…]/.test(authority)) continue;
    let url;
    try { url = new URL(match[0].replace(/[。、）「」]+$/u, '')); } catch { continue; } // Documented placeholders are not endpoints.
    const host = url.hostname;
    if (url.username || url.password) {
      if (!(fixture(file) && (isExampleHost(host) || host === '127.0.0.1'))) add('credentials in URL');
    }
    if (/[?&](?:token|secret|api_key|access_token|auth)=/i.test(url.search)) add('credential query parameter');
    if (['127.0.0.1', '[::1]', 'localhost'].includes(host) || isExampleHost(host) || publicHosts.has(host)) continue;
    if (fixture(file) && ['192.168.1.2', '10.0.0.1', '127.1'].includes(host)) continue;
    if (file.endsWith('package-lock.json') && packageHosts.has(host)) continue;
    add('unreviewed external host');
  }
  return [...new Set(issues)];
}

function auditPng(file, data) {
  if (!data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) { report(file, 'unexpected binary format'); return; }
  let offset = 8;
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset), type = data.toString('ascii', offset + 4, offset + 8);
    if (offset + length + 12 > data.length) { report(file, 'invalid PNG'); return; }
    if (['eXIf', 'tEXt', 'zTXt', 'iTXt'].includes(type)) report(file, 'image metadata needs review');
    offset += length + 12;
  }
  if (offset !== data.length) report(file, 'unexpected PNG trailing data');
}

const withoutFences = text => text.replace(/^\s*```[^\n]*\n[\s\S]*?^\s*```\s*$/gm, '');
function headings(text) {
  const ids = new Set(), duplicates = new Map();
  for (const match of withoutFences(text).matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const base = match[1].replace(/<[^>]+>/g, '').replace(/[`*_~]/g, '').trim().toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '').replace(/\s/g, '-');
    const count = duplicates.get(base) || 0;
    ids.add(base + (count ? `-${count}` : '')); duplicates.set(base, count + 1);
  }
  for (const match of text.matchAll(/\bid=["']([^"']+)["']/g)) ids.add(match[1]);
  return ids;
}

function checkLinks(files) {
  const paths = new Set(files.keys());
  const exists = path => paths.has(path) || [...paths].some(file => file.startsWith(path.replace(/\/$/, '') + '/'));
  for (const [file, { text }] of files) {
    if (text === undefined || !/\.(?:md|html)$/.test(file)) continue;
    const targets = file.endsWith('.md')
      ? [...withoutFences(text).matchAll(/!?\[[^\]\n]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)].map(match => match[1])
      : [...text.matchAll(/\b(?:href|src|action)=["']([^"']+)["']/g)].map(match => match[1]);
    for (let target of targets) {
      if (/^(?:https?:|mailto:|data:|tel:|javascript:|\/\/)/i.test(target)) continue;
      let decoded;
      try { decoded = decodeURIComponent(target); } catch { report(file, 'invalid local link encoding'); continue; }
      const [pathWithQuery, fragment] = decoded.split('#');
      const path = pathWithQuery.split('?')[0];
      if (path.startsWith('/api/') && file.startsWith('guide/web/')) continue;
      const webRoot = file.startsWith('guide/web/') ? join(root, 'guide/web') : root;
      const resolved = !path ? file : relative(root, path.startsWith('/') ? resolve(webRoot, '.' + path) : resolve(root, dirname(file), path)).split(sep).join('/');
      if ((!resolved && path === '/') || (resolved === 'guide/web' && path === '/')) continue;
      if (!exists(resolved)) { report(file, 'local link outside public file list'); continue; }
      if (fragment && files.get(resolved)?.text && /\.(?:md|html)$/.test(resolved)
        && !headings(files.get(resolved).text).has(fragment)) report(file, 'local anchor not found');
    }
  }
}

async function readSources() {
  let listed;
  try { listed = JSON.parse(await readFile(join(root, 'scripts/public-source-files.json'), 'utf8')); }
  catch { throw new ExportError('Public file list could not be read.'); }
  if (listed.format !== 1 || !Array.isArray(listed.files) || new Set(listed.files).size !== listed.files.length) throw new ExportError('Invalid public file list.');
  const files = new Map();
  for (const file of listed.files) {
    if (!relativePath(file) || /(?:^|\/)(?:\.git|\.local|node_modules|artifacts|dist|build-atoms3)(?:\/|$)/.test(file)) throw new ExportError('Unsafe public file list entry.');
    let stat;
    try {
      let cursor = root;
      for (const part of file.split('/')) { cursor = join(cursor, part); stat = await lstat(cursor); if (stat.isSymbolicLink()) throw new Error(); }
      if (!stat.isFile() || stat.size > 3_000_000) throw new Error();
    } catch { report(file, 'missing, linked or oversized source'); continue; }
    const data = await readFile(join(root, file), { flag: constants.O_RDONLY | constants.O_NOFOLLOW });
    let text;
    if (file.endsWith('.png')) auditPng(file, data);
    else {
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); }
      catch { report(file, 'unexpected binary source'); continue; }
      for (const kind of auditText(file, text)) report(file, kind);
    }
    files.set(file, { data, text, mode: stat.mode & 0o111 ? 0o755 : 0o644 });
  }
  checkLinks(files);
  return files;
}

async function emptyDestination(value) {
  if (!value) throw new ExportError('Usage: node scripts/export-public.mjs --out EMPTY_DIRECTORY | --check');
  const output = resolve(value);
  const parent = await realpath(dirname(output)).catch(() => { throw new ExportError('Destination parent directory must already exist.'); });
  const canonical = join(parent, basename(output));
  if (canonical === root || root.startsWith(canonical + sep)) throw new ExportError('Destination must not contain the source project.');
  if (canonical.startsWith(root + sep) && !canonical.startsWith(join(root, '.local') + sep)
    && !canonical.startsWith(join(root, 'artifacts') + sep)) throw new ExportError('Inside this project, use an ignored output directory.');
  try {
    const stat = await lstat(output);
    if (stat.isSymbolicLink() || !stat.isDirectory() || (await readdir(output)).length) throw new ExportError('Destination must be an empty ordinary directory.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return output;
}

async function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.length === 1 && args[0] === '--check';
  if (!checkOnly && !(args.length === 2 && args[0] === '--out')) throw new ExportError('Usage: node scripts/export-public.mjs --out EMPTY_DIRECTORY | --check');
  const output = checkOnly ? undefined : await emptyDestination(args[1]);
  const files = await readSources();
  if (findings.length) {
    for (const finding of findings) console.error(`${finding.file}: ${finding.kind}`);
    throw new ExportError('Public source checks failed. No files were exported.');
  }
  if (checkOnly) { console.log(`Checked ${files.size} allowed files; no files written.`); return; }
  await mkdir(output, { recursive: false }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const destinationStat = await lstat(output);
  if (destinationStat.isSymbolicLink() || !destinationStat.isDirectory() || (await readdir(output)).length) throw new ExportError('Destination changed before export. No files were overwritten.');
  const hashes = {};
  for (const [file, { data, mode }] of files) {
    const destination = join(output, file);
    await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
    await writeFile(destination, data, { mode, flag: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW });
    hashes[file] = createHash('sha256').update(data).digest('hex');
  }
  const app = JSON.parse(files.get('app.json').text);
  await writeFile(join(output, manifestName), JSON.stringify({ format: 1, app_version: app.version, files: hashes }, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
  console.log(`Exported ${files.size} reviewed files and a checksum manifest. No Git history or configuration was copied.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    // Filesystem errors may contain private absolute paths. Do not print their message or stack.
    console.error(error instanceof ExportError ? error.message : 'Export operation failed; use a new empty destination after checking access and source syntax.');
    process.exitCode = 1;
  });
}
