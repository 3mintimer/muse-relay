# Public guide: development and build

[日本語](README.ja.md)

`web/` contains the public guide. `worker.mjs` serves its assets and the feedback API. Local development and the Sites build use the same request handler. The guide is built separately from the app's EHPK.

## Languages and links

The guide uses the same nine language codes as the app. **English is the default** at `/`; `/en/` is an alias. The language menu uses each language's own name and ordinary links. Every language URL returns translated HTML before JavaScript runs. The direct **日本語** link remains available on the landing page.

| Code | Menu label | Direct path |
| --- | --- | --- |
| `en` | English | `/` (`/en/` alias) |
| `zh-Hans` | 简体中文 | `/zh-Hans/` |
| `zh-Hant` | 繁體中文 | `/zh-Hant/` |
| `ja` | 日本語 | `/ja/` |
| `es` | Español | `/es/` |
| `fr` | Français | `/fr/` |
| `de` | Deutsch | `/de/` |
| `it` | Italiano | `/it/` |
| `ko` | 한국어 | `/ko/` |

With JavaScript, selecting a language updates the same page. Without it, the links navigate normally. A valid `?lang=<code>` takes precedence over the path; existing English and Japanese query links remain compatible. Keep existing anchors:

```text
/#setup
/ja/#connection
/?lang=ja#connection
/ja/#g2muse
/zh-Hant/#voice
/fr/#feedback
/#voice
/#relay
/#feedback
```

The same-page language switch preserves the theme, selected relay, voice mode, image setting, tutorial step, HUD state, feedback draft, and sharing consent. Only the language path and existing fragment are written to the URL. Drafts, connection settings, and consent are not stored or included in URLs. Loading a translation uses only this site's assets; changing language does not submit the form or call an external service. A direct URL determines the language; there is no stored language override.

| File | Responsibility |
| --- | --- |
| `web/index.html` | English initial content, semantic markup, and explicit translation hooks |
| `web/app.js` | Shared interaction, setup, prompt-generation, and feedback logic |
| `web/i18n.js` | Asynchronous dictionary preparation, message lookup, explicit DOM hooks, and document links |
| `web/language.js` | The nine menu names, URL rules, and valid page paths shared by the browser and Worker |
| `web/messages.js` | Japanese translations keyed by the canonical English messages |
| `web/locales/<code>.js` | Full dictionaries for Chinese, Spanish, French, German, Italian, and Korean |
| `web/style.css` | Shared light/dark and responsive styles |
| `localized-html.mjs` | Build-time rendering of the same template into every supported language |
| `routes.test.mjs` | Locale contracts, dictionary completeness, translated HTML, and route/cache compatibility |

Call `await prepareLocale(code)` before using `messageFor(key, code)` or switching the active dictionary. `setLocale`, `getLocale`, and `t` retain the shared interaction API. Each non-English dictionary covers the full canonical set in `messages.js` (currently 504 messages), including ARIA labels, examples, errors, and AI instructions. Keep numbered `{0}` placeholders and protocol identifiers unchanged. Space-creation instructions must request content in the selected language.

Put `data-i18n` only on text-only elements; the build rejects nested markup under this hook. Do not translate user-entered feedback. English and other non-Japanese pages link to canonical English `.md` files. Japanese pages use `.ja.md` only for paths listed in `i18n.js`; other references keep their canonical URL. The build generates each language's HTML in the asset map from one template. Do not maintain translated HTML copies.

Core technical references: [relay setup](https://github.com/3mintimer/muse-relay/blob/main/docs/relay-setup.md) and [protocol](https://github.com/3mintimer/muse-relay/blob/main/docs/protocol.md).

After choosing a route, Ask Muse leads directly to the copy action. The full request, API contract, and reference implementation are collapsed. A clipboard failure opens and selects the full request for manual copying. `/#g2muse` and `/ja/#g2muse` select the existing-G2Muse request and Gist route; other routes hide that shortcut. The reuse request preserves the current writer, settings, and legacy files, and limits cleanup to confirmed requests and their owned attachments.

The first-use checks are separate disclosures for saving the active relay, a matching text reply, voice transcript and reply, and mobile-data access. Troubleshooting, audio routes, and image requirements stay collapsed. The guide never connects to a user's relay or sends its AI request automatically.

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
| `/`, `/en/`, each `/<code>/`, legacy language queries | Localized HTML, `Content-Language`, and separate ETags; GET / HEAD |
| `/ja`, `/ja/index.html`, `/index.html?lang=ja` | Existing Japanese links continue to work |
| Public files | GET / HEAD, with ETag-based 304 responses |
| Unknown path | 404 |
| Unsupported method | 405 with an Allow header |
| `/api/feedback` | Delegates to `handleFeedback`; POST only |
| CSP | Scripts, styles, and connections restricted to the same origin; no iframe embedding |
| Other headers | `Referrer-Policy: no-referrer`, `nosniff`; input values are not logged |

The route suite contains four tests: nine-language URL/app compatibility, all dictionary keys and numbered placeholders, translated HTML without JavaScript, and legacy links/conditional requests. It compares with `../src/core/i18n.ts` when run in the app repository; an independent Sites checkout needs no app source. The existing feedback test remains separate.

For focused browser QA, switch languages with a synthetic draft, selected theme, and checked/unchecked consent. Check a setup/copy flow, the G2Muse shortcut, mobile layout, and one translated error using a local fake response. Do not submit test feedback to production. Browser layout and physical-device behavior are separate checks.

## Separate Sites checkout

The maintainer creates, syncs, and deploys the Site. This public source contains no particular Site ID.

1. Copy this `guide/` into the registered Site's checkout. Preserve that checkout's `.openai/hosting.json`.
2. Use a Worker manifest without `static`, and bind D1 as `DB`. Unused R2 is `null`.
3. Set `FEEDBACK_RATE_SECRET` as a Sites secret: a random value of at least 32 characters. Do not include it in browser assets, source, or build output.
4. In the checkout, run `npm ci`, `npm test`, and `npm run build`, then deploy through the normal Sites workflow.

The build first reads `.openai/hosting.json` in the working directory, then beside the build script. If neither exists, it uses `hosting.example.json` with `{d1:"DB",r2:null}`. Existing fields such as `project_id` are preserved. An example-only build has no Site ID and is not ready for production deployment.

For schema changes, run `npm --prefix guide run db:generate` to add a schema-only migration. Do not rewrite applied migrations. Sites applies the migrations in `dist/.openai/drizzle/` during deployment.

See [docs/feedback.md](https://github.com/3mintimer/muse-relay/blob/main/docs/feedback.md) for submission limits, consent, retention, deletion, and production verification.
