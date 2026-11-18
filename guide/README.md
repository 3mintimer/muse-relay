# Public guide: development and build

[日本語](README.ja.md)

`web/` contains the public guide. `worker.mjs` serves its assets and the feedback API. Local development and the Sites build use the same request handler. The guide is built separately from the app's EHPK.

## Languages and links

The guide opens in **English by default**. The header offers **English / 日本語** without reloading the page. Direct links support `?lang=en` or `?lang=ja`, followed by any existing anchor:

```text
/?lang=en#setup
/?lang=ja#connection
/#voice
/#relay
/#feedback
```

The language switch preserves the selected relay, voice mode, image setting, tutorial step, HUD state, feedback draft, and sharing consent. Only the language is written to the URL. Drafts, connection settings, and consent are not stored or included in URLs. Changing language does not submit the form or call an external service.

| File | Responsibility |
| --- | --- |
| `web/index.html` | English initial content, semantic markup, and explicit translation hooks |
| `web/app.js` | Shared interaction, setup, prompt-generation, and feedback logic |
| `web/i18n.js` | Locale selection, numbered placeholders, explicit DOM hooks, and document links |
| `web/messages.js` | Japanese translations keyed by the canonical English messages |
| `web/style.css` | Shared light/dark and responsive styles |

Translate complete messages, including ARIA labels, errors, and AI instructions. Keep numbered `{0}` placeholders unchanged; literal protocol JSON is not a placeholder. Do not translate user-entered feedback. English GitHub links use canonical `.md` files. Japanese links use `.ja.md` only for paths listed in `i18n.js`; other technical references keep their canonical URL. No separate page or duplicated interaction logic is needed.

## Run locally

Use Node.js 24 or later and run from the repository root:

```sh
npm --prefix guide ci
npm --prefix guide run dev
```

Open [http://127.0.0.1:5188](http://127.0.0.1:5188). Reload after editing `web/`. To change the port, use `GUIDE_PORT=5190 npm --prefix guide run dev`. The server binds only to loopback.

| Local feedback | Behavior |
| --- | --- |
| Database | In-memory database with migrations applied; discarded on shutdown |
| Secret | Generated at startup; never printed or saved |
| Destination | Local `/api/feedback` only |
| Rate limit | Shared loopback bucket; restart dev after testing three submissions per hour |

Use synthetic feedback only. Local development does not connect to production D1 or GitHub.

## Check and build

```sh
npm --prefix guide test
npm --prefix guide run build
```

```text
guide/dist/
├── server/index.js
└── .openai/
    ├── hosting.json
    └── drizzle/
        ├── 0000_feedback.sql
        └── meta/
```

The build embeds public `web/` assets in a Worker ES module. It accepts approved extensions such as HTML, JavaScript, CSS, images, fonts, and public JSON; excludes hidden files; and rejects symlinks. Personal configuration, databases, and secrets are not included. Limits are 2 MB per file and 8 MB total. Also check the hosting provider's Worker size limit when adding assets.

Use `npm --prefix guide run build -- --outdir /absolute/path/to/dist` for a different output directory. Keep it separate from the app's root `dist/`.

| Route or policy | Behavior |
| --- | --- |
| `/` and public files | GET / HEAD, with ETag-based 304 responses; language query parameters use the same assets |
| Unknown path | 404 |
| Unsupported method | 405 with an Allow header |
| `/api/feedback` | Delegates to `handleFeedback`; POST only |
| CSP | Scripts, styles, and connections restricted to the same origin; no iframe embedding |
| Other headers | `Referrer-Policy: no-referrer`, `nosniff`; input values are not logged |

For a focused UI check, switch languages with a synthetic draft and unchecked/checked consent, then exercise all relay and voice modes. Check the five anchors, all prompt topics, and translated error states. Use a local fake response when testing form rendering; do not submit test feedback to production. Browser layout and physical-device behavior are separate checks.

## Separate Sites checkout

The maintainer creates, syncs, and deploys the Site. This public source contains no particular Site ID.

1. Copy this `guide/` into the registered Site's checkout. Preserve that checkout's `.openai/hosting.json`.
2. Use a Worker manifest without `static`, and bind D1 as `DB`. Unused R2 is `null`.
3. Set `FEEDBACK_RATE_SECRET` as a Sites secret: a random value of at least 32 characters. Do not include it in browser assets, source, or build output.
4. In the checkout, run `npm ci`, `npm test`, and `npm run build`, then deploy through the normal Sites workflow.

The build first reads `.openai/hosting.json` in the working directory, then beside the build script. If neither exists, it uses `hosting.example.json` with `{d1:"DB",r2:null}`. Existing fields such as `project_id` are preserved. An example-only build has no Site ID and is not ready for production deployment.

For schema changes, run `npm --prefix guide run db:generate` to add a schema-only migration. Do not rewrite applied migrations. Sites applies the migrations in `dist/.openai/drizzle/` during deployment.

See [docs/feedback.md](https://github.com/3mintimer/muse-relay/blob/main/docs/feedback.md) for submission limits, consent, retention, deletion, and production verification.
