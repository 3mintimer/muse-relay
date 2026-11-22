import { readFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
// Every packaging entry point checks the exact, reviewed labels rendered by the app.
const menus = spawnSync('node_modules/.bin/tsx', ['--test', 'tests/context-menu.test.ts'], {stdio: 'inherit'});
if (menus.status !== 0) process.exit(menus.status ?? 1);

// Package the source just checked, even when an older dist directory is present.
const build = spawnSync('npm', ['run', 'build'], {stdio: 'inherit'});
if (build.status !== 0) process.exit(build.status ?? 1);

const manifest=JSON.parse(readFileSync('app.json','utf8'));
const sdk=JSON.parse(readFileSync('node_modules/@evenrealities/even_hub_sdk/package.json','utf8'));
mkdirSync('artifacts',{recursive:true});
const result=spawnSync('node_modules/.bin/evenhub',['pack','app.json','dist','--sdk-ver',sdk.version,'-o',`artifacts/muse-relay-${manifest.version}.ehpk`,'--json'],{stdio:'inherit'});
process.exit(result.status??1);
