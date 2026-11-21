import type { Settings } from '../core/types';
import { MOTION_SPACE_ID } from '../core/types';
import { sonioxAuthMode } from '../core/config';
import { languageName } from '../core/i18n';


function speakerInstruction(settings: Settings): string {
  if (settings.mic === 'phone' || settings.speakerFilter === 'all') return 'All captured voices are included.';
  return `The app uses G2 speaker classification to keep ${settings.speakerFilter === 'self' ? 'only the wearer' : 'only other speakers'} and replaces other/unclassified frames with silence. Do not infer or recover excluded speech.`;
}
function sonioxInstruction(settings: Settings): string {
  if (sonioxAuthMode(settings) === 'api-key') return 'Authentication: I enter my personal Soniox API key in Muse Relay settings. The app connects directly to Soniox. Do not build or require a token server, ask for this key, put it in a Gist, or forward it to Muse/the relay. No Soniox server configuration is needed.';
  return `Authentication: use a temporary-key server, keeping the long-term Soniox key on that server. ${settings.sonioxTokenUrl.trim()
    ? 'Reuse the selected custom endpoint and its own separately configured credentials. Never inherit credentials from a different origin.'
    : settings.relay !== 'gist' ? 'Use the existing relay /v1/soniox-token route and phone access credentials.'
    : 'Provide an authenticated HTTPS temporary-key endpoint through the secure setup flow.'} Return a snx_temp_ key for transcribe_websocket. The app sends it only to Soniox in WebSocket protocols, not in a config message.`;
}

function relayTranscription(settings: Settings): string {
  if (settings.relay === 'custom') return 'Use the transcription configured on my server and pass the result to Muse.';
  return settings.relay === 'gist'
    ? 'Use the Muse-side Gist handler to transcribe the WAV with a Whisper-compatible model or another configured transcriber.'
    : 'Reuse the relay\'s existing audio handling. The reference Gadget relay forwards the WAV to Muse through the SDK. If a custom relay already transcribes WAV on the server, use its configured transcriber and pass the transcript to Muse.';
}

export type SpacePromptControl = 'button' | 'slider' | 'choice' | 'microphone';
export interface SpacePromptOptions {
  name: string;
  purpose: string;
  layout: 'list' | 'cards';
  controls: SpacePromptControl[];
}

/** A focused creation request. Connection secrets and personal URLs stay in settings. */
export function spacePrompt(settings: Settings, options: SpacePromptOptions, relayLiveVoice = false): string {
  const controls = {
    button: {type:'button', label:'Run', confirm:'Run this action?'},
    slider: {type:'slider', min:5, max:60, step:5, value:25, unit:'min'},
    choice: {type:'choice', options:[{id:'today',title:'Today'},{id:'tomorrow',title:'Tomorrow'}], value:'today'},
    microphone: {type:'microphone'},
  };
  const selected = [...new Set(options.controls)].map(type => controls[type]);
  const transport = settings.relay === 'gist'
    ? 'GitHub Gist: write muse-relay-spaces.json as {spaces:[...]}. Read immutable muse-relay-request-<id>.json files; a voice attachment is audio_file/audio_mime/audio_name and the referenced file contains base64 WAV. The optional adapters/gist handler can return spaces in its result. Use the existing configured Gist writer, preserve other exports, and keep a single writer.'
    : settings.relay === 'custom' ? 'Use my server’s own Muse integration to publish this space in the spaces array of GET /v1/snapshot. Preserve all other exports.'
    : 'Muse Gadget SDK via my existing HTTPS relay/home gadget: use the separate MUSE_TOKEN for GET <relay>/v1/spaces and PUT <relay>/v1/spaces/<id>. Put the single space object with the same ID as in the URL. On an older relay, only use the existing full-list write flow if you have the complete export to preserve. Reuse the configured secure credentials; the phone token cannot publish. If needed, the hosting gateway key goes only to that relay origin. SDK display.draw_* does not create a G2 space.';
  const voice = !options.controls.includes('microphone') ? '' : settings.voice === 'soniox' || (settings.relay !== 'gist' && relayLiveVoice)
    ? 'Microphone actions carry final Soniox text. Use it directly; do not transcribe it again.'
    : `A submitted microphone action carries one mono PCM WAV from the ${settings.mic === 'phone' ? 'phone' : 'G2'} microphone. ${relayTranscription(settings)} Use the result to update the space.`;
  return [
    `Create or adapt a Muse space named ${JSON.stringify(options.name.trim())}. Purpose: ${JSON.stringify(options.purpose.trim())}. Use ${languageName(settings.language)} for all titles, content and replies.`,
    `Use layout:${JSON.stringify(options.layout)}. ${selected.length ? `Include only these built-in control types; adapt labels, ranges and options to the purpose: ${JSON.stringify(selected)}.` : 'Use read-only text items without controls.'} Put results/current values in the exported items. Buttons act only when explicitly tapped; a slider/choice sends only when confirmed; a microphone starts only when selected.`,
    'Export this space as {id,title,layout,items:[{id,title,text,control?}]}. Use stable ASCII IDs, at most 20 spaces and 50 items per space. Preserve every other space. Reuse a matching space instead of creating duplicates. Export declarative data, not HTML, scripts or embedded Muse pages.',
    transport,
    'Handle kind:"space", space_id and space_action:{item_id,type,value?} through the existing Muse Relay transport. Slider value is numeric; choice value is an option ID. Button/microphone have no value. Handle each request ID once, perform only the requested action, then publish the updated export. A space request without space_action only refreshes; it must not trigger an action. Queue acceptance is not completion.',
    voice ? `${voice} ${speakerInstruction(settings)}` : '',
    'After processing, publish a reply with reply_to equal to the original request ID so the app can show completion. Preserve other messages and exports. Do not alter the existing relay or transcription setup for this space.',
    'G2 must work with tap, swipe and double-tap only: tap opens/runs/confirms; swipe selects or adjusts; double-tap returns/cancels. No keyboard, pointer, external page or long press. Keep the space understandable with text alone.',
    'Keep credentials and personal relay URLs out of replies/exports. After publishing, tell me to refresh Spaces in Muse Relay and add the received space. Report only what was actually created and exported.',
  ].filter(Boolean).join('\n\n');
}

export function avatarPrompt(settings: Settings): string {
  return [
    `Find the avatar currently configured for you in Muse. Check your existing profile, persona and files. Reply in ${languageName(settings.language)}. If no existing avatar is found, say so; do not create, generate or choose a replacement.`,
    'Read the existing image bytes. Use PNG, JPEG or WebP, at most 250000 decoded bytes. Export avatar:{mime,data_base64,name}; a URL or file path alone is not an image export.',
    settings.relay === 'gist'
      ? 'Using the existing configured Gist writer, write muse-relay-profile.json as {profile:{name,avatar:{mime,data_base64,name},updated_at}}. updated_at is Unix seconds. Preserve other Gist files.'
      : settings.relay === 'custom' ? 'Use my server’s own integration to publish profile:{name,avatar,updated_at} in GET /v1/snapshot. Use Unix seconds and preserve the other snapshot fields.'
      : 'Using the existing HTTPS relay configuration, PUT <relay>/v1/profile with Authorization: Bearer MUSE_TOKEN and body {name,avatar:{mime,data_base64,name}}. Use the separate Muse writer token, not the phone token. If the host requires a gateway key, send it only to that relay origin.',
    `Image display is ${settings.images ? 'enabled' : 'disabled'} in the app. Do not change app settings or create a replacement avatar.`,
    'Obtain credentials only through the existing secure configuration. Keep tokens and personal URLs out of replies and exported profile content. Confirm only a successful export; Muse Relay displays the avatar on its G2 home screen when images are enabled.',
  ].join('\n\n');
}

export function animationPrompt(settings:Settings):string {
  const exportShape={id:MOTION_SPACE_ID,title:'Muse avatar animations',updated_at:'UNIX_SECONDS',items:['idle','working'].map(id=>({
    id,title:id,text:'',image:{mime:'image/png',name:id+'.png',data_base64:'BASE64_PNG_BYTES'},
  }))};
  return [
    `Use your image-generation tool to animate your current Muse character for my Even G2 glasses. Reply in ${languageName(settings.language)}. Retrieve your existing avatar as the identity reference; if unavailable, ask me for the reference before generating. Make two distinct seamless four-second loops, 16 ordered frames each at 4 fps.`,
    'Idle (home): choose one slow body movement for the entire four-second loop. Show a character comfortably passing the time. Start at rest with both feet planted. Let one elbow ease outward as the forearm bends and the hand settles on the hip. Linger there around frame 9, then lower the arm slowly through frame 16. Keep the other hand relaxed. If the character has no arms, use a single unhurried sideways glance and return instead.',
    'Draw the resting and middle poses first, then draw the poses between them. Follow the shoulder, elbow and wrist through the gesture; redraw the sleeve and the outline of the torso it uncovers. Keep limb lengths, face and torso proportions, footing and camera scale consistent. Do not stretch, squash, shear, zoom or slide the source bitmap to simulate movement. At 144×144, compare frames 1 and 9: the hand should move relative to the hip and the elbow bend should read clearly (for a glance, check the direction of the gaze). If the main difference is a taller, wider or shifted character, redraw the middle pose before export. Watch two loops at 4 fps to check that the gesture settles and returns smoothly.',
    'Working (only while waiting for a reply): the same character operates a computer, typing on a visible keyboard and looking at the screen. Use your existing working-at-a-computer motion as a reference if available.',
    'Generate the visual frames with the same reference, model/style, framing, camera, lighting, fixed background, character proportions, face, outfit and scale across all 32 images. Lock the computer and desk in place throughout the working loop. Plan a cyclic motion, advancing one small step per frame. Check frame 16 into frame 1, with no duplicated endpoint, jumps, drift or cuts.',
    'Keep the silhouette clear on black in 16 grayscale levels. Fit the whole pose and computer inside the square with a small margin. No letters, labels, grid lines or gutters. Inspect each loop in playback and fix flicker before export.',
    'For each loop assemble the 16 images into one 576×576 PNG sheet: exactly 4 columns × 4 rows of 144×144 pixels, in playback order across each row then down. Encode as a grayscale or indexed PNG, at most 250000 bytes per sheet. Packaging or resizing the generated images with code is fine. Preserve the existing still avatar.',
    `Export both sheets together using this reserved asset record. Replace UNIX_SECONDS with a current Unix timestamp newer than the previous export and each BASE64_PNG_BYTES with the actual sheet's base64: ${JSON.stringify(exportShape)}.`,
    settings.relay==='gist'
      ? 'With the existing configured Gist writer, write this single JSON object to muse-relay-motions.json. Preserve all other Gist files. Keep these images separate from the text-only watcher spaces result.'
      : settings.relay === 'custom' ? 'Use my server’s own integration to export the record in the spaces array of GET /v1/snapshot. Preserve the other spaces and profile.'
      : `Using the existing HTTPS relay, PUT the single record to /v1/spaces/${MOTION_SPACE_ID} using the separate Muse writer token (Authorization: Bearer MUSE_TOKEN). If a hosting gateway key is required send it only to that relay origin. Leave other exports intact.`,
    'Keep tokens and personal URLs out of the output. After a successful write, tell me to enable images and refresh Muse Relay. If export is unavailable, provide the two sets of 16 square image files numbered 01–16 for manual import in Settings.',
  ].join('\n\n');
}

/** Copy the selected behavior, never credentials or personal endpoint values. */
export function museSetupPrompt(settings: Settings, relayLiveVoice = false): string {
  const gist = settings.relay === 'gist';
  const soniox = settings.voice === 'soniox';
  const live = !gist && !soniox && relayLiveVoice;
  const location = 'Chat requests may include location {latitude,longitude,captured_at,accuracy?} when sharing is enabled. Use it as optional context, keep coordinates out of displayed chat text, and always accept requests without it.';
  const language = languageName(settings.language);
  const microphone = settings.mic === 'phone' ? 'phone microphone' : 'G2 glasses microphone';
  if (settings.relay === 'custom') {
    const voice = soniox ? `Soniox transcribes directly from the ${microphone}. Send only final text to my server. ${sonioxInstruction(settings)}`
      : live ? `My relay advertises capabilities.live_transcription. Implement /v1/voice/live per the protocol and send the final transcript as text from the ${microphone}.`
      : `For voice input the app sends one mono WAV from the ${microphone}. ${relayTranscription(settings)} Return the transcript as text on the original You message if available.`;
    return [
      `Set up a custom relay server for my Muse Relay app. Use ${language} for replies. Choose the server-to-Muse integration appropriate to my environment.`,
      'Implement the app-facing contract at https://github.com/3mintimer/muse-relay/blob/beta/docs/protocol.md#custom-relay. Accept POST /v1/requests {id,kind,text,created_at}, deduplicate by id and return HTTP 202 with JSON. GET /v1/snapshot starts with {"messages":[]}. After processing, return a message {id,from:"Muse",type:"text",text,ts,reply_to} with Unix seconds and the original request id.',
      'Allow the origin shown in my app. The phone bearer token and the hosting access key are independently optional. Obtain configured credentials securely and keep personal URLs and keys out of replies.',
      location,
      `${voice} ${speakerInstruction(settings)}`,
      settings.images ? 'For images, return inline image attachments or serve GET /v1/files/:name. Advertise capabilities.images only if image input is supported.' : 'Images are disabled in my app.',
      'Spaces and profile are optional fields in the snapshot. Only create them on request. Verify one new text request and matching reply first.',
    ].join('\n\n');
  }
  const transport = gist
    ? `Transport: my secret GitHub Gist. Obtain its ID and token through the available secure configuration flow; do not request tokens in chat.
Read immutable muse-relay-request-<id>.json files as {protocol:"muse-relay/1",id,kind:"chat"|"space",text,created_at,space_id?}. Attachments use audio_file/audio_mime/audio_name or image_file/image_mime/image_name; the referenced Gist file contains base64 bytes, not an inline audio/image object in the request JSON.
Publish replies to g2muse-relay.json as {messages:[{id,from:"Muse",type:"text",text,ts,reply_to?}]}, with Unix-second ts and reply_to set to the request id. Use one writer, preserve retained messages, and keep the latest 50. The old G2Muse watcher must adapt to this separate outbox. The optional adapters/gist watcher calls a user-provided handler; it does not implement a Muse API.`
    : `Transport: my configured HTTPS relay and dedicated Muse conversation. The reference setup uses a home device such as ATOM S3 with Muse Gadget SDK. The board connects outward; its home LAN IP is not the mobile endpoint. Follow the Muse Relay project protocol for request/reply correlation; do not forward other conversations or treat queue acceptance as a reply.
For additional text, POST <relay>/v1/messages using Authorization: Bearer MUSE_TOKEN with {id:"muse_export_<unique-id>",type:"text",text,ts?,reply_to?}. Reuse an id only to update that message; ts is Unix seconds and reply_to is the original app request id when known. The server sets from:"Muse". Obtain the separate Muse writer token securely; the phone token cannot publish.
If the relay hosting requires a gateway key, send OAI-Sites-Authorization: Bearer <hosting-key> only to that relay origin. Keep keys and personal URLs out of this copied instruction and exported content.`;

  const voice = soniox
    ? `Voice mode: direct Soniox transcription. The app streams audio from the ${microphone} directly to Soniox. Soniox recognizes the speech; the app displays interim words on G2 and the phone. On submit, only the final text goes through the selected relay to Muse. Use that text directly; do not install a Whisper model or transcribe it again for this mode.
${sonioxInstruction(settings)} ${speakerInstruction(settings)}`
    : live ? `Voice mode: live transcription via my HTTPS relay. During recording the app sends audio from the ${microphone} to the relay, and the relay uses Soniox to return interim captions to G2 and the phone. Muse receives the final text. Use it directly and link the reply with reply_to equal to the original request id. Leave Soniox authentication on the configured relay. ${speakerInstruction(settings)}`
      : `Voice mode: transcription via the selected relay. On submit, the app sends one 16kHz, 16-bit mono WAV${gist ? '' : ' (8 kHz, 8-bit for long recordings)'} from the ${microphone}; it does not stream microphone audio to the relay while recording. ${relayTranscription(settings)} ${gist
      ? 'Update the from:"You" message with id equal to the original request id, setting text to the transcript. Set the Muse reply reply_to to that same request id. When using adapters/gist, return the transcript in the handler transcript field and let the watcher publish it.'
      : 'In the snapshot, update the original from:"You" message with id equal to the request id, setting text to the transcript. The reference relay gets that text from the matching SDK message.user event (display_text/text/content); a custom relay can use its server-side transcript. Set the Muse reply reply_to to that same request id. Publish only Muse replies through /v1/messages. If the selected transcriber returns no text, the input stays labeled as a voice message.'} Configure only this selected voice mode; Soniox setup is not required. ${speakerInstruction(settings)}`;

  const spaces = `Spaces are optional. Do not create one as part of connection setup. When I request one through Muse Relay's Add a space flow, reuse its focused request and built-in button/slider/choice/microphone controls. Export declarative data for G2, not an embedded Muse page or a Gadget display app. ${gist ? 'Preserve muse-relay-spaces.json and all other existing Gist files.' : 'Preserve existing /v1/spaces exports; do not replace the full list to add one space.'} A kind:"space" request without space_action only refreshes; never operate devices or create a space on refresh. Handle explicit space_action once by request ID and return the original reply_to.`;

  const images = !settings.images
    ? 'Images are disabled in the current app settings. Export text replies and text-only space cards. Do not require image viewing or ask me to enable images to complete setup.'
    : `Images are enabled in the current app settings. Keep each space understandable from its title and text as well. ${gist
      ? 'For image replies, use type:"image" with image_file referencing a base64 Gist file and mime_type image/png, image/jpeg or image/webp; a caption is optional. Independent Gist space exporters may include image:{mime,data_base64,name}, or image_file for a PNG base64 file. The bundled adapters/gist handler currently exports text-only space cards; image messages are supported. Do not expect an image inside its spaces result to be published.'
      : 'Read local photos/generated images into image:{mime,data_base64,name}; POST /v1/messages with type:"image" and that image. A text caption is optional. Space items may include the same image object. Use PNG/JPEG/WebP, at most 250000 decoded bytes per image; the reference Worker allows at most 8 images across the stored spaces. SDK display.draw_* affects the home gadget display, not G2. Send bytes, not just a path or URL. capabilities.images controls images sent to Muse; it does not block Muse image exports. The reference gadget image-input path remains disabled unless separately verified.'} The EvenHub app loads the image and displays it on G2 when opened from the glasses list or with Show on glasses. It fits images into 288x144 pixels and 16 grayscale levels. Avoid tiny labels and information that depends on color.`;

  return [
    `Set up or update the Muse side of my Muse Relay Even G2 app. Use ${language} for responses. Keep the selected settings: ${gist ? 'GitHub Gist' : 'Muse Gadget SDK'}; ${soniox ? 'Soniox (direct from app)' : 'transcription via relay'}; ${microphone}; images ${settings.images ? 'enabled' : 'disabled'}.`,
    transport,
    location,
    voice,
    'Handle each request id once using durable claims and completion records. Mark it complete only after the reply is saved; do not blindly replay a request whose outcome is unknown. Use lightweight polling, not a recurring AI task. No new request means no AI run.',
    spaces,
    images,
    `Keep secrets out of all relay content. First verify one owner-sent chat request and its matching reply. Only after I record, verify the selected ${soniox ? 'Soniox text' : live ? 'live relay text' : 'Muse WAV'} flow and ${microphone}.${settings.images ? ' Verify an image only when I request one.' : ''} Distinguish receipt, Muse processing, app display, and physical G2 display; report only what was actually checked.`,
  ].join('\n\n');
}
