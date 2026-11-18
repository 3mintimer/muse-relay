import { build } from 'esbuild';
import { mkdir, cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';

const directory = fileURLToPath(new URL('.', import.meta.url));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--outdir')) throw new Error('Usage: node server/cloudflare/build.mjs [--outdir PATH]');
const output = args.length ? resolve(args[1]) : join(directory, 'dist');
await mkdir(join(output, 'server'), { recursive: true });
await build({ entryPoints: [join(directory, 'worker.mjs')], outfile: join(output, 'server/index.js'), bundle: true, format: 'esm', platform: 'browser', target: 'es2022', legalComments: 'none' });
await mkdir(join(output, '.openai'), { recursive: true });
await cp(join(directory, 'drizzle'), join(output, '.openai/drizzle'), { recursive: true });
console.log(`Worker: ${join(output, 'server/index.js')}`);
console.log(`Schema migrations: ${join(output, '.openai/drizzle')}`);
