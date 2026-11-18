# Privacy notice

Updated: 2026-11-18

Muse Relay is an EvenHub app that connects your phone and Even G2 to a relay you configure. The source includes optional relay and ATOM S3 implementations. The project does not supply a shared relay for all users. You provide the relevant accounts, servers, credentials, and Muse-side processing.

## Data used

| Data | Purpose and destination |
| --- | --- |
| Message text, request identifiers and timestamps | Send requests and display replies through your GitHub Gist or HTTPS relay and Muse |
| Microphone audio | Capture only after you start recording. With Muse transcription, send the recording through your relay. With Soniox, stream audio directly to Soniox and send the resulting text through your relay |
| Selected photos | Resize and send the image you select or capture, when images are enabled |
| Replies, exported Spaces, optional display name and avatar | Read from your configured relay and display in the app; show images when enabled |
| Space controls | Send the selected action and value; a microphone control uses the chosen voice path |
| Connection settings and tokens | Authenticate to the configured services and restore your settings |

Creating instructions for Muse or adding them to a draft does not itself send them. Recording with Soniox sends audio while you speak: cancelling stops further processing in the app but cannot recall audio already sent to Soniox. A submitted request cannot be recalled by hiding it locally.

## Storage and deletion

| Location | What remains and how to remove it |
| --- | --- |
| Even app storage and WebView/browser storage | Settings, credentials, selected Spaces, and reading preferences. A separate local cache contains recent text, exported content, and profile metadata; retrieved image bytes are excluded. Use **Remove saved connection details** to clear connection data and cached content. The app distinguishes an unconfirmed Even-storage update from a successful one |
| Your Gist and watcher | Requests, replies, media, exported content and processing records. Manage these on your own service. Removing current Gist files does not erase Git history or copies |
| Your HTTPS relay | Requests, replies, exported content and attachments. The supplied Node implementation uses a state file; the Cloudflare implementation uses D1 and R2. Stop processing and remove the associated state, objects and backups in that environment |
| Your gadget | Wi-Fi, pairing and relay credentials in device storage. Replacing only the application firmware does not erase those settings |
| Muse, Soniox and hosting providers | Their own processing, retention and account settings apply. Muse Relay cannot erase their records |

Hiding messages and unregistering Spaces changes the app's selection, not the originals. Removing connection details does not revoke issued credentials. Revoke or rotate them with the service or relay that issued them. App-managed settings do not have an additional application-level encryption layer.

The reference relay retains up to 100 messages and attachments that remain referenced. The Gist watcher retains up to 50 messages. These are count limits, not expiration guarantees. Cloudflare attachment collection uses a 24-hour grace period and bounded cleanup; it is not immediate deletion. See [data flow, retention and removal details](docs/data.md).

## Permissions and other services

The setup guide opens in a browser. Its links carry only the selected help section. If you choose to send feedback, the guide stores your message, category, sharing choice, receipt number and submission time in its own database. The form accepts submissions without an account. Sharing an anonymized summary in a public issue is opt-in. The guide removes submissions older than 90 days when it next processes feedback or the maintainer runs cleanup. Keep your receipt for removal requests. [Feedback handling](docs/feedback.md)

The app requests network access, the selected G2 or phone microphone, and photo/camera access for explicit image operations. It does not request location, contacts or an advertising identifier. The exact permissions are in [app.json](app.json).

The app contains no advertising or analytics reporting code and no automatic report upload to the app developer. Operational logs from your relay, SDK, device console or hosting provider are separate. Even and the other services you use may process data under their own terms. Do not include credentials, private messages or raw device logs in public reports.

Secret Gists are accessible to anyone who knows their URL and keep version history. They are not private encrypted storage. [GitHub documentation](https://docs.github.com/en/get-started/writing-on-github/editing-and-sharing-content-with-gists/creating-gists)

Soniox has two authentication options. With **Enter API key**, your personal key is stored in Even app settings and the local device backup and sent only to Soniox. It is never bundled into the shared app or sent to Muse, Gist or your relay. With **Temporary key server**, the long-lived key stays on your server and the phone receives a temporary key. The explicit connection check sends one second of synthetic silence to Soniox, without using the microphone or sending a Muse request. Custom token endpoints have separate authentication; relay credentials are not automatically sent to an unrelated endpoint. Inspect [connection selection](src/core/config.ts), [Soniox streaming](src/core/soniox.ts), [Gist transport](src/relay/gist.ts), [HTTPS transport](src/relay/gadget.ts), and [storage](src/core/persistence.ts).

Personal avatars are supplied through your own relay. They are not bundled into the common app or public source. A published example image does not retrieve or represent your account's avatar.

This notice describes the supplied code. Changes to a handler, relay, firmware or hosting configuration may change its behavior. For a data-removal request, contact the owner of the service holding the data. For an issue in this source, use the repository's reporting options and follow [SECURITY.md](SECURITY.md).
