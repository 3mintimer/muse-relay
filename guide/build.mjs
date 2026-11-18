import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { localizedHtml } from './localized-html.mjs';
import { languages, languageHref } from './web/language.js';
import { prepareLocale } from './web/i18n.js';

const directory = fileURLToPath(new URL('.', import.meta.url));
const WEB = join(directory, 'web');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
};

export async function collectPublicAssets() {
  const assets = {}; let total = 0;
  async function visit(folder) {
    const entries = await readdir(folder, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (entry.name.startsWith('.')) continue;
      const path = join(folder, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Public assets must not contain symbolic links.');
      if (entry.isDirectory()) { await visit(path); continue; }
      if (!entry.isFile()) throw new Error('Public assets must be regular files.');
      const name = '/' + relative(WEB, path).split(sep).join('/');
      const type = TYPES[extname(path).toLowerCase()];
      if (!type || !/^\/[A-Za-z0-9._/-]+$/.test(name)) throw new Error(`Unsupported public asset: ${name}`);
      const bytes = await readFile(path); total += bytes.byteLength;
      if (bytes.byteLength > 2_000_000 || total > 8_000_000) throw new Error('Public assets exceed the embedded Worker size budget.');
      assets[name] = { type, size: bytes.byteLength, base64: bytes.toString('base64'), etag: `"${createHash('sha256').update(bytes).digest('hex')}"` };
    }
  }
  await visit(WEB);
  if (!assets['/index.html']) throw new Error('web/index.html is required.');
  const template = Buffer.from(assets['/index.html'].base64, 'base64').toString('utf8');
  for (const language of Object.keys(languages)) {
    await prepareLocale(language);
    const bytes = Buffer.from(localizedHtml(template, language));
    const name = languageHref(language) + 'index.html';
    total += bytes.byteLength - (assets[name]?.size || 0);
    if (bytes.byteLength > 2_000_000 || total > 8_000_000) throw new Error('Localized HTML exceeds the public asset size budget.');
    assets[name] = { type: TYPES['.html'], size: bytes.byteLength, base64: bytes.toString('base64'), etag: `"${createHash('sha256').update(bytes).digest('hex')}"` };
  }
  return assets;
}

async function hostingManifest() {
  // The independent Sites checkout owns its identity. Never infer one from another project.
  const candidates = [...new Set([join(process.cwd(), '.openai/hosting.json'), join(directory, '.openai/hosting.json')]), join(directory, 'hosting.example.json')];
  for (const path of candidates) {
    let contents;
    try { contents = await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const value = JSON.parse(contents);
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.static !== undefined) throw new Error('The guide requires a Worker hosting manifest without static.directory.');
    if (value.d1 !== undefined && value.d1 !== 'DB') throw new Error('The guide requires the D1 binding DB.');
    return { ...value, d1: 'DB', r2: value.r2 ?? null };
  }
  throw new Error('No hosting manifest or example was found.');
}

export async function buildGuide(output = join(directory, 'dist')) {
  output = resolve(output);
  if (output === directory || directory.startsWith(output + sep) || [WEB, join(directory, 'db'), join(directory, '.openai')].some(path => output === path || output.startsWith(path + sep))) throw new Error('Choose a separate build output directory.');
  const assets = await collectPublicAssets();
  const hosting = await hostingManifest();
  await mkdir(join(output, 'server'), { recursive: true });
  await build({
    entryPoints: [join(directory, 'worker.mjs')], outfile: join(output, 'server/index.js'), bundle: true,
    format: 'esm', platform: 'browser', target: 'es2022', legalComments: 'none',
    define: { __GUIDE_ASSETS__: JSON.stringify(assets) },
  });
  await mkdir(join(output, '.openai'), { recursive: true });
  await writeFile(join(output, '.openai/hosting.json'), JSON.stringify(hosting, null, 2) + '\n');
  await rm(join(output, '.openai/drizzle'), { recursive: true, force: true });
  await cp(join(directory, 'db/drizzle'), join(output, '.openai/drizzle'), { recursive: true });
  return { output, assetCount: Object.keys(assets).length, hasProjectId: Boolean(hosting.project_id) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--outdir')) throw new Error('Usage: node build.mjs [--outdir PATH]');
  const result = await buildGuide(args.length ? resolve(args[1]) : undefined);
  console.log(`Worker: ${join(result.output, 'server/index.js')} (${result.assetCount} public assets)`);
  console.log(`Manifest and schema: ${join(result.output, '.openai')}`);
  if (!result.hasProjectId) console.log('Example manifest only: use the registered Sites checkout before deployment.');
}
