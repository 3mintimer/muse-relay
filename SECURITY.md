# Security

## Reporting

Use **Security → Report a vulnerability** if private vulnerability reporting is enabled on the published repository. If that option is absent, open an issue requesting a private contact channel without including the exploit, credentials, private URLs or user data. Do not post raw logs or connection exports publicly.

Include the affected version or commit, component, expected and observed behavior, and minimal steps using synthetic data. This project does not promise a response time. Fixes are made against the maintained source; support for older installed builds is not guaranteed.

## Boundaries

| Boundary | Implementation and limitation |
| --- | --- |
| App to relay | HTTPS is required except loopback development addresses. Credentials go to the configured endpoint. The user must trust that endpoint. [Configuration](src/core/config.ts), [transport](src/relay/gadget.ts) |
| Gist | The GitHub token authenticates API reads and writes. Raw content is restricted to the expected HTTPS host and fetched without that token. Secret Gists remain readable by URL. [Transport](src/relay/gist.ts) |
| Relay roles | Separate bearer tokens for phone, device and Muse publishing; configured browser origins and bounded requests. CORS is not authentication. [Node adapter](server/app.mjs), [Worker adapter](server/cloudflare/worker.mjs), [validation](server/core.mjs) |
| Muse replies | A dedicated session and message identifiers correlate replies with requests. Unknown execution outcomes are not silently replayed after device delivery. [State machine](server/core.mjs), [firmware parser](firmware/components/muse_relay/chat_filter.c) |
| Soniox | User-entered personal key in app storage, sent only to Soniox; or a server-held key with temporary keys on the phone. Never bundle a key. Custom token endpoints have separate credentials. [App](src/core/soniox.ts), [server](server/app.mjs) |
| Stored credentials | App storage and reference state files are not an application-level encrypted vault. The reference ATOM build does not enable Secure Boot or flash encryption. Physical device and host access must be controlled by the owner |
| Muse-side actions | The user supplies the handler and its permissions. Space controls may ask that handler to perform actions. Review its behavior before connecting it. [Gist handler](adapters/gist/README.md), [space protocol](docs/spaces.md) |

Do not commit credentials, user conversations, production exports, flash backups or raw console logs. If a credential is exposed, revoke or rotate it before removing the copy. Removing a file, changing an app setting or rewriting Git history alone does not revoke a credential.

The source can be inspected and tested; that is not a guarantee that every dependency, provider or deployment is secure. [Privacy](PRIVACY.md) · [Data handling](docs/data.md) · [Source and build procedure](docs/public-source.md)
