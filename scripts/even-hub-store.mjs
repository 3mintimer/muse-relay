// After Beta is withdrawn, the CLI can report Approved for a build still in the store.
export async function isPublicStoreBuild(packageId, build, request = fetch) {
  if (!build?.channels?.includes('public') || !Number.isSafeInteger(build.id) || build.id <= 0) return false;
  if (build.status === 'Published') return true;
  if (build.status !== 'Approved' || !Number.isSafeInteger(build.size) || build.size <= 0 || !build.created_at) return false;

  const url = new URL('https://hub.evenrealities.com/api/v1/storefront/detail');
  url.searchParams.set('package_id', packageId);
  const response = await request(url, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Even Hub catalogue returned HTTP ${response.status}.`);
  const { code, data } = await response.json();
  const listed = data?.version;
  return code === 0 && data?.package_id === packageId && listed?.branch_name === 'public'
    && listed.version === build.version && listed.file_size === build.size && listed.created_at === build.created_at;
}
