import { t, getLocale, setLocale, prepareLocale, translatePage, docHref, localizeDocText } from './i18n.js';
import { languages, languageFromUrl, languageHref } from './language.js';

// Static guide state only. Connection details and feedback drafts are never stored.
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const repo = 'https://github.com/3mintimer/muse-relay';
const sdk = 'https://github.com/facebookincubator/muse-gadget-sdk';
const state = { route: 'gist', voice: 'muse', images: false, step: 0, topic: 'connection', preset: 'schedule' };
const el = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
};
function link(text, href) {
  const a = el('a', text); a.href = docHref(href);
  if (href.startsWith('https://')) { a.target = '_blank'; a.rel = 'noopener'; }
  return a;
}
function replaceList(target, items) { $(target).replaceChildren(...items.map(text => el('li', text))); }
function setPairs(target, pairs) { $(target).replaceChildren(...pairs.flatMap(([label, value]) => [el('dt', label), el('dd', value)])); }
const routes = () => ({
  gist: {
    name: 'GitHub Gist', app: 'GitHub Gist', medium: 'Gist', device: t("Handler"),
    supplies: [t("Your secret GitHub Gist and a token with gist scope"), t("A watcher and handler that forward new requests to Muse")],
    note: t("Anyone with the secret Gist URL can read it. Audio and images may remain in revision history."),
    flow: [['G2', t("Display · voice")], [t("Phone"), 'Muse Relay'], ['Gist', t("Your storage")], [t("Handler"), t("You provide")], ['Muse', t("Process · reply")]],
    fields: [[t("Gist ID or URL"), t("Your Gist")], [t("GitHub token"), t("Your token with gist scope")]],
    input: 'muse-relay-request-<id>.json',
    output: 'g2muse-relay.json\nmuse-relay-spaces.json\nmuse-relay-profile.json',
    inputDetail: t("Read one file per request. Audio and images reference separate base64 files."),
    outputDetail: t("Use one writer, preserve existing data, and set reply_to to the original request ID."),
  },
  atom: {
    name: t("ATOM S3 at home"), app: 'Muse Gadget SDK', medium: t("HTTPS relay"), device: 'ATOM S3',
    supplies: [t("An HTTPS relay reachable away from home, with separate access keys for each role"), t("ATOM S3, USB power, and 2.4 GHz Wi-Fi"), t("A Muse Gadget SDK token and pairing with Muse")],
    note: t("ATOM connects outward from home to your relay. Do not enter its LAN IP on your phone. No port forwarding to ATOM is needed."),
    flow: [['G2', t("Display · voice")], [t("Phone"), 'Muse Relay'], ['HTTPS', t("Your relay")], ['ATOM S3', t("Home · outbound")], ['Muse', t("Via SDK")]],
    fields: [[t("Relay server URL"), t("HTTPS reachable away from home")], [t("Phone access token"), t("App access key")]],
    input: 'POST /v1/requests',
    output: 'GET /v1/snapshot\nGET /v1/files/:name',
    inputDetail: t("Send with the phone key. ATOM retrieves requests using its separate device key."),
    outputDetail: t("The app reads here. Muse publishes additional output with its writer key to /v1/messages, /v1/spaces/:id, and /v1/profile."),
  },
  linux: {
    name: 'Linux / Raspberry Pi', app: 'Muse Gadget SDK', medium: t("HTTPS relay"), device: 'Linux',
    supplies: [t("A Linux machine and pairing environment supported by the official Linux SDK"), t("Muse Gadget SDK token"), t("An HTTPS relay and an adapter connecting it to SDK chat input and output")],
    note: t("The official SDK supports Linux. A Muse Relay Linux adapter is not bundled, and this integration has not been tested on hardware."),
    flow: [['G2', t("Display · voice")], [t("Phone"), 'Muse Relay'], ['HTTPS', t("Your relay")], ['Linux', t("Home · outbound")], ['Muse', t("Via SDK")]],
    fields: [[t("Relay server URL"), t("Your implemented HTTPS interface")], [t("Phone access token"), t("App access key")]],
    input: 'POST /v1/requests',
    output: 'GET /v1/snapshot\nGET /v1/files/:name',
    inputDetail: t("The app uses the same HTTP contract as Gadget mode. Implement the Linux SDK adapter separately."),
    outputDetail: t("Convert SDK replies to the public message format; this does not forward device display commands."),
  },
});
const voiceName = () => state.voice === 'muse' ? t("Transcribe via relay") : state.voice === 'soniox-key' ? t("Soniox · Enter API key") : t("Soniox · Temporary key server");
const gadgetVoice = () => t("A compatible HTTPS relay shows live captions while you speak and sends final text to Muse. Other relays receive a WAV on send.");

function renderRoute() {
  const route = routes()[state.route];
  $$('[data-gist-only]').forEach(node => { node.hidden = state.route !== 'gist'; });
  $('#flow-choice').textContent = route.name;
  $('#main-flow').replaceChildren(...route.flow.map(([title, subtitle]) => {
    const item = el('li'); item.append(el('strong', title), el('span', subtitle)); return item;
  }));
  $('#main-flow').setAttribute('aria-label', t("Connect in this order: {0}. Send requests and read replies.", [route.flow.map(node => node[0]).join(' → ')]));
  replaceList('#supplies', route.supplies);
  $('#app-route').textContent = t("Relay → {0}", [route.app]);
  $('#route-note').textContent = route.note;
  $('#input-title').textContent = state.route === 'gist' ? t("One JSON file per request") : t("Requests from the app");
  $('#output-title').textContent = state.route === 'gist' ? t("Replies, Spaces, and profile") : t("Display data read by the app");
  $('#input-contract').textContent = route.input;
  $('#output-contract').textContent = route.output;
  $('#input-detail').textContent = route.inputDetail;
  $('#output-detail').textContent = route.outputDetail;
  $('#implementation-name').textContent = route.name;
  renderImplementation(); renderStep(); renderVoice(); renderPrompt();
}

function stepContent() {
  const route = routes()[state.route];
  const isGist = state.route === 'gist';
  if (state.step === 0) return {
    title: t("Choose {0}", [route.app]),
    actions: [t("Under Relay, select {0}.", [route.app]), state.route === 'linux' ? t("There is no separate Linux option in the app. Once your adapter is implemented, use the same Gadget connection.") : t("Select Next to open Connection.")],
    fields: [[t("Relay"), route.app], [t("Next"), '→']], link: [t("Need a relay first? →"), '#relay'],
  };
  if (state.step === 1) return {
    title: isGist ? t("Enter your Gist and token") : t("Import the phone connection settings"),
    actions: isGist ? [t("Enter your own Gist ID or URL."), t("Enter your personal GitHub token in GitHub token."), t("For a new Gist, open Create your first Gist and copy the filename and initial content.")]
      : [t("On your relay setup page, use Copy settings for the phone."), t("In Muse Relay, paste into Import connection settings, then select Import."), t("For manual setup, enter Relay server URL and Phone access token.")],
    fields: route.fields, link: isGist ? [t("Initial Gist file and watcher →"), '#relay'] : [t("HTTPS relay and access keys →"), '#relay'],
  };
  if (state.step === 2) return {
    title: t("Choose transcription and microphone"),
    actions: [t("Choose Transcription service, then set Microphone to G2 glasses or Phone."), state.voice === 'muse'
      ? isGist ? t("The WAV goes to the relay when you send. There are no captions while recording.") : gadgetVoice()
      : t("Set the Soniox connection method, then select Check Soniox connection."), t("Turn on Enable images only if needed. Copy the Muse instructions after choosing these settings.")],
    fields: [[t("Transcription service"), state.voice === 'muse' ? t("Transcribe via relay") : t("Soniox (direct from app)")], [t("Microphone"), t("G2 glasses / Phone")], [t("Enable images"), state.images ? t("On") : t("Off")]], link: [t("Audio routes and settings →"), '#voice'],
  };
  return {
    title: t("Check the connection and save"),
    actions: [t("Copy Setup instructions for Muse and prepare your Muse-side processing."), t("Select Check connection to read from the relay. After it succeeds, select Save and open."), t("Send a short chat message and check your input and the matching Muse reply.")],
    fields: [[t("Check connection"), t("Read from relay")], [t("Save and open"), t("Save settings")], [t("Send in Chat"), t("Check Muse's reply")]], link: [t("Create instructions for these settings →"), '#relay'],
  };
}
function renderStep() {
  const titles = [t("Relay"), t("Connection"), t("Voice & images"), t("Check")];
  const content = stepContent();
  $$('[data-step]').forEach(button => {
    const selected = Number(button.dataset.step) === state.step;
    button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected));
  });
  $('#connection-place').textContent = `Muse Relay / ${titles[state.step]}`;
  $('#step-title').textContent = content.title; replaceList('#step-actions', content.actions);
  $('#app-fields').replaceChildren(...content.fields.map(([label, value]) => {
    const row = el('div', undefined, 'preview-row'); row.append(el('span', label), el('strong', value)); return row;
  }));
  $('#step-link').textContent = content.link[0]; $('#step-link').href = content.link[1];
  $('#step-position').textContent = `${state.step + 1} / 4`;
  $('#step-prev').disabled = state.step === 0; $('#step-next').disabled = state.step === 3;
  $('#step-next').textContent = state.step === 3 ? t("Final step") : t("Next step");
}

function renderVoice() {
  const isGist = state.route === 'gist';
  $('#relay-voice-description').textContent = isGist ? t("Record, then send") : t("Live captions on compatible HTTPS relays");
  let flow, settings, keyFlow;
  if (state.voice === 'muse') {
    $('#voice-title').textContent = isGist ? t("Send the audio file on submit") : t("Send voice through your relay");
    flow = [t("G2 / phone"), isGist ? t("On send →") : t("Audio →"), routes()[state.route].medium, '→', isGist ? t("Muse-side handler") : `${routes()[state.route].device} → Muse`];
    keyFlow = isGist ? t("No captions appear while recording. A returned transcript appears in chat when available.") : gadgetVoice();
    settings = [[t("App selection"), t("Transcribe via relay")], [t("Recording limit"), t("120 seconds") + " · Beta 0.3.13+"]];
    if (isGist) settings.push([t("Processing"), t("Implement transcription in the Muse-side handler")]);
  } else {
    $('#voice-title').textContent = t("Show words on G2 and phone as you speak");
    flow = [t("G2 / phone"), t("Audio →"), 'Soniox', t("Text →"), t("App"), t("Final text →"), routes()[state.route].medium];
    keyFlow = state.voice === 'soniox-key' ? t("Your personal API key is saved in app settings and used only for Soniox. It is not sent to Muse, Gist, or the relay.")
      : t("Key route: app → token server → temporary key. Audio does not pass through that server.");
    settings = [[t("Transcription service"), t("Soniox (direct from app)")], [t("Soniox connection"), state.voice === 'soniox-key' ? t("Enter API key") : t("Temporary key server")]];
    if (state.voice === 'soniox-key') settings.push([t("Where to enter it"), t("Soniox API key in the app")], [t("Key storage"), t("Even app settings and device backup")]);
    else settings.push([t("Token endpoint"), isGist ? t("Set your Temporary key endpoint and its access token") : t("The reference relay uses /v1/soniox-token automatically")], [t("Long-term key"), t("Token server only")]);
    settings.push([t("Check action"), t("Check Soniox connection")], [t("Test data"), t("One second of silence. No microphone or Muse; this may count toward Soniox usage.")]);
  }
  $('#voice-flow').replaceChildren(...flow.map((part, i) => el(i % 2 === 0 ? 'span' : 'b', part)));
  $('#voice-flow').setAttribute('aria-label', flow.join(' '));
  $('#voice-key-flow').textContent = keyFlow; setPairs('#voice-settings', settings);
}

async function copyText(text, target, status) {
  try { await navigator.clipboard.writeText(text); status.textContent = target ? t("Copied. Paste into Muse and send.") : t("Copied. Paste into your AI or the appropriate setup page."); }
  catch {
    const disclosure = target?.closest('details');
    if (disclosure) disclosure.open = true;
    target?.focus(); target?.select();
    status.textContent = target ? t("Text selected. Use your device's Copy action.") : t("Could not copy. Select the displayed command and copy it manually.");
  }
}
function codeBlock(command) {
  const block = el('div', undefined, 'code-block');
  const code = el('code', command), button = el('button', t("Copy")), status = el('span', undefined, 'sr-only');
  button.type = 'button'; button.setAttribute('aria-label', t("Copy command")); status.setAttribute('role', 'status');
  button.addEventListener('click', () => { void copyText(command, null, status); }); block.append(code, button, status); return block;
}
function renderImplementation() {
  const body = $('#implementation-body'); body.replaceChildren();
  const steps = el('ol', undefined, 'implementation-steps');
  const item = (title, text) => { const li = el('li'); li.append(el('strong', title), el('span', text, 'small')); return li; };
  const links = el('div', undefined, 'doc-links');
  if (state.route === 'gist') {
    steps.append(item(t("1. Create a Gist"), t("Start g2muse-relay.json with {\"messages\":[]}. Do not overwrite an existing Gist.")), item(t("2. Add the handler"), t("Implement MUSE_HANDLER yourself or ask Muse to create it. The reference watcher alone does not connect to Muse.")), item(t("3. Keep it running"), t("Save secrets in .local/gist-watcher.env and start the watcher. It calls Muse only when there is a new request.")));
    body.append(steps, codeBlock('node --env-file=.local/gist-watcher.env adapters/gist/watcher.mjs'));
    body.append(el('p', t("Requires Node.js 22 or later. Existing G2Muse messages can be read, but its old watcher must support Muse Relay's separate request files."), 'small muted'));
    links.append(link(t("Create a Gist ↗"), 'https://gist.github.com/'), link(t("Set up the watcher ↗"), `${repo}/blob/main/adapters/gist/README.md`), link(t("GitHub's Gist guide ↗"), 'https://docs.github.com/en/get-started/writing-on-github/editing-and-sharing-content-with-gists/creating-gists'));
  } else if (state.route === 'atom') {
    steps.append(item(t("1. HTTPS relay"), t("Use the reference server's local setup UI to set the public HTTPS URL and allowed origins. Keep phone, device, and Muse keys separate.")), item('2. ATOM S3', t("Flash the reference firmware. Save the relay URL, device key, and SDK token in USB setup, then pair in Muse.")), item(t("3. Leave it at home"), t("Keep USB power and Wi-Fi on. Your phone connects to the relay while you are away; ATOM connects to the same relay from home.")));
    body.append(steps, codeBlock('node server/setup.mjs'), el('p', t("Run from the project root and open http://127.0.0.1:8788. This is a setup page; deploy your HTTPS hosting separately."), 'small muted'));
    links.append(link(t("Server setup and HTTPS deployment ↗"), `${repo}/blob/main/docs/server.md`), link(t("ATOM flashing and USB setup ↗"), `${repo}/blob/main/docs/atoms3.md`), link(t("Reproduction steps and verification scope ↗"), `${repo}/blob/main/docs/public-source.md`));
    body.append(el('p', t("Verified reference setup: a physical ATOM S3 exchanged text and received matching replies to synthetic WAV input from Muse. This does not verify the G2's physical microphone or every user's environment."), 'small muted'));
  } else {
    steps.append(item(t("1. Check an SDK round trip"), t("Follow the official BLE pairing steps. Run the command below with a fresh dedicated conversation ID and check its matching reply.")), item(t("2. Connect HTTP input and output"), t("Implement an adapter that forwards POST /v1/requests to the SDK, then saves the reply with reply_to set to the original request ID.")), item(t("3. Acceptance check"), t("GET /v1/snapshot must return the matching Muse reply and the app must display it. Do not mix replies from other conversations or requests.")));
    const pairing = el('div', undefined, 'voice-diagram'); pairing.setAttribute('aria-label', t("Initial BLE pairing from the Muse app to the Linux machine at home"));
    pairing.append(el('b', t("Initial setup")), el('span', t("Muse app")), el('b', 'BLE →'), el('span', t("Home Linux")));
    const away = el('div', undefined, 'voice-diagram'); away.setAttribute('aria-label', t("The phone away from home and Linux at home connect to the HTTPS relay; Linux connects to Muse"));
    away.append(el('b', t("Away from home")), el('span', t("Phone")), el('b', '→'), el('span', t("HTTPS relay")), el('b', '←'), el('span', t("Home Linux")), el('b', '→'), el('span', 'Muse'));
    body.append(steps, pairing, away, el('p', t("After initial pairing, Linux makes outbound connections from home. Your phone does not need to stay within its BLE range."), 'small muted'),
      codeBlock(t("musegadget send-user-msg --session-id \"<NEW_UUID>\" --wait 60 \"test\"")),
      el('p', t("Replace <NEW_UUID> with a freshly generated test UUID. This sends to Muse and waits up to 60 seconds. After the CLI reply succeeds, send a new test request through the HTTP interface too."), 'small muted'));
    links.append(link(t("Official CLI documentation ↗"), `${sdk}/blob/main/linux/README.md#hack-and-extend-it`), link(t("Official bridge example ↗"), `${sdk}/blob/main/linux/examples/pebble_ring_bridge.py`), link(t("App HTTP contract ↗"), `${repo}/blob/main/docs/protocol.md`));
  }
  body.append(links);
}

const contractLink = `${repo}/blob/main/docs/protocol.md`;
const safeConfiguration = () => t("Read endpoints and credentials through secure setup or secret configuration. Do not put tokens in chat, public code, logs, or Gist content. Keep personal endpoints out of the shared EvenHub app; do not change the app.");
function transportPrompt() {
  if (state.route === 'gist') return t("Use GitHub Gist. Only for a new Gist, initialize g2muse-relay.json with {\"messages\":[]}; preserve existing files.\nInput: muse-relay-request-<id>.json containing {protocol:\"muse-relay/1\",id,kind:\"chat\"|\"space\",text,created_at,space_id?,space_action?}. audio_file/audio_mime/audio_name or image_file/image_mime/image_name reference separate files containing base64 bytes.\nOutput: g2muse-relay.json as {messages:[{id,from:\"Muse\",type:\"text\",text,ts,reply_to}]}. ts is Unix seconds; reply_to is the original request ID. Use one writer. Preserve existing G2Muse and other foreign records. Apply the latest-50 limit only to rows created by this watcher. Adapt the old G2Muse watcher to this separate outbox instead of using it unchanged.\nThe optional reference {0}/tree/main/adapters/gist only watches requests. Implement Muse connectivity and processing in the handler.", [repo]);
  const linux = state.route === 'linux' ? t("Use the official Linux SDK at {0}/blob/main/linux/README.md. Implement a Muse Relay adapter separately. After initial BLE pairing, Linux at home connects outward to the relay and Muse. Test a dedicated conversation with musegadget send-user-msg --session-id \"<NEW_UUID>\" --wait 60 \"test\". Generate a fresh test UUID for <NEW_UUID>. The official {1}/blob/main/linux/examples/pebble_ring_bridge.py shows how to use the existing SDK connection. Acceptance: preserve the POST /v1/requests id as the Muse reply's reply_to, read that reply through GET /v1/snapshot, and display it in the app. Do not invent APIs; report only what you actually tested.", [sdk, sdk])
    : t("The reference device is an ATOM S3 left at home. Use the firmware and USB setup in {0}/blob/main/docs/atoms3.md. Keep power and Wi-Fi on; the device connects outward to the HTTPS relay. Do not ask for its LAN IP as the phone endpoint or require port forwarding to ATOM.", [repo]);
  return t("Use Muse Gadget SDK. {0}\nApp input: POST /v1/requests with the phone key. Output: GET /v1/snapshot and GET /v1/files/:name. Return the public {messages,spaces?,profile?,device?,capabilities?} format.\nWith the optional reference server at {1}/tree/main/server, the device reads /device/jobs with a separate device key and returns ACKs, matching Muse conversation events, and heartbeats to /device/events. Correlate the dedicated conversation ID with the request and exclude other conversations.\nAdditional Muse output uses a separate MUSE_TOKEN: POST /v1/messages {id:\"muse_export_<unique-id>\",type:\"text\",text,reply_to?}. The sender is Muse. Do not create You messages through /v1/messages. Separate phone, device, and Muse writer keys.\nProvide the phone configuration JSON {relay:\"gadget\",relayUrl,relayToken} through secure setup. Send any hosting credential only to its relay origin. Allow the origin shown inside the Even app; use the reference setup's explicit local-origin option for variable http://127.0.0.1 ports.", [linux, repo]);
}
function voicePrompt() {
  if (state.voice === 'soniox-key') return t("Voice uses Soniox (direct from app) and Enter API key. I enter my own key in Soniox API key inside the app. Do not build a temporary-key server or send this key to Muse or the relay. The app streams audio directly to Soniox, shows interim words on G2 and the phone, and sends only final text to {0} on submit. Use that text directly; do not transcribe it again with Whisper or another model.", [routes()[state.route].medium]);
  if (state.voice === 'soniox-server') return t("Voice uses Soniox (direct from app) and Temporary key server. {0}\nKeep the long-term Soniox key only on the token server and issue temporary keys for transcribe_websocket. Audio travels directly from the app to Soniox, not through the token server. Show interim words on G2 and the phone; send only final text to {1}. Do not transcribe again on the Muse side. Check the official format and limits at https://docs.soniox.com/authentication/temporary-api-keys and in the existing reference implementation.", [state.route === 'gist'
    ? t("Provide a separate authenticated HTTPS temporary-key endpoint and let me configure its URL and dedicated credentials in the app. Do not store long-term or temporary keys in Gist.")
    : t("With the reference relay's POST /v1/soniox-token, the app reuses its relay URL and phone credentials. Never inherit credentials for a token endpoint on another origin."), routes()[state.route].medium]);
  if (state.route !== 'gist') return t("Keep Transcribe via relay. If the configured HTTPS relay reports capabilities.live_transcription, use its Soniox captions during recording and send only final text to Muse. Keep the Soniox key on the relay. A WAV-only relay forwards one mono PCM WAV through the paired Gadget SDK on send. Use its matching message.user transcript when available. Link the Muse reply with reply_to equal to the original request ID and preserve the G2 speaker filter.");
  return t("Voice uses Transcribe via relay. Do not stream audio to the relay while recording; send one 16 kHz, 16-bit mono WAV on submit. {0}\nDo not require Soniox for this mode. Do not infer or reconstruct excluded or unclassified speech that the G2 speaker filter replaced with silence.", [t("Implement Whisper-compatible or another configured transcription in the Muse-side handler. Return transcript to the reference watcher. Update the from:\"You\" message whose id matches the original request ID, and use that ID for the Muse reply_to.")]);
}
function imagesPrompt() {
  if (!state.images) return t("Images are off. Use text replies and Spaces understandable from text alone. Do not require enabling images or creating an avatar during connection setup.");
  return t("Images are on. Read PNG/JPEG/WebP bytes and export at most 250000 decoded bytes. Do not return only a URL or local path. {0}\nG2 converts images to 288×144 and 16 grayscale levels. Avoid tiny text or information that depends on color.", [state.route === 'gist'
    ? t("Image replies use type:\"image\", image_file:<Gist filename containing base64>, and mime_type. A caption is optional. The reference watcher supports reply image output; Space images need a custom exporter.")
    : t("Use the Muse writer key for POST /v1/messages {id:\"muse_export_<unique-id>\",type:\"image\",image:{mime,data_base64,name},text?,reply_to?}. SDK display.draw_* targets the Gadget device, not G2. capabilities.images controls image input to Muse, not incoming Muse images. Enable phone-image input only when the connected relay reports support and the route has been verified.")]);
}
function spacePrompt() {
  const examples = {
    schedule: [t("Today's schedule"), t("Show today's events in time order, briefly. Keep reading passive; run a summary only when its button is pressed."), 'list', [{type:'button',label:t("Summarize")}]],
    focus: [t("Focus timer"), t("Choose a focus duration from 5 to 60 minutes and start it with a button. Show its status and expected end time. A passive refresh must not start a timer."), 'cards', [{type:'slider',min:5,max:60,step:5,value:25,unit:t("min")},{type:'button',label:t("Start"),confirm:t("Start the focus timer?")}]],
    notes: [t("Voice notes"), t("Add a voice note to the selected item and show the transcript and a short summary. Opening an item must not start recording."), 'list', [{type:'microphone'}]],
  };
  const [name, purpose, layout, controls] = examples[state.preset];
  return t("Create a Muse Space named \"{0}\", or reuse an existing Space for the same purpose. Purpose: {1}\nLayout: layout:\"{2}\". Controls: {3}. Keep titles and content brief and in English. Implement the actual processing in Muse; a template alone is not a finished feature.\nExport {id,title,layout,items:[{id,title,text,control?}]}. Use stable IDs and preserve other Spaces. Maximum 20 Spaces and 50 items per Space. Do not embed HTML, JavaScript, or Muse pages.\n{4}\nReceive kind:\"space\",space_id,space_action:{item_id,type,value?} through the existing transport. Process each request ID once. A request without space_action only refreshes exports; it must not trigger buttons or timers. After processing, publish current values and content, and set reply_to to the original request ID. Acceptance is not completion.\nOn G2, swipe selects items or adjusts values; tap opens, runs, or confirms; double-tap goes back or cancels. Select a microphone item and tap to start, tap to send, or double-tap to cancel. Do not require a keyboard, external page, or long press.\n{5}\nAfter export succeeds, guide me through Spaces → Add → Add an exported space → Refresh to receive → Add.", [name, purpose, layout, JSON.stringify(controls), state.route === 'gist' ? t("Use the existing Gist writer to update muse-relay-spaces.json as {spaces:[...]}. Preserve all other Spaces when writing the full list.") : t("Use the existing HTTPS relay's MUSE_TOKEN. Read GET /v1/spaces, then save only the target Space with PUT /v1/spaces/<id>. The URL and body id must match. Do not replace the full list just to add one Space."), state.preset === 'notes' ? voicePrompt() : t("Do not change the existing voice or relay settings.")]);
}
function avatarPrompt() {
  return t("Find the avatar currently configured in Muse by checking the existing profile, persona, and files. If none is found, say so. Do not generate, choose, or substitute another image.\nRead the original image bytes. Export avatar:{mime,data_base64,name} as PNG/JPEG/WebP, at most 250000 decoded bytes. A URL or file path alone is insufficient.\n{0}\nAfter success, guide me to enable Settings → Voice & images → Enable images and select Save settings. The received avatar appears on the G2 home screen. Distinguish finding the image, exporting it, and displaying it on G2; report only the steps actually verified.", [state.route === 'gist' ? t("Use the existing Gist writer to save muse-relay-profile.json as {profile:{name,avatar:{mime,data_base64,name},updated_at}}. Preserve other files.") : t("Use MUSE_TOKEN to PUT /v1/profile on the existing relay, with {name,avatar:{mime,data_base64,name}}. The phone key cannot publish.")]);
}
function historyPrompt() {
  return t("Review history and cleanup on my existing {0} relay. Do not delete anything during diagnosis. First distinguish locally hidden messages, current relay data, and old revisions or backups. Preserve my messages, Spaces, profile, and working configuration. Explain what can be restored and what cannot.", [routes()[state.route].name]) + '\n' + (state.route === 'gist'
    ? t("If I also use G2Muse, extend the single existing watcher/writer; do not start a competing writer or overwrite g2muse-relay.json or older files. Read the current protocol and watcher implementation. Only after processing is confirmed, propose one atomic update that cleans the matching request and its own input attachments. Review unknown reply IDs individually; preserve message, Space, and avatar files still needed. The reference watcher keeps its own latest 50 rows and preserves other writers’ records. Check root-level gist.truncated separately from an individual file.truncated/raw_url. Do not silently process an incomplete file list. Removing current files does not erase Gist revision history. Present proposed changes and ask before deleting data.")
    : t("Inspect the configured relay retention and request correlation. Explain whether a missing message was hidden locally or pruned on the relay. Do not treat Device online as proof of a successful Muse round trip. Present proposed cleanup separately; do not delete messages, attachments, Spaces, or profile data without my confirmation."));
}
function reusePrompt() {
  return [t("I already use a G2Muse-compatible Gist. Reuse that same Gist for Muse Relay. Do not initialize or replace it. Inspect the existing watcher and ask it to handle Muse Relay's request files; do not launch a second writer. Preserve all old messages, files, voice settings, images, Spaces, and profile data. Use the connection contract below only to extend the existing setup."), transportPrompt(), historyPrompt(),
    t("Check a new short text request and its matching reply first. Then check the existing audio route: keep the transcript on the original You message and link Muse's reply with reply_to. Do not switch transcription services or require a new avatar. Ask only for the missing settings through secure setup. Cleanup must be limited to confirmed requests and their owned input attachments in one update; leave unknown or unmatched IDs for individual review.")].join('\n\n');
}
function renderPrompt() {
  const route = routes()[state.route];
  $('#space-preset-field').hidden = state.topic !== 'space';
  $('#prompt-context').textContent = state.topic === 'reuse' ? t("G2Muse Gist · Keep existing settings") : t("{0} · {1} · Images {2}", [route.name, voiceName(), state.images ? t("On") : t("Off")]);
  const parts = [t("For Muse Relay, please {0}. Public protocol: {1}", [state.topic === 'connection' ? t("set up the relay in my environment") : state.topic === 'reuse' ? t("extend my existing G2Muse setup") : state.topic === 'voice' ? t("check and implement voice settings") : state.topic === 'space' ? t("create a Space") : state.topic === 'history' ? t("review history and cleanup") : t("retrieve the configured avatar"), contractLink]), safeConfiguration()];
  if (state.topic === 'connection') parts.push(transportPrompt(), voicePrompt(), imagesPrompt(), t("Persist claims and results by request ID to avoid duplicate execution. Never blindly resend a request whose outcome is unknown. Use lightweight polling and call Muse only for new requests. Do not create Spaces or an avatar during connection setup; wait for a separate request."));
  else if (state.topic === 'reuse') parts.push(reusePrompt());
  else if (state.topic === 'voice') parts.push(t("The current relay is {0}. Preserve existing chat and credential separation.", [route.name]), voicePrompt(), state.voice === 'muse'
    ? t("Verify the saved audio route with a short recording. For live captions, check that text arrives before release and that the final text matches the Muse reply's request ID.")
    : t("Use the selected microphone only when I record. Check Soniox connection uses one second of silence and may count toward usage. Verify authentication separately from real speech transcription."));
  else if (state.topic === 'space') parts.push(spacePrompt());
  else if (state.topic === 'history') parts.push(historyPrompt());
  else parts.push(avatarPrompt());
  if (state.topic === 'connection' && state.route === 'gist') parts.push(t("If G2Muse already uses this Gist, keep g2muse-relay.json and all existing files. Extend its one existing watcher/writer to recognize Muse Relay request files; do not run another writer beside it. Gist profile/avatar export is optional and is not required for migration or text/audio checks."));
  if (state.topic === 'voice') parts.push(t("If a Muse reply arrives but my input transcript is missing, inspect the original request ID and the saved transcription mode. For Gist, return transcript from the handler and update You.id equal to the request ID; use that ID in Muse.reply_to. For Gadget, check the matching acknowledged conversation's message.user display_text, text, or content. POST /v1/messages is for Muse output, not for creating You messages. If the SDK does not provide a transcript, report that limit instead of fabricating one. Verify a short recording and its matching reply separately from endpoint access; use synthetic or consented test content and keep recordings and credentials out of logs."));
  if (state.route === 'linux' && state.topic !== 'connection') parts.push(t("If no Linux adapter exists, implement it first and verify that a request through the HTTP interface produces its matching reply."));
  parts.push(t("Finish with a short list of settings I must enter and the input, processing, and output steps actually verified. Keep secrets out of the reply."));
  $('#prompt-output').value = localizeDocText(parts.join('\n\n')); $('#copy-status').textContent = ''; $('#copy-prompt').disabled = false;
}

// The on-page HUD is an illustration. It never accesses a microphone or a relay.
const demo = { type: 'chat', index: 0, page: 0, home: false, homeIndex: 0, recording: false, spaceIndex: 0, detail: '', minutes: 25 };
const homeScreen = el('div', undefined, 'hud-screen hud-home'); homeScreen.hidden = true;
const recordingScreen = el('div', undefined, 'hud-screen'); recordingScreen.hidden = true;
function localizeDemoScreens() {
  homeScreen.replaceChildren(el('p', t('Chat'), 'hud-selected'), el('p', t('Spaces')), el('p', t('Record voice')), el('span', t('Home · Example'), 'hud-footer'));
  recordingScreen.replaceChildren(el('p', t('Recording…')), el('p', t('Tap to send · Double-tap to cancel')), el('span', t('Example · no recording or sending'), 'hud-footer'));
}
$('#hud').append(homeScreen, recordingScreen);
function renderDemo() {
  $$('[data-hud]').forEach(screen => { screen.hidden = demo.home || demo.recording || screen.dataset.hud !== demo.type; });
  homeScreen.hidden = !demo.home;
  recordingScreen.hidden = !demo.recording;
  $$('[data-demo]').forEach(button => { const on = button.dataset.demo === demo.type; button.classList.toggle('selected', on); button.setAttribute('aria-pressed', String(on)); });
  $('#hud').setAttribute('aria-label', t("{0} example. Dummy data.", [demo.recording ? t("Recording") : demo.home ? t("Home") : demo.type === 'chat' ? t("Chat") : demo.type === 'image' ? t("Images") : t("Spaces")]));
  if (demo.recording) { $('#demo-description').textContent = t("After starting a recording, tap to send or double-tap to cancel. This demo does not use a microphone."); return; }
  if (demo.home) { [...homeScreen.querySelectorAll('p')].forEach((row, i) => row.classList.toggle('hud-selected', i === demo.homeIndex)); $('#demo-description').textContent = t("Double-tap to return home. Swipe to select, then tap to open."); return; }
  if (demo.type === 'chat') {
    const chats = [[t("You: What's on my schedule today?"), [t("10:00 Meeting"), t("14:30 Review documents"), t("Your evening is free.")]], [t("You: What should I bring?"), [t("Notebook and charger"), t("Folding umbrella"), t("Documents to review")]]];
    $('[data-hud="chat"] .hud-input').textContent = chats[demo.index][0];
    $('[data-hud="chat"] .hud-answer').replaceChildren(...(demo.page ? [t("The message continues here."), t("Tap for the next page."), t("Swipe between conversations.")] : chats[demo.index][1]).map(text => el('p', text)));
    $('#demo-description').textContent = t("Your input and Muse's reply appear together. Your input uses dimmer text.");
  } else if (demo.type === 'image') {
    $('.hud-image').toggleAttribute('hidden', demo.page === 1); $('.hud-image-caption').hidden = demo.page !== 1;
    $('[data-hud="image"] .hud-footer').textContent = demo.page ? t("Text · Example") : t("Tap for text");
    $('#demo-description').textContent = t("View an image exported by Muse. Tap to continue to its text.");
  } else {
    $('.hud-list').hidden = Boolean(demo.detail); $('.hud-space-detail').hidden = !demo.detail;
    $$('.hud-list p').forEach((row, i) => row.classList.toggle('hud-selected', i === demo.spaceIndex));
    const lines = demo.detail === 'slider' ? [t("Focus time"), t("{0} min", [demo.minutes]), t("Swipe to adjust · Tap to send")] : demo.detail === 'accepted' ? [t("Accepted by relay"), t("Muse publishes the result"), t("Example · nothing is sent")] : [demo.spaceIndex === 0 ? t("10:00 Meeting") : t("14:30 Review documents"), t("Summarize three things to check"), t("Update after the meeting")];
    $('.hud-space-detail').replaceChildren(...lines.map(text => el('p', text)));
    $('[data-hud="space"] .hud-footer').textContent = demo.detail ? t("Double-tap for the list") : t("Swipe to select · Tap to open");
    $('#demo-description').textContent = t("Lists and controls exported by Muse. Select Focus time to try adjusting a value.");
  }
}
$$('[data-demo]').forEach(button => button.addEventListener('click', () => { demo.type = button.dataset.demo; demo.home = false; demo.recording = false; demo.page = 0; demo.detail = ''; renderDemo(); }));
$('#demo-swipe').addEventListener('click', () => {
  if (demo.recording) return;
  if (demo.home) demo.homeIndex = (demo.homeIndex + 1) % 3;
  else if (demo.type === 'chat') { demo.index = 1 - demo.index; demo.page = 0; }
  else if (demo.type === 'space') { if (demo.detail === 'slider') demo.minutes = demo.minutes >= 60 ? 5 : demo.minutes + 5; else { demo.spaceIndex = (demo.spaceIndex + 1) % 3; demo.detail = ''; } }
  else { demo.type = 'chat'; demo.page = 0; }
  renderDemo();
});
$('#demo-tap').addEventListener('click', () => {
  if (demo.recording) { demo.recording = false; demo.type = 'chat'; demo.page = 0; }
  else if (demo.home) { demo.home = false; if (demo.homeIndex === 2) demo.recording = true; else demo.type = demo.homeIndex === 1 ? 'space' : 'chat'; }
  else if (demo.type === 'space') { if (demo.detail === 'slider') demo.detail = 'accepted'; else if (demo.detail === 'accepted') demo.detail = ''; else demo.detail = demo.spaceIndex === 2 ? 'slider' : 'reading'; }
  else demo.page = 1 - demo.page;
  renderDemo();
});
$('#demo-back').addEventListener('click', () => { if (demo.recording) { demo.recording = false; demo.home = true; } else if (demo.type === 'space' && demo.detail && !demo.home) demo.detail = ''; else demo.home = true; renderDemo(); });

// Native anchors keep deep links and browser back/forward behavior intact.
function markNavigation() {
  const hash = location.hash;
  $$('.header-row nav a').forEach(a => { if (a.hash === (hash === '#g2muse' ? '#relay' : hash)) a.setAttribute('aria-current', 'location'); else a.removeAttribute('aria-current'); });
  $$('[data-language]').forEach(a => { a.href = languageHref(a.dataset.language, hash); });
  const target = document.getElementById(hash.slice(1));
  if (target?.tagName === 'DETAILS') target.open = true;
}
function choosePrompt(topic) {
  state.topic = topic;
  if (topic === 'reuse') {
    state.route = 'gist';
    $$('input[name="route"]').forEach(input => { input.checked = input.value === 'gist'; });
  }
  $('#prompt-topic').value = topic;
  renderRoute();
}
function selectHashPrompt() { if (location.hash === '#g2muse') choosePrompt('reuse'); }
window.addEventListener('hashchange', () => { selectHashPrompt(); markNavigation(); });
$('#theme').addEventListener('change', event => { document.documentElement.dataset.theme = event.target.value; });
$$('input[name="route"]').forEach(input => input.addEventListener('change', () => {
  state.route = input.value; state.step = 0;
  if (state.topic === 'reuse' && state.route !== 'gist') { state.topic = 'connection'; $('#prompt-topic').value = state.topic; }
  renderRoute();
}));
$$('input[name="voice"]').forEach(input => input.addEventListener('change', () => { state.voice = input.value; renderVoice(); renderStep(); renderPrompt(); }));
$('#guide-images').addEventListener('change', event => { state.images = event.target.checked; if (state.images) $('#image-details').open = true; renderStep(); renderPrompt(); });
$$('[data-step]').forEach(button => button.addEventListener('click', () => { state.step = Number(button.dataset.step); renderStep(); }));
$('#step-prev').addEventListener('click', () => { state.step = Math.max(0, state.step - 1); renderStep(); });
$('#step-next').addEventListener('click', () => { state.step = Math.min(3, state.step + 1); renderStep(); });
$('#prompt-topic').addEventListener('change', event => choosePrompt(event.target.value));
$('#space-preset').addEventListener('change', event => { state.preset = event.target.value; renderPrompt(); });
$$('[data-prompt-link]').forEach(a => a.addEventListener('click', () => choosePrompt(a.dataset.promptLink)));
$('#copy-prompt').addEventListener('click', () => { void copyText($('#prompt-output').value, $('#prompt-output'), $('#copy-status')); });

const form = $('#feedback-form');
const feedbackMessage = $('#feedback-message');
const submit = $('#feedback-submit');
let sending = false, lastSent = '';
let feedbackNotice = { key: '', type: '', values: [] };
function formPayload() {
  const data = new FormData(form);
  return { kind: data.get('kind'), message: String(data.get('message') || '').trim(), share: data.get('share') === 'on', website: String(data.get('website') || '') };
}
function renderFeedbackNotice() {
  const { key, type, values } = feedbackNotice;
  const status = $('#feedback-status');
  status.textContent = t(key, values); status.className = `feedback-status ${type}`;
  status.setAttribute('role', type === 'error' ? 'alert' : 'status');
}
function feedbackStatus(key, type = '', values = []) {
  feedbackNotice = { key, type, values }; renderFeedbackNotice();
}
function updateFeedback() {
  const length = [...feedbackMessage.value].length;
  $('#feedback-count').textContent = `${length} / 4000`;
  feedbackMessage.setAttribute('aria-invalid', String(length > 4000));
  const unchanged = lastSent === JSON.stringify(formPayload());
  submit.disabled = sending || unchanged;
  submit.textContent = t(sending ? 'Sending…' : unchanged ? 'Sent' : 'Send');
}
form.addEventListener('input', updateFeedback);
form.addEventListener('change', updateFeedback);
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (sending) return;
  const payload = formPayload(), length = [...payload.message].length;
  if (length < 10 || length > 4000) { feedbackStatus('Enter a message of 10–4000 characters.', 'error'); feedbackMessage.setAttribute('aria-invalid', 'true'); feedbackMessage.focus(); return; }
  const body = JSON.stringify(payload);
  if (new TextEncoder().encode(body).length > 16384) { feedbackStatus('The data is too large. Shorten your message before sending.', 'error'); feedbackMessage.focus(); return; }
  sending = true; updateFeedback(); feedbackStatus('Sending your message.');
  const abort = new AbortController(), timeout = window.setTimeout(() => abort.abort(), 25000);
  try {
    const response = await fetch('/api/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'omit', body, signal: abort.signal });
    let result; try { result = await response.json(); } catch { result = null; }
    if (response.status === 201 && typeof result?.receipt === 'string' && result.receipt.length <= 100) {
      lastSent = body; feedbackStatus('Received. Receipt: {0}', 'success', [result.receipt]);
    } else if (response.status === 429) {
      const seconds = Number(response.headers.get('Retry-After'));
      if (Number.isFinite(seconds) && seconds > 0 && seconds <= 86400) feedbackStatus('Too many submissions. Try again in about {0} minute(s). Your message is still here.', 'error', [Math.ceil(seconds / 60)]);
      else feedbackStatus('Submissions are busy. Wait a while and retry. Your message is still here.', 'error');
    } else if (response.status === 400 || response.status === 422) feedbackStatus('Check your input. Messages must be 10–4000 characters.', 'error');
    else if (response.status === 413) feedbackStatus('The data is too large. Shorten your message.', 'error');
    else if (response.status === 403) feedbackStatus('Could not submit from this page. Reopen the guide or use a GitHub Issue.', 'error');
    else if (response.status === 503 || response.status === 404) feedbackStatus('This form is currently unavailable. Your message is still here. Try later or use a GitHub Issue.', 'error');
    else feedbackStatus('Could not confirm receipt (HTTP {0}). Your message is still here.', 'error', [response.status]);
  } catch {
    feedbackStatus('Could not confirm receipt. Check your connection and wait before resending. Your message is still here.', 'error');
  } finally {
    window.clearTimeout(timeout); sending = false; updateFeedback();
  }
});

let languageRequest = 0;
async function applyLanguage(language, updateUrl = false) {
  const request = ++languageRequest;
  try { await prepareLocale(language); }
  catch {
    // The language links also work as normal, server-rendered pages.
    if (updateUrl && request === languageRequest) location.assign(languageHref(language, location.hash));
    return;
  }
  if (request !== languageRequest) return;
  setLocale(language);
  document.documentElement.lang = getLocale();
  $('#language-name').textContent = languages[getLocale()];
  $$('[data-language]').forEach(a => { if (a.dataset.language === getLocale()) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  if (updateUrl) {
    $('#language-menu').open = false;
    $('#language-menu summary').focus();
    // The language path and existing fragment only; never the form or other query data.
    history.replaceState(null, '', languageHref(getLocale(), location.hash));
  }
  translatePage();
  localizeDemoScreens();
  renderRoute(); renderDemo(); markNavigation(); updateFeedback(); renderFeedbackNotice();
}
$$('[data-language]').forEach(a => a.addEventListener('click', event => {
  if (event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault(); void applyLanguage(a.dataset.language, true);
}));
const languageMenu = $('#language-menu');
languageMenu.addEventListener('keydown', event => {
  if (event.key === 'Escape' && languageMenu.open) { languageMenu.open = false; languageMenu.querySelector('summary').focus(); }
});
document.addEventListener('click', event => {
  if (languageMenu.open && !languageMenu.contains(event.target)) languageMenu.open = false;
});
window.addEventListener('popstate', () => { selectHashPrompt(); applyLanguage(languageFromUrl(new URL(location.href))); });
selectHashPrompt();
void applyLanguage(languageFromUrl(new URL(location.href)));
