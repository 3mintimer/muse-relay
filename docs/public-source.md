# Export and reproduce the public source

[English](public-source.md) · [日本語](public-source.ja.md)

Public source includes the shared app, reference relays, ATOM S3, guide, tests using dummy data only, licenses, and community configuration. See [PUBLIC-SOURCE.md](../PUBLIC-SOURCE.md) for scope and [public-source-files.json](../scripts/public-source-files.json) for the file allowlist.

## Export source

Use Node.js 24 and npm. From the root, export the allowed files rather than copying the development directory:

```sh
node scripts/export-public.mjs --check
node scripts/export-public.mjs --out ../muse-relay-public
```

Create the destination's parent directory first. The destination must not exist or must be an empty regular directory. The exporter refuses a directory with existing files or a symlink. After a failed export, inspect its contents and choose another empty directory.

| Stage | Behavior |
| --- | --- |
| Selection | Reads only allowlisted files; does not automatically include Git-tracked files, history, or untracked files |
| Audit | Checks common secret patterns, personal absolute paths, unapproved hosts, image metadata, and example credentials |
| Links | Checks relative Markdown/HTML links and anchors within the export; does not verify external service availability |
| Export | Creates each file without modifying originals; excludes history, Git settings, development records, and personal settings |
| Hashes | Writes relative paths and SHA-256 values to `PUBLIC-SOURCE-MANIFEST.json`, without device names, usernames, or local paths |

Findings show only the filename and category. Review new hosts and files before adding them to the allowlist. Automated checks alone do not guarantee that personal information is absent.

## Build the exported source

Run in the exported directory. Install dependencies from each lockfile:

```sh
npm ci
npm test
npm run build
npm run pack
```

| Command | Output / check |
| --- | --- |
| `npm test` | Existing app-state, interaction, image, and relay tests; no requests to real accounts or devices |
| `npm run build` | TypeScript checks and Vite build, producing `dist/` |
| `npm run pack` | Produces `artifacts/muse-relay-<version>.ehpk` using the version in `app.json` |
| `npm run dev` | Opens settings and screens in a regular browser |

Dependencies, caches, and build artifacts are not in the source allowlist. After verification, export again to a new empty directory for publication. This setup does not guarantee byte-identical binaries.

## Optional components

| Component | Instructions |
| --- | --- |
| Node relay | `npm run relay:setup`, `npm run relay:start`. [HTTPS deployment](server.md) |
| Cloudflare Worker | `npm --prefix server/cloudflare ci`, `npm --prefix server/cloudflare run build`. [D1 and R2 configuration](../server/cloudflare/README.md) |
| Gist watcher | Configure your environment variables and handler. [Input and startup](../adapters/gist/README.md) |
| ATOM S3 | Install ESP-IDF 6.0.3, then run `firmware/tools/build.sh` and `python3 firmware/tools/package.py`. [Build and USB setup](atoms3.md) |
| Public guide | [Build and development instructions](../guide/README.md). Supply hosting and feedback storage separately |

Other relays work with the same app when they follow [protocol.md](protocol.md). SDKs, servers, accounts, and keys are user-specific. Flashing hardware or deploying external services is a separate operation from exporting source.

## Verification scope

[CI](../.github/workflows/check.yml) runs app and reference-relay tests, creates the EHPK, and tests and builds the feedback guide.

| Configuration | Verified scope |
| --- | --- |
| HTTPS relay + ATOM S3 at home | Sent successive text requests from a paired device to the same Muse chat and received the corresponding replies. Also received a reply correlated to a synthesized WAV request |
| Gist | Synthetic data verified the reference watcher's request handling and result publication. Verify your own Muse handler round trip with your own Gist |
| HTTPS relay + Linux | Official SDK documentation covers dedicated-chat sending and reply collection. The round trip through a Linux machine and G2 has not been verified. [Linux SDK](https://github.com/facebookincubator/muse-gadget-sdk/tree/main/linux) |

For a custom relay, send a short message from G2 and confirm that the Muse reply reaches the app with the original request ID. Test away-from-home use by switching the phone to mobile data.

The public repository is [3mintimer/muse-relay](https://github.com/3mintimer/muse-relay). The exporter does not initialize Git, authenticate, commit, push, or deploy. Preserve [LICENSE](../LICENSE), [NOTICE.md](../NOTICE.md), and SDK attribution.
