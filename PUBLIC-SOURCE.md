# Public source scope

The public repository contains the common EvenHub app, optional relay and ATOM S3 implementations, documentation, the public guide, synthetic tests and license notices. Each user supplies their own services and credentials.

The authoritative file list is [scripts/public-source-files.json](scripts/public-source-files.json). [scripts/export-public.mjs](scripts/export-public.mjs) reads only those files and writes them to an empty directory. New files require an explicit entry and review.

| Included | Excluded |
| --- | --- |
| App source, manifest and lockfiles | Git history, Git configuration and author metadata |
| Gist / HTTPS / ATOM source and setup examples | Personal relay sites, credentials, device configuration and flash backups |
| Synthetic tests and schema migrations | Conversation exports, personal images, audio and raw logs |
| Active app icon and original public-guide assets | Unused icon candidates, development records and old store materials |
| Public guide and feedback implementation | Feedback database contents, service identifiers and hosting secrets |
| Community templates and license texts | Dependencies, caches and generated build/package output |

The exporter rejects symbolic links, nonempty destinations, unreviewed hosts, common credential patterns and personal absolute paths. Its diagnostics name the file and category, not the matched value. It also checks local Markdown/HTML links. These checks supplement review; they do not prove that arbitrary text or images contain no private data.

The export contains a checksum manifest with relative filenames and SHA-256 hashes. It contains no source-machine path, account configuration, commit identity or timestamp. File modes are normalized, retaining only whether a source file is executable.

Do not publish a copy of the development directory or its Git repository. Export into a new empty directory, build and inspect that copy, and publish only the reviewed source. Existing local assets and history remain unchanged. The exporter does not initialize Git, set a remote, commit, push or deploy.

[Export and build procedure](docs/public-source.md) · [Privacy](PRIVACY.md) · [Security](SECURITY.md)
