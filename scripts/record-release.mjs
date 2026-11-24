// Run on the maintainer's computer. The two CLIs keep their credentials locally.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { isPublicStoreBuild } from './even-hub-store.mjs';

const repo = '3mintimer/muse-relay';
const packageId = 'com.threemintimer.muserelay';
const hub = fileURLToPath(new URL('../node_modules/.bin/evenhub', import.meta.url));

function run(command, args, input) {
  const result = spawnSync(command, args, { input, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    // Download errors can include a short-lived signed URL. Keep Hub diagnostics local.
    const detail = command === 'gh' ? result.stderr.trim() : 'Check Even Hub login, project access and the selected build.';
    throw new Error(`${basename(command)} ${args[0]} failed (${result.status}). ${detail}`);
  }
  return result.stdout.trim();
}

function api(path, method = 'GET', data) {
  const args = ['api', '--method', method, `repos/${repo}/${path}`];
  if (data) args.push('--input', '-');
  const output = run('gh', args, data ? JSON.stringify(data) : undefined);
  return output ? JSON.parse(output) : null;
}

function optional(path) {
  try { return api(path); }
  catch (error) { if (/HTTP 404\b/.test(error.message)) return null; throw error; }
}

function sourceText(path, commit) {
  const file = api(`contents/${path}?ref=${commit}`);
  if (file.type !== 'file' || file.encoding !== 'base64') throw new Error(`Could not read ${path} at the release commit.`);
  return Buffer.from(file.content, 'base64').toString('utf8');
}

export async function releaseTarget(listing, version, channel, storefront = fetch) {
  if (!['beta', 'public'].includes(channel) || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Expected a numeric Even Hub version and beta or public.');
  const assigned = listing.versions?.filter(item => item.channels?.includes(channel)) ?? [];
  const [build] = assigned;
  if (!listing.ok || listing.package_id !== packageId || assigned.length !== 1 || build.version !== version || !Number.isSafeInteger(build.id)
    || (channel === 'public' && !await isPublicStoreBuild(packageId, build, storefront))) {
    throw new Error(`Even Hub does not list ${packageId} ${version} on the ${channel} channel.`);
  }
  const pre = channel === 'beta';
  return { id: build.id, pre, tag: `v${version}${pre ? '-beta.1' : ''}` };
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function checkPackageDigests({ channel, version, id, commit, ciDigest, storeDigest }, receipt) {
  if (ciDigest === storeDigest) return;
  if (channel === 'public' && receipt?.packageId === packageId && receipt.version === version
    && receipt.buildId === id && receipt.sourceCommit === commit
    && receipt.ciSha256 === ciDigest && receipt.storeSha256 === storeDigest) return;
  throw new Error('The CI package and Even Hub download differ without a matching reviewed store receipt.');
}

function liveTarget(version, channel) {
  return releaseTarget(JSON.parse(run(hub, ['ls', packageId, '--json'])), version, channel);
}

function compare(from, to) {
  return from === to ? 'identical' : api(`compare/${from}...${to}`).status;
}

function downloadCheckedPackage(branch, commit, directory) {
  const path = `actions/workflows/check.yml/runs?branch=${branch}&head_sha=${commit}&status=success&per_page=100`;
  const checked = api(path).workflow_runs.find(run => run.head_sha === commit && run.head_repository?.full_name === repo
    && ['push', 'workflow_dispatch'].includes(run.event));
  if (!checked) throw new Error(`Wait for Check to succeed on ${branch} at ${commit}.`);
  run('gh', ['run', 'download', String(checked.id), '--repo', repo, '--name', `muse-relay-ehpk-${commit}`, '--dir', directory]);
  return checked.html_url;
}

function releaseFor(tag) {
  const published = optional(`releases/tags/${tag}`);
  if (published) return published;
  // Drafts do not always have a Git tag yet.
  const drafts = run('gh', ['api', '--paginate', `repos/${repo}/releases?per_page=100`, '--jq',
    `.[] | select(.draft and .tag_name == "${tag}") | @json`]);
  if (!drafts) return null;
  const matches = drafts.split('\n');
  if (matches.length !== 1) throw new Error('Several release drafts use the same tag. Inspect them on GitHub.');
  return JSON.parse(matches[0]);
}

function checkExisting(tag, commit, pre, filename, digest) {
  const ref = optional(`git/ref/tags/${tag}`);
  if (ref && api(`commits/${tag}`).sha !== commit) throw new Error('The existing tag refers to a different commit.');
  const release = releaseFor(tag);
  if (!release) return { release: null, asset: null };
  if (release.prerelease !== pre || (release.draft && release.target_commitish !== commit) || (!release.draft && !ref)) {
    throw new Error('The existing release has a different source or release type.');
  }
  const asset = release.assets.find(item => item.name === filename);
  if (asset && asset.digest !== 'sha256:' + digest) throw new Error('An existing release asset has different bytes.');
  if (!release.draft && !asset) throw new Error('The published release is missing its verified package.');
  return { release, asset };
}

async function releaseNotes(version, commit, pre) {
  const path = `changelog/${version}.md`;
  if (!pre) {
    // The candidate is immutable. Store instructions can be corrected after Beta closes.
    try { return await readFile(new URL('../' + path, import.meta.url), 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return sourceText(path, commit);
}

async function record({ channel, commit: argument, publish }) {
  if (!['beta', 'public'].includes(channel) || (argument && !/^[a-f0-9]{40}$/.test(argument))) {
    throw new Error('Usage: node scripts/record-release.mjs --channel beta|public [--commit FULL_PUBLIC_SHA] [--publish]');
  }
  const beta = api('git/ref/heads/beta').object.sha;
  const commit = argument || beta;
  if (!['identical', 'ahead'].includes(compare(commit, beta))) throw new Error('The release commit must belong to the public beta branch.');
  const manifest = JSON.parse(sourceText('app.json', commit));
  if (manifest.package_id !== packageId) throw new Error('Unexpected app at the public commit.');
  const version = manifest.version;
  const { id, pre, tag } = await liveTarget(version, channel);
  const file = `muse-relay-${version}.ehpk`;
  const main = api('git/ref/heads/main').object.sha;
  const canAdvance = ['identical', 'ahead'].includes(compare(main, commit));
  const alreadyOnMain = !pre && !canAdvance && compare(commit, main) === 'ahead';
  if (!pre && !canAdvance && !alreadyOnMain) throw new Error('Merge the latest public main into beta and verify the resulting commit before recording this store release.');
  const directory = await mkdtemp(join(tmpdir(), 'muse-relay-release-'));
  try {
    const verifiedRun = downloadCheckedPackage('beta', commit, directory);
    const storeDir = join(directory, 'store');
    await mkdir(storeDir);
    const hubFile = join(storeDir, file);
    const download = JSON.parse(run(hub, ['download', version, '--package-id', packageId, '--output', hubFile, '--json']));
    const storeBytes = await readFile(hubFile);
    if (!download.ok || download.package_id !== packageId || download.version !== version || download.size !== storeBytes.length) {
      throw new Error('Unexpected Even Hub download metadata.');
    }
    const ciBytes = await readFile(join(directory, file));
    const ciDigest = sha256(ciBytes), digest = sha256(storeBytes);
    let receipt;
    if (!pre && digest !== ciDigest) {
      const path = new URL(`../changelog/${version}.store.json`, import.meta.url);
      try { receipt = JSON.parse(await readFile(path, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    checkPackageDigests({ channel, version, id, commit, ciDigest, storeDigest: digest }, receipt);
    if (alreadyOnMain) {
      const mainDir = join(directory, 'main');
      await mkdir(mainDir);
      downloadCheckedPackage('main', main, mainDir);
      if (!ciBytes.equals(await readFile(join(mainDir, file)))) throw new Error('The more recent main commit builds a different app.');
    }
    const title = pre ? `Muse Relay ${version} (pre-release)` : `Muse Relay ${version}`;
    const changelog = await releaseNotes(version, commit, pre);
    const notes = changelog.trim()
      + `\n\nEven Hub ${channel} · build ${id}\n\nEHPK SHA-256: \`${digest}\`\n`;
    const { release, asset } = checkExisting(tag, commit, pre, file, digest);
    console.log(JSON.stringify({ channel, tag, commit, evenHubBuild: id, ciSha256: ciDigest, sha256: digest, verifiedRun, mode: publish ? 'publish' : 'check' }, null, 2));
    if (!publish || (release && !release.draft)) return;
    if ((await liveTarget(version, channel)).id !== id) throw new Error('The Even Hub channel changed during verification.');
    const draft = release || api('releases', 'POST', { tag_name: tag, target_commitish: commit, name: title, body: notes, draft: true, prerelease: pre, make_latest: 'false' });
    if (!asset) run('gh', ['release', 'upload', tag, hubFile, '--repo', repo]);
    const verified = checkExisting(tag, commit, pre, file, digest);
    if (!verified.asset || verified.release.id !== draft.id) throw new Error('Could not verify the uploaded release asset.');
    if (!pre && canAdvance && main !== commit) api('git/refs/heads/main', 'PATCH', { sha: commit, force: false });
    const result = api(`releases/${draft.id}`, 'PATCH', { body: notes, draft: false, prerelease: pre, make_latest: pre ? 'false' : 'true' });
    console.log(result.html_url);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const { values } = parseArgs({ options: { channel: { type: 'string' }, commit: { type: 'string' }, publish: { type: 'boolean', default: false } } });
    await record(values);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
