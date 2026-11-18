import { readFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const manifest=JSON.parse(readFileSync('app.json','utf8'));
const sdk=JSON.parse(readFileSync('node_modules/@evenrealities/even_hub_sdk/package.json','utf8'));
mkdirSync('artifacts',{recursive:true});
const result=spawnSync('node_modules/.bin/evenhub',['pack','app.json','dist','--sdk-ver',sdk.version,'-o',`artifacts/muse-relay-${manifest.version}.ehpk`,'--json'],{stdio:'inherit'});
process.exit(result.status??1);
