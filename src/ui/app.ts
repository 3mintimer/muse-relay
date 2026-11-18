import type { AppController, Attachment, Settings, Snapshot, Space, SpaceItem, Message } from '../core/types';
import { endpoint, resolveSonioxConnection, sonioxAuthMode } from '../core/config';
import { button, el, externalLink, icon, type IconName } from './dom';
import { avatarPrompt, museSetupPrompt, spacePrompt, type SpacePromptControl, type SpacePromptOptions } from './prompts';
import { locales, resolveLocale, translate } from '../core/i18n';
import type { Language } from '../core/types';
import { checkSonioxConnection } from '../core/soniox';
import { sliderValue } from '../../protocol/space-controls.mjs';

type View = 'chat' | 'spaces' | 'settings';
type FeedbackLocation = 'page' | 'connection' | 'save' | 'voice';
type SpaceAddPage = 'choose' | 'create' | 'prompt' | 'receive' | 'register';
type SpaceExample = 'schedule' | 'focus' | 'notes';

const guideUrl = 'https://muse-relay-guide.spicy-cup-4319.chatgpt.site/';
type GuideSection = 'setup' | 'connection' | 'voice' | 'relay' | 'feedback';
function guideLink(label: string, section: GuideSection) {
  return externalLink(label, guideUrl + '#' + section);
}

export function mountApp(root: HTMLElement, controller: AppController): () => void {
  let draft = { ...controller.state.settings };
  let settingsDirty = false;
  let wizard = !draft.configured;
  let step = 0;
  let view: View = 'chat';
  let composer = '';
  let attachment: Attachment | undefined;
  let activeSpace = '';
  let editingSpaces = false;
  let spaceAddPage: SpaceAddPage | null = null;
  let spaceExample: SpaceExample = 'schedule';
  let spaceCreation: SpacePromptOptions | null = null;
  let spaceToRemove: {id: string; title: string} | null = null;
  const spaceDrafts=new Map<string,{signature:string;value:number|string}>();
  let spaceConfirm:{spaceId:string;itemId:string;title:string;message:string}|undefined;
  let draggingSlider=false;
  let uiError = '';
  let uiNotice = '';
  let working = false;
  let feedbackLocation: FeedbackLocation = 'page';
  let testResult: Snapshot | null = null;
  let testedSignature = '';
  let tutorial = false;
  let tutorialMode: 'chat' | 'spaces' = 'chat';
  let tutorialStep = 0;
  let tutorialDemo = false;
  let promptOpen = false;
  let help: { title: string; content: () => Node; focus: string } | null = null;
  const settingsGroups = new Set<string>();
  let voiceTest: { signature: string; ok: boolean; message: string } | null = null;
  let avatarRequestOpen = false;
  let importOpen = false;
  let gistInitializerOpen = false;
  let originHelpOpen = false;
  let gatewayHelpOpen = false;
  let sonioxGatewayHelpOpen = false;
  let sonioxDetailsOpen = false;
  let importText = '';
  let confirmForget = false;
  let historyOpen = false;
  let historyMode: 'older' | 'read' = 'older';
  let renderPending = false;
  let viewportFrame = 0;
  let lastSettings = JSON.stringify(controller.state.settings);
  const t = (ja: string, en: string, values: Record<string, string | number> = {}) => translate(draft.language, ja, en, values);
  const languageOptions = (): [Language, string][] => [['system', t('端末に合わせる', 'Follow phone')], ...locales.map(locale => [locale.code, locale.label] as [Language, string])];
  const signature = (settings = draft) => JSON.stringify([settings.relay, settings.gistId, settings.githubToken, settings.relayUrl, settings.relayToken, settings.gatewayToken]);
  const voiceSignature = (settings = draft) => JSON.stringify([sonioxAuthMode(settings), settings.sonioxApiKey, settings.sonioxTokenUrl, settings.sonioxTokenAuth, settings.sonioxGatewayToken, signature(settings), settings.language]);
  const connectionChecked = () => Boolean(testResult && testedSignature === signature());
  const needsConnectionCheck = () => signature() !== signature(controller.state.settings) && !connectionChecked();
  const editable = () => !working && !controller.state.busy;

  function changed<K extends keyof Settings>(key: K, value: Settings[K]) {
    draft[key] = value;
    if (key === 'sonioxApiKey' && String(value).trim() && draft.sonioxAuth === 'auto') draft.sonioxAuth = 'api-key';
    settingsDirty = true; uiError = ''; uiNotice = '';
  }
  function theme() {
    document.documentElement.dataset.evenTheme = draft.theme;
    document.documentElement.lang = resolveLocale(draft.language);
  }
  function scheduleRender() {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(() => { renderPending = false; render(); });
  }
  async function run(action: () => Promise<void>, location: FeedbackLocation = 'page') {
    if (working) return;
    working = true; feedbackLocation = location; uiError = ''; uiNotice = ''; render();
    try { await action(); } catch (error) {
      // Controller errors remain live so a successful glasses-side retry clears the phone too.
      if (!controller.state.error) uiError = error instanceof Error ? error.message : t('操作に失敗しました。', 'The action failed.');
    }
    finally { working = false; render(); }
  }
  function focusKey(node: HTMLElement, key: string) { node.dataset.focus = key; return node; }
  function small(text: string) { return el('p', 'even-help', text); }
  function hint(title: string, content: string | (() => Node), key = title, compact = false) {
    const trigger = button(compact ? t('ヒント', 'Hint') : title, () => {
      help = { title, content: typeof content === 'string' ? () => el('p', 'message-body', content) : content, focus: `hint-${key}` }; render();
    }, { secondary: true, icon: 'help', className: compact ? 'hint-button' : 'hint-link small-button' });
    trigger.setAttribute('aria-label', `${title}: ${t('ヒント', 'Hint')}`); trigger.setAttribute('aria-haspopup', 'dialog');
    focusKey(trigger, `hint-${key}`); return trigger;
  }
  function withHint(node: HTMLElement, title: string, content: string | (() => Node)) {
    return el('div', 'with-hint', node, hint(title, content, title, true));
  }
  function helpDialog() {
    const current = help!;
    const close = () => { help = null; render(); root.querySelector<HTMLElement>(`[data-focus="${CSS.escape(current.focus)}"]`)?.focus({ preventScroll: true }); };
    const dialog = el('dialog', 'tutorial-dialog hint-dialog'); dialog.setAttribute('aria-labelledby', 'hint-title');
    const title = el('h2', 'page-title', current.title); title.id = 'hint-title';
    dialog.append(el('div', 'page-toolbar', title, focusKey(button(t('閉じる', 'Close'), close, { secondary: true, icon: 'close', className: 'small-button' }), 'hint-close')), current.content());
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('click', event => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) close(); } });
    return dialog;
  }
  function settingsGroup(key: string, title: string, value: string, ...nodes: Node[]) {
    const group = el('details', 'settings-group'); group.dataset.group = key;
    group.open = settingsGroups.has(key);
    group.append(el('summary', '', el('span', '', title), el('span', 'muted', value)), el('div', 'settings-group-body', ...nodes));
    group.addEventListener('toggle', () => { if (group.open) settingsGroups.add(key); else settingsGroups.delete(key); }); return group;
  }
  function openVoiceSettings() { view = 'settings'; settingsGroups.add('voice'); render(); root.querySelector('[data-group="voice"]')?.scrollIntoView({ block: 'start' }); }
  function capabilityHelp() {
    const body = el('div', 'capability-help');
    const row = (label: string, gist: string, gadget: string) => el('tr', '', el('th', '', label), el('td', '', gist), el('td', '', gadget));
    body.append(el('table', 'capability-table', el('thead', '', row('', 'Gist', 'Gadget')), el('tbody', '',
      row(t('チャット・スペース', 'Chat & Spaces'), '✓', '✓'), row(t('画像を受信', 'Receive images'), '✓', '✓'), row('Soniox', '✓', '✓'),
      row(t('追加の機器', 'Extra hardware'), '—', t('必要', 'Required')),
      row(t('機器の接続状態', 'Device status'), '—', '✓'),
      row(voiceTitle('muse'), t('Muse側で対応', 'Muse handler'), 'SDK → Muse'),
      row(t('画像を送信', 'Send images'), t('Muse側で対応', 'Muse handler'), t('中継による', 'Relay dependent')))));
    body.append(el('p', 'message-body', t('GistはMuse側に監視・処理の実装が必要です。Gadgetはペアリング済み機器とHTTPS中継を使います。', 'Gist needs a watcher and handler on the Muse side. Gadget uses a paired device and an HTTPS relay.')),
      el('p', 'message-body', t('SDKは機器の画面・ボタン・センサーなどを扱えます。ATOM S3の参考実装は中継専用です。G2のスペースへ表示するには、どちらもデータの書き出しが必要です。', 'The SDK can use device displays, buttons and sensors. The reference ATOM S3 build is a relay only. Both methods need a data export for G2 Spaces.')));
    return body;
  }
  function field(key: keyof Settings, label: string, placeholder = '', secret = false) {
    const labelEl = el('label', 'field'); const id = `setting-${key}`;
    labelEl.htmlFor = id; labelEl.append(el('span', 'field-label', label));
    const input = el('input', 'even-input'); input.id = id; input.type = secret ? 'password' : 'text';
    input.setAttribute('aria-label', label); input.autocomplete = 'off'; input.spellcheck = false; input.value = String(draft[key]); input.placeholder = placeholder;
    input.setAttribute('autocapitalize', 'none'); focusKey(input, id);
    input.addEventListener('input', () => { changed(key, input.value as never); scheduleRender(); });
    const wrap = el('div', secret ? 'secret-field' : '', input);
    if (secret) {
      const show = button(t('表示', 'Show'), () => {
        input.type = input.type === 'password' ? 'text' : 'password';
        show.textContent = input.type === 'password' ? t('表示', 'Show') : t('隠す', 'Hide');
        show.setAttribute('aria-pressed', String(input.type === 'text'));
      }, { secondary: true, className: 'secret-toggle' });
      show.setAttribute('aria-label', `${label}: ${t('表示を切り替え', 'toggle visibility')}`); show.setAttribute('aria-pressed', 'false'); wrap.append(show);
    }
    labelEl.append(wrap); return labelEl;
  }
  function select<K extends keyof Settings>(key: K, label: string, options: [Settings[K], string][], after?: () => void, selectedValue = draft[key]) {
    const row = el('label', 'even-row select-row', el('span', 'even-row-label', label));
    const input = el('select', 'compact-select'); focusKey(input, `select-${key}`); input.setAttribute('aria-label', label);
    for (const [value, name] of options) { const option = el('option', '', name); option.value = String(value); option.selected = selectedValue === value; input.append(option); }
    input.addEventListener('change', () => {
      const value = typeof draft[key] === 'number' ? Number(input.value) : input.value;
      changed(key, value as Settings[K]); after?.(); render();
    });
    row.append(input); return row;
  }
  function toggle(label: string, checked: boolean, action: (checked: boolean) => void, hint?: string) {
    const row = el('label', 'even-row', el('span', 'even-row-label', label, hint ? el('span', 'row-hint', hint) : null));
    const input = el('input', 'even-switch'); input.type = 'checkbox'; input.checked = checked; input.setAttribute('role', 'switch');
    input.addEventListener('change', () => action(input.checked)); row.append(input); return row;
  }
  function header() {
    return el('header', 'app-header', el('h1', '', 'Muse Relay'), settingsDirty && !wizard ? el('span', 'muted', t('未保存の変更', 'Unsaved changes')) : null);
  }
  function audioRelay(settings = draft) {
    return settings.relay === 'gist' ? 'GitHub Gist' : t('HTTPS 中継', 'HTTPS relay');
  }
  function voiceTitle(mode: Settings['voice']) {
    return mode === 'soniox' ? t('Soniox（アプリから直接）', 'Soniox (direct from app)') : t('中継先で文字起こし', 'Transcribe via relay');
  }
  function flow(settings = draft) {
    const nodes: [string, IconName, string?][] = [
      ['G2', 'glasses'], [t('スマホ', 'Phone'), 'phone'],
      ...(settings.relay === 'gist' ? [[t('GitHub Gist', 'GitHub Gist'), 'cloud'] as [string, IconName]] : [
        [t('HTTPS 中継', 'HTTPS relay'), 'network'] as [string, IconName], ['Muse Gadget', 'home', t('自宅', 'At home')] as [string, IconName, string],
      ]), ['Muse', 'chat'],
    ];
    const track = el('ol', 'flow-track');
    nodes.forEach(([label, name, detail], index) => {
      const li = el('li', 'flow-node', icon(name), el('span', '', label), detail ? el('small', '', detail) : null);
      if (index) {
        const arrow = el('span', 'flow-arrow', '›'); arrow.setAttribute('aria-hidden', 'true'); li.prepend(arrow);
      }
      track.append(li);
    });
    const block = el('figure', 'flow-panel', el('figcaption', 'section-title', t('データの流れ', 'Data flow')), track);
    const voiceRoute = settings.voice === 'soniox'
      ? t('音声 → Soniox → 確定文字を{relay}へ', 'Audio → Soniox → final text to {relay}', { relay: audioRelay(settings) })
      : settings.relay === 'gist' ? t('音声ファイル → Gist → Muse側の処理', 'Audio file → Gist → Muse handler')
        : t('音声ファイル → HTTPS中継 → Gadget → Muse', 'Audio file → HTTPS relay → Gadget → Muse');
    block.append(el('div', 'voice-flow', icon('mic'), el('span', '', voiceRoute)));
    return block;
  }
  function status() {
    const s = controller.state;
    const group = el('div', 'connection-strip'); group.setAttribute('aria-label', t('接続状態', 'Connection status'));
    group.append(el('span', `status-pill ${s.glasses ? 'is-ready' : ''}`, icon('glasses'), t(s.glasses ? 'G2 接続済み' : 'G2 未接続', s.glasses ? 'G2 connected' : 'G2 not connected')));
    const relay = s.settings.relay === 'gist' ? 'Gist' : 'Muse Gadget';
    group.append(el('span', `status-pill ${s.connected ? 'is-ready' : ''}`, icon(s.settings.relay === 'gist' ? 'cloud' : 'network'), s.connected ? t('{relay} 接続済み', '{relay} connected', { relay }) : t('{relay} 未接続', '{relay} not connected', { relay })));
    if (s.settings.relay === 'gadget') group.append(el('span', 'status-pill', icon('home'), s.snapshot.device?.connected ? t('機器 オンライン', 'Device online') : t('機器 応答待ち', 'Waiting for device')));
    if (s.displaySleeping) {
      const label = el('span', 'display-sleeping-label', icon('pause'), t('G2 表示は非表示中', 'G2 display hidden')); label.setAttribute('role', 'status');
      group.append(el('div', 'display-sleeping', label,
        button(t('表示を戻す', 'Restore display'), () => { void run(() => controller.restoreDisplay()); }, { secondary: true, icon: 'glasses', className: 'small-button', disabled: !editable() || !s.glasses || s.recording })));
    }
    return group;
  }
  function notifications(location: FeedbackLocation = 'page') {
    const box = el('div', 'notifications');
    if (feedbackLocation !== location) return box;
    const error = uiError || controller.state.error;
    if (error) { const p = el('p', 'feedback error', error); p.setAttribute('role', 'alert'); box.append(p); }
    const savedNotice = controller.state.notice;
    const browserNotice = ['グラスと音声は Even アプリから利用できます。', 'Open in the Even app for glasses and voice.'].includes(savedNotice);
    const notice = uiNotice || (browserNotice ? t('グラスと音声は Even アプリから利用できます。', 'Glasses and voice are available in the Even app.') : savedNotice);
    if (notice && !error) { const p = el('p', 'feedback', notice); p.setAttribute('role', 'status'); box.append(p); }
    return box;
  }
  function relayChoice() {
    const choices = el('fieldset', 'relay-choices'); choices.append(el('legend', 'sr-only', t('中継方式', 'Relay method')));
    for (const mode of ['gist', 'gadget'] as const) {
      const selected = draft.relay === mode;
      const input = el('input', 'even-radio'); input.type = 'radio'; input.name = 'relay'; input.value = mode; input.checked = selected;
      focusKey(input, `relay-${mode}`);
      input.addEventListener('change', () => { changed('relay', mode); testResult = null; render(); });
      const label = el('label', `relay-choice ${selected ? 'is-selected' : ''}`, icon(mode === 'gist' ? 'cloud' : 'home'),
        el('span', 'choice-copy', el('strong', '', mode === 'gist' ? 'GitHub Gist' : 'Muse Gadget SDK'), el('span', '', mode === 'gist' ? t('追加の機器なし', 'No extra hardware') : t('自宅の機器（例: ATOM S3）', 'Home device, e.g. ATOM S3'))), input);
      choices.append(label);
    }
    return el('div', '', choices, flow(), withHint(el('div', 'feature-strip', icon('chat'), icon('spaces'), icon('image'), el('span', '', t('チャット・スペース・画像受信', 'Chat · Spaces · receive images'))), t('中継方式の違い', 'Compare relay methods'), capabilityHelp));
  }
  function importConnection() {
    const area = el('div', 'import-box');
    area.append(button(t('接続設定を読み込む', 'Import connection settings'), () => { importOpen = !importOpen; render(); }, { secondary: true, icon: 'copy', className: 'full-width' }));
    if (importOpen) {
      const label = el('label', 'field', el('span', 'field-label', t('セットアップ画面でコピーした設定', 'Settings copied from the setup page')));
      const text = el('textarea', 'even-input import-text'); text.value = importText; text.rows = 3; text.spellcheck = false; focusKey(text, 'import-config');
      text.addEventListener('input', () => { importText = text.value; }); label.append(text); area.append(label);
      area.append(button(t('読み込む', 'Import'), () => {
        try {
          const parsed: unknown = JSON.parse(importText);
          if (!parsed || typeof parsed !== 'object') throw new Error('Invalid configuration');
          const data = parsed as Record<string, unknown>;
          if (data.relay !== 'gadget' || typeof data.relayUrl !== 'string' || typeof data.relayToken !== 'string') throw new Error('Invalid configuration');
          for (const key of ['relayUrl', 'relayToken', 'gatewayToken', 'sonioxTokenUrl', 'sonioxTokenAuth', 'sonioxGatewayToken'] as const) changed(key, typeof data[key] === 'string' ? data[key] : '');
          changed('relay', 'gadget'); changed('sonioxAuth', 'token-server');
          // Standard server exports become automatic settings; custom endpoints keep their own credentials.
          try {
            if (endpoint(draft.sonioxTokenUrl) === `${endpoint(draft.relayUrl)}/v1/soniox-token`
              && draft.sonioxTokenAuth.trim() === draft.relayToken.trim() && draft.sonioxGatewayToken.trim() === draft.gatewayToken.trim()) {
              for (const key of ['sonioxTokenUrl', 'sonioxTokenAuth', 'sonioxGatewayToken'] as const) changed(key, '');
            }
          } catch { /* Empty or custom connection details are checked when saved. */ }
          importText = ''; importOpen = false; uiNotice = t('読み込みました。接続を確認してください。', 'Imported. Check the connection next.'); render();
        } catch { uiError = t('接続設定の形式を確認してください。', 'Check the connection settings format.'); render(); }
      }));
    }
    return area;
  }
  function copyValue(label: string, value: string, key: string) {
    const input = el('input', 'even-input copy-value'); input.readOnly = true; input.value = value;
    input.setAttribute('aria-label', label); focusKey(input, key);
    const copy = button(t('コピー', 'Copy'), () => { void run(async () => {
      try { await navigator.clipboard.writeText(value); uiNotice = t('コピーしました。', 'Copied.'); }
      catch { const current = root.querySelector<HTMLInputElement>(`[data-focus="${key}"]`); current?.focus(); current?.select(); uiNotice = t('選択した内容をコピーしてください。', 'Copy the selected text.'); }
    }); }, { secondary: true, icon: 'copy', className: 'small-button' });
    copy.setAttribute('aria-label', t('{label}をコピー', 'Copy {label}', { label }));
    return el('div', 'copy-field', el('span', 'field-label', label), el('div', 'copy-value-row', input, copy));
  }
  function credentials() {
    const card = el('div', 'even-card form-card');
    card.append(el('h3', 'connection-heading', icon(draft.relay === 'gist' ? 'cloud' : 'home'), draft.relay === 'gist' ? 'GitHub Gist' : 'Muse Gadget SDK'));
    if (draft.relay === 'gist') {
      card.append(field('gistId', t('Gist ID または URL', 'Gist ID or URL'), 'https://gist.github.com/…'), field('githubToken', t('GitHub トークン', 'GitHub token'), 'gist scope', true));
      card.append(hint(t('Gistの保存内容', 'Gist storage'), t('Secret Gist も、URL を知る人は閲覧できます。音声や画像は履歴に残ります。', 'Anyone with a secret Gist URL can read it. Audio and images remain in revision history.')));
      card.append(el('div', 'link-row', externalLink(t('Gist を作成', 'Create a Gist'), 'https://gist.github.com/'), externalLink(t('トークンを取得', 'Get a token'), 'https://github.com/settings/tokens/new?scopes=gist&description=Muse%20Relay')));
      const setup = el('details', 'gist-initializer', el('summary', '', t('初めて Gist を作る', 'Create your first Gist')), copyValue(t('ファイル名', 'Filename'), 'g2muse-relay.json', 'gist-filename'), copyValue(t('初期内容', 'Initial content'), '{"messages":[]}', 'gist-content'));
      setup.open = gistInitializerOpen; setup.addEventListener('toggle', () => { gistInitializerOpen = setup.open; }); card.append(setup);
    } else {
      card.append(importConnection(), field('relayUrl', t('中継サーバー URL', 'Relay server URL'), 'https://relay.example.com'), field('relayToken', t('スマートフォン用トークン', 'Phone access token'), '', true));
      card.append(hint(t('中継サーバー URL', 'Relay server URL'), t('外出先から接続できる HTTPS URL を入力します。', 'Use an HTTPS URL reachable when you are away from home.')));
      card.append(hostingKey('gatewayToken'), originSettings());
    }
    return card;
  }
  function hostingKey(key: 'gatewayToken' | 'sonioxGatewayToken') {
    const isSoniox = key === 'sonioxGatewayToken';
    const details = el('details', 'gist-initializer', el('summary', '', t('ホスティング用接続キー（任意）', 'Hosting access key (optional)')),
      field(key, isSoniox ? t('一時キー発行先の接続キー', 'Access key for the token endpoint') : t('中継ホスティングの接続キー', 'Access key for relay hosting'), '', true));
    details.open = isSoniox ? sonioxGatewayHelpOpen : gatewayHelpOpen;
    details.addEventListener('toggle', () => { if (isSoniox) sonioxGatewayHelpOpen = details.open; else gatewayHelpOpen = details.open; });
    return details;
  }
  function originSettings() {
    const details = el('details', 'gist-initializer', el('summary', '', t('サーバー側の接続設定', 'Connection settings for your server')),
      copyValue(t('このアプリの接続元（Origin）', 'This app’s origin'), window.origin, 'app-origin'),
      hint(t('このアプリの接続元（Origin）', 'This app’s origin'), t('サーバー設定画面の「アプリの許可 Origin」へコピーします。Even アプリ内で表示した値を使ってください。', 'Copy this into “Allowed app origins” on your server setup page. Use the value shown inside the Even app.')));
    details.open = originHelpOpen; details.addEventListener('toggle', () => { originHelpOpen = details.open; });
    return details;
  }
  function voiceOptions() {
    const card = el('div', '');
    const title = t('文字起こし先', 'Transcription service');
    const heading = el('h3', 'section-title', title); heading.id = 'voice-service';
    const choices = el('fieldset', 'relay-choices'); choices.setAttribute('aria-labelledby', heading.id);
    card.append(withHint(heading, title, () => el('dl', 'voice-help',
      el('dt', '', voiceTitle('soniox')), el('dd', '', t('音声認識はSonioxが行います。アプリは字幕を表示し、中継には確定した文字だけを送ります。', 'Soniox transcribes the audio. The app displays the captions and sends only the final text to your relay.')),
      el('dt', '', voiceTitle('muse')), el('dd', '', t('録音中の音声は中継に送りません。送信した音声の文字起こしが中継先から返ると、チャットに表示します。', 'Audio is not streamed to the relay while you speak. If the relay returns a transcript of your audio message, it appears in chat.')))));
    for (const mode of ['soniox', 'muse'] as const) {
      const input = el('input', 'even-radio'); input.type = 'radio'; input.name = 'voice'; input.value = mode; input.checked = draft.voice === mode;
      focusKey(input, `voice-${mode}`);
      input.addEventListener('change', () => { changed('voice', mode); render(); });
      const detail = mode === 'soniox' ? t('話している間、G2とスマホに字幕を表示', 'Show words on glasses and phone as you speak')
        : t('送信時に音声ファイルを{relay}へ', 'Send the audio file to {relay} on submit', { relay: audioRelay() });
      choices.append(el('label', `relay-choice ${draft.voice === mode ? 'is-selected' : ''}`, icon(mode === 'soniox' ? 'glasses' : 'network'),
        el('span', 'choice-copy', el('strong', '', voiceTitle(mode)), el('span', '', detail)), input));
    }
    card.append(choices);
    const options = el('div', 'even-card');
    if (draft.voice === 'soniox') options.append(sonioxSettings());
    options.append(select('mic', t('マイク', 'Microphone'), [['glasses', t('G2 グラス', 'G2 glasses')], ['phone', t('スマートフォン', 'Phone')]]));
    if (draft.mic === 'glasses') {
      const speakers = select('speakerFilter', t('録音対象', 'Record voices'), [
        ['all', t('すべて（そのまま）', 'All (unchanged)')], ['self', t('自分のみ', 'Only me')], ['other', t('他の人のみ', 'Only others')],
      ]);
      speakers.classList.add('speaker-filter-row'); options.append(withHint(speakers, t('録音対象', 'Record voices'), t('判定不明の音声は除外します。', 'Unclassified audio is excluded.')));
    } else {
      options.append(el('div', 'even-row speaker-filter-row', el('span', 'even-row-label', t('録音対象', 'Record voices')), el('span', 'speaker-filter-value', t('すべて（そのまま）', 'All (unchanged)'))),
        hint(t('録音対象', 'Record voices'), t('話者の選択はG2マイクで利用できます。', 'Speaker selection is available with the G2 microphone.')));
    }
    options.append(withHint(toggle(t('画像を使用', 'Enable images'), draft.images, value => { changed('images', value); if (!value) attachment = undefined; render(); }), t('画像を使用', 'Enable images'), t('Museからの画像をG2にも表示します。送信は中継側の対応時のみ利用できます。', 'Display images from Muse on G2 too. Sending images requires relay support.')));
    card.append(options);
    return card;
  }
  function voiceReadiness(settings = draft) {
    try {
      const connection = resolveSonioxConnection(settings);
      const test = voiceTest?.signature === voiceSignature(settings) ? voiceTest : null;
      return { kind: test?.ok ? 'configured' : 'unknown', label: test?.ok ? t('Soniox 接続確認済み', 'Soniox connection verified') : t('音声接続は未確認', 'Voice connection not checked'), blocked: false, connection };
    } catch { return { kind: 'missing', label: sonioxAuthMode(settings) === 'api-key' ? t('Soniox APIキーを入力', 'Enter a Soniox API key') : t('文字起こしの接続設定が必要', 'Transcription connection needs setup'), blocked: true }; }
  }
  function sonioxSettings() {
    const mode = sonioxAuthMode(draft);
    const panel = el('div', 'soniox-settings form-card');
    panel.append(select('sonioxAuth', t('Soniox 接続方法', 'Soniox connection'), [['api-key', t('APIキーを入力', 'Enter API key')], ['token-server', t('一時キー発行サーバー', 'Temporary key server')]], undefined, mode));
    if (mode === 'api-key') {
      panel.append(withHint(field('sonioxApiKey', t('Soniox APIキー', 'Soniox API key'), '', true), t('APIキーの保存先', 'API key storage'),
        t('本人用のキーをEvenアプリの設定と端末バックアップに保存し、Sonioxへの接続にだけ使います。Muse・Gist・中継へは送りません。端末に保存しない場合は一時キー発行サーバーを選びます。', 'Your personal key is saved in Even app settings and the device backup, and used only to connect to Soniox. It is not sent to Muse, Gist or the relay. Choose a temporary key server to keep the key off this device.')),
        externalLink(t('APIキーを取得', 'Get an API key'), 'https://console.soniox.com/'));
    } else if (draft.relay === 'gadget' && !draft.sonioxTokenUrl.trim() && !sonioxDetailsOpen) {
      panel.append(el('div', 'connection-route', icon('network'), t('中継から一時キーを取得', 'Temporary key from your relay')),
        button(t('別のサーバーを使う', 'Use another server'), () => { sonioxDetailsOpen = true; render(); }, { secondary: true, className: 'full-width' }));
    } else {
      panel.append(field('sonioxTokenUrl', t('一時キー発行 URL', 'Temporary key endpoint'), 'https://relay.example.com/v1/soniox-token'), field('sonioxTokenAuth', t('発行サーバーのトークン', 'Token endpoint access token'), '', true), hostingKey('sonioxGatewayToken'), originSettings());
      if (draft.relay === 'gadget') panel.append(button(t('中継の接続設定を使う', 'Use the relay connection'), () => { for (const key of ['sonioxTokenUrl', 'sonioxTokenAuth', 'sonioxGatewayToken'] as const) changed(key, ''); sonioxDetailsOpen = false; render(); }, { secondary: true, className: 'full-width' }));
    }
    if (mode === 'token-server') panel.append(hint(t('一時キー発行サーバー', 'Temporary key server'), t('発行サーバーは長期キーを保管し、一時キーを発行します。音声はアプリからSonioxへ直接送ります。', 'The server keeps the long-lived key and issues temporary keys. Audio goes directly from the app to Soniox.')));
    const ready = voiceReadiness();
    const test = voiceTest?.signature === voiceSignature() ? voiceTest : null;
    const status = el('p', `voice-check-status ${test && !test.ok ? 'error' : ''}`, test?.message || ready.label); status.setAttribute('role', 'status');
    panel.append(status, withHint(button(working && feedbackLocation === 'voice' ? t('確認中…', 'Checking…') : t('Sonioxへの接続を確認', 'Check Soniox connection'), () => { void run(async () => {
      const settings = { ...draft }, checked = voiceSignature(settings); voiceTest = null;
      try { await checkSonioxConnection(settings); voiceTest = { signature: checked, ok: true, message: t('Soniox 接続確認済み', 'Soniox connection verified') }; }
      catch (error) {
        const code = error instanceof Error ? error.message : '';
        const message = code === 'Soniox 401' ? t('APIキーを確認してください。', 'Check your API key.') : code === 'Soniox 402' ? t('Sonioxの残高・利用上限を確認してください。', 'Check your Soniox balance and usage limits.') : t('Sonioxに接続できませんでした。設定を確認して再試行してください。', 'Could not connect to Soniox. Check the settings and retry.');
        voiceTest = { signature: checked, ok: false, message };
      }
    }, 'voice'); }, { icon: 'refresh', className: 'full-width', disabled: !editable() || ready.blocked }), t('Sonioxへの接続を確認', 'Check Soniox connection'),
      t('1秒の無音データで接続を確認します。マイクは使わず、Museにも送信しません。Sonioxの利用量に計上される場合があります。', 'Checks a session with one second of silence. No microphone is used and nothing is sent to Muse. This may count toward Soniox usage.')));
    return panel;
  }
  function promptPanel() {
    const panel = el('div', 'prompt-panel');
    panel.append(button(t('Muse に渡す設定手順', 'Setup instructions for Muse'), () => { promptOpen = !promptOpen; render(); }, { secondary: true, icon: 'copy', className: 'full-width' }));
    if (promptOpen) {
      const text = el('textarea', 'even-input prompt-text'); text.readOnly = true; text.value = museSetupPrompt(draft); text.rows = 8;
      text.setAttribute('aria-label', t('Muse に渡す設定手順', 'Setup instructions for Muse')); focusKey(text, 'prompt');
      panel.append(text, button(t('コピー', 'Copy'), () => { void run(async () => {
        try { await navigator.clipboard.writeText(text.value); uiNotice = t('コピーしました。Muse に貼り付けてください。', 'Copied. Paste it into Muse.'); }
        catch { const current = root.querySelector<HTMLTextAreaElement>('[data-focus="prompt"]'); current?.focus(); current?.select(); uiNotice = t('手順を選択しました。コピーしてください。', 'Instructions selected. Copy the text.'); }
      }); }, { icon: 'copy', secondary: true }), hint(t('Muse に渡す設定手順', 'Setup instructions for Muse'), t('選択中の方式から依頼文を作ります。キーや接続先は含めません。スペースとアバターはそれぞれの追加画面から依頼します。', 'The request follows your selected settings and excludes keys and endpoints. Request Spaces and an avatar from their own screens.')));
    }
    return panel;
  }
  function checkButton(location: 'connection' | 'voice' = 'connection', label = t('接続を確認', 'Check connection')) {
    return button(working ? t('確認中…', 'Checking…') : label, () => { void run(async () => {
      testResult = null;
      const checkedSettings = { ...draft }; const checkedSignature = signature(checkedSettings);
      const result = await controller.checkConnection(checkedSettings);
      testResult = result; testedSignature = checkedSignature;
    }, location); }, { icon: 'refresh', disabled: !editable(), className: 'full-width' });
  }
  function checkSummary() {
    const box = el('div', 'check-summary');
    const feedback = notifications('connection'); if (feedback.childNodes.length) box.append(feedback);
    if (!testResult || testedSignature !== signature()) return box;
    const row = (label: string, result: string, success: boolean) => el('div', 'check-row', icon(success ? 'check' : 'pause'), el('span', '', label), el('span', 'check-value', result));
    box.append(row(t('中継サーバー', 'Relay'), t('応答あり', 'Responding'), true));
    if (draft.relay === 'gadget') box.append(row('Muse Gadget', testResult.device?.connected ? t('オンライン', 'Online') : t('接続待ち', 'Waiting'), Boolean(testResult.device?.connected)));
    if (draft.voice === 'soniox') { const readiness = voiceReadiness(); box.append(row('Soniox', readiness.label, readiness.kind === 'configured')); }
    box.append(row(t('メッセージ', 'Messages'), String(testResult.messages.length), true), row(t('スペース', 'Spaces'), String(testResult.spaces.length), true));
    return box;
  }
  function wizardContent() {
    const labels = [t('中継方式', 'Relay'), t('接続設定', 'Connection'), t('音声と画像', 'Voice & images'), t('接続確認', 'Check')];
    const content = el('main', 'page wizard-page');
    const progress = el('ol', 'setup-steps'); progress.setAttribute('aria-label', t('設定の手順', 'Setup steps'));
    labels.forEach((label, i) => { const li = el('li', i === step ? 'current' : i < step ? 'complete' : '', el('span', 'step-number', i < step ? icon('check') : String(i + 1)), el('span', '', label)); if (i === step) li.setAttribute('aria-current', 'step'); progress.append(li); });
    const sections: GuideSection[] = ['setup', 'connection', 'voice', 'connection'];
    content.append(progress, el('div', 'page-toolbar', el('h2', 'page-title', labels[step]), guideLink(t('セットアップガイド', 'Setup guide'), sections[step])));
    if (step === 0) content.append(relayChoice());
    if (step === 1) content.append(credentials());
    if (step === 2) content.append(voiceOptions(), flow());
    if (step === 3) content.append(flow(), promptPanel(), checkButton(), checkSummary(), hint(t('接続確認', 'Check'), t('中継の応答を確認します。Muse の返答は、設定後にメッセージを送って確認します。', 'This checks the relay. Send a message after setup to verify a Muse reply.')));
    content.append(notifications());
    const actions = el('div', 'wizard-actions');
    if (step > 0) actions.append(button(t('戻る', 'Back'), () => { step--; uiError = ''; render(); }, { secondary: true, icon: 'back', disabled: working }));
    if (step < 3) actions.append(button(t('次へ', 'Next'), () => {
      feedbackLocation = 'page';
      if (step === 1 && !(draft.relay === 'gist' ? draft.gistId.trim() && draft.githubToken.trim() : draft.relayUrl.trim() && draft.relayToken.trim())) { uiError = t('接続先とトークンを入力してください。', 'Enter the endpoint and access token.'); render(); return; }
      if (step === 2 && draft.voice === 'soniox' && ['missing', 'invalid'].includes(voiceReadiness().kind)) { uiError = t('Sonioxを設定するか、「{method}」を選んでください。', 'Set up Soniox or choose “{method}”.', { method: voiceTitle('muse') }); render(); return; }
      step++; uiError = ''; render(); window.scrollTo({ top: 0 });
    }, { icon: 'arrow', disabled: working }));
    else actions.append(button(t('保存して開く', 'Save and open'), () => { void run(async () => {
      await controller.saveSettings({ ...draft, configured: true }); draft.configured = true; settingsDirty = false; wizard = false; view = 'chat';
    }); }, { icon: 'check', disabled: working || testedSignature !== signature() || !testResult }));
    content.append(actions, button(t('後で設定する', 'Set up later'), () => { wizard = false; view = 'chat'; render(); }, { secondary: true, className: 'quiet-button' }));
    return content;
  }
  function date(ts: number) {
    return new Date(ts * 1000).toLocaleString(resolveLocale(draft.language), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function imagePreview(image: Attachment, className = '') {
    if (!/^image\/(png|jpeg|webp)$/.test(image.mime) || !/^[a-zA-Z0-9+/=\s]+$/.test(image.data_base64)) return el('span', 'even-help', t('この画像形式は表示できません。', 'This image format cannot be displayed.'));
    const img = el('img', `attachment-image ${className}`); img.src = `data:${image.mime};base64,${image.data_base64}`; img.alt = image.name || t('添付画像', 'Attached image'); return img;
  }
  function enableImages() {
    return el('div', '', small(t('画像を受信しました。画像の表示はオフです。', 'Image received. Image display is off.')),
      button(t('画像を有効にする', 'Enable images'), () => { void run(async () => {
        await controller.saveSettings({ ...controller.state.settings, images: true }); draft.images = true;
        uiNotice = t('画像を有効にしました。「グラスに表示」で開けます。', 'Images enabled. Open one with “Show on glasses”.');
      }); }, { secondary: true, icon: 'image', className: 'small-button', disabled: !editable() }));
  }
  function messageCard(message: Message) {
    const received = message.from.toLowerCase() !== 'you';
    const unread = !controller.state.readIds.includes(message.id) && received;
    const article = el('article', `message-card ${unread ? 'is-unread' : ''}`);
    const time = el('time', '', date(message.ts)); time.dateTime = new Date(message.ts * 1000).toISOString();
    article.append(el('div', 'message-meta', el('span', 'sender', message.from), time, received ? el('span', unread ? 'unread-mark' : 'read-mark', unread ? t('未読', 'Unread') : t('既読', 'Read')) : null));
    article.append(el('p', 'message-body', message.text || (message.type === 'voice-note' ? t('音声メモ', 'Voice note') : t('画像', 'Image'))));
    if (!controller.state.settings.images && (message.image || message.image_file)) article.append(enableImages());
    if (controller.state.settings.images && message.image) article.append(imagePreview(message.image));
    else if (controller.state.settings.images && message.image_file) article.append(button(t('画像を読み込む', 'Load image'), () => { void run(() => controller.loadMessageImage(message.id)); }, { secondary: true, icon: 'image', disabled: !editable(), className: 'small-button' }));
    const actions = el('div', 'message-actions', button(t('グラスに表示', 'Show on glasses'), () => { void run(() => controller.showMessage(message.id)); }, { secondary: true, icon: 'glasses', className: 'small-button', disabled: !editable() }));
    if (unread) actions.append(button(t('既読にする', 'Mark read'), () => { void run(() => controller.markRead([message.id])); }, { secondary: true, icon: 'check', className: 'small-button', disabled: !editable() }));
    actions.append(button(t('非表示', 'Hide'), () => { void run(() => controller.hideMessages([message.id])); }, { secondary: true, className: 'small-button quiet-button hide-message', disabled: !editable() }));
    article.append(actions); return article;
  }
  function visibleMessages() {
    const s = controller.state;
    return s.snapshot.messages.filter(message => !s.hiddenIds.includes(message.id)).slice().sort((a, b) => b.ts - a.ts);
  }
  function historyCandidates(mode = historyMode) {
    const messages = visibleMessages();
    return mode === 'older' ? messages.slice(10) : messages.filter(message => controller.state.readIds.includes(message.id) || message.from.toLowerCase() === 'you');
  }
  function notConfigured() {
    const box = el('div', 'empty-state', icon('network'), el('h2', '', t('中継を設定してください', 'Set up a relay')),
      button(t('接続を設定', 'Set up connection'), () => { wizard = true; step = 0; render(); }, { icon: 'arrow' }));
    return box;
  }
  function chatContent() {
    const content = el('div', 'chat-content');
    const s = controller.state;
    const visible = visibleMessages();
    const unread = visible.filter(m => !s.readIds.includes(m.id) && m.from.toLowerCase() !== 'you').length;
    const toolbar = el('div', 'page-toolbar', el('h2', 'page-title', t('チャット', 'Chat')), el('span', 'muted', unread ? t('{count} 件未読', '{count} unread', { count: unread }) : t('すべて既読', 'All read')),
      button(t('更新', 'Refresh'), () => { void run(() => controller.refresh()); }, { secondary: true, icon: 'refresh', className: 'small-button', disabled: !s.settings.configured || !editable() }));
    content.append(toolbar);
    if (!s.settings.configured) content.append(notConfigured());
    content.append(composerForm());
    if (s.recording || s.transcript) {
      const live = el('section', `recording-panel ${s.recording ? 'is-recording' : ''}`, el('div', 'recording-title', icon('mic'), el('span', '', s.recording ? t('録音中', 'Recording') : t('文字起こし', 'Transcript'))));
      const text = el('p', 'transcript', s.transcript || t('話してください', 'Start speaking')); text.setAttribute('aria-live', 'polite'); live.append(text);
      if (s.recording) live.append(button(t('取り消す', 'Cancel'), () => { void run(() => controller.cancelRecording()); }, { secondary: true, className: 'small-button' }));
      content.append(live);
    }
    if (s.settings.configured) {
      content.append(el('div', 'history-toolbar', el('span', 'muted', t('新しい順', 'Newest first')),
        button(t('履歴を整理', 'Manage history'), () => { historyOpen = true; render(); }, { secondary: true, className: 'small-button', disabled: !editable() || (!visible.length && !s.hiddenIds.length) })));
      if (!visible.length) content.append(el('div', 'empty-state', icon('chat'), el('h3', '', t('メッセージはありません', 'No messages yet')),
        s.hiddenIds.length ? button(t('非表示を戻す', 'Restore hidden messages'), () => { void run(() => controller.restoreHiddenMessages()); }, { secondary: true, icon: 'back', disabled: !editable() }) : null));
      else { const timeline = el('div', 'message-list'); visible.forEach(m => timeline.append(messageCard(m))); content.append(timeline); }
    }
    return content;
  }
  function composerForm() {
    const s = controller.state;
    const form = el('form', 'composer');
    const input = el('textarea', 'even-input composer-input'); input.value = composer; input.rows = 2; input.maxLength = 6000;
    input.placeholder = t('Muse にメッセージ', 'Message Muse'); input.setAttribute('aria-label', t('メッセージ', 'Message')); focusKey(input, 'composer');
    input.disabled = !s.settings.configured || s.recording;
    input.addEventListener('input', () => { composer = input.value; const send = form.querySelector<HTMLButtonElement>('[data-send]'); if (send) send.disabled = !s.settings.configured || !editable() || s.recording || (!composer.trim() && !attachment); });
    form.append(input);
    if (attachment) form.append(el('div', 'attachment-preview', imagePreview(attachment), button(t('画像を外す', 'Remove image'), () => { attachment = undefined; render(); }, { secondary: true, icon: 'close', className: 'small-button' })));
    const controls = el('div', 'composer-actions');
    const voice = s.settings.voice === 'soniox' ? voiceReadiness(s.settings) : null;
    const record = button(s.recording ? t('停止して送信', 'Stop and send') : t('音声', 'Voice'), () => { void run(() => controller.toggleRecording()); }, { secondary: !s.recording, icon: s.recording ? 'pause' : 'mic', disabled: !s.settings.configured || (!s.recording && (!editable() || Boolean(voice?.blocked))) });
    record.setAttribute('aria-pressed', String(s.recording)); controls.append(record);
    const canSendImages = s.settings.relay === 'gist' || s.snapshot.capabilities?.images === true;
    if (s.settings.images && canSendImages) {
      const imageDisabled = !s.settings.configured || !editable() || s.recording;
      for (const source of ['album', 'camera'] as const) controls.append(button(source === 'album' ? t('写真', 'Photo') : t('カメラ', 'Camera'), () => { void run(async () => { const picked = await controller.pickImage(source); if (picked) attachment = picked; }); }, { secondary: true, icon: source === 'album' ? 'image' : 'camera', className: 'small-button', disabled: imageDisabled }));
    }
    const send = button(t('送信', 'Send'), () => {}, { icon: 'send', disabled: !s.settings.configured || !editable() || s.recording || (!composer.trim() && !attachment), className: 'send-button' });
    send.type = 'submit'; send.dataset.send = ''; controls.append(send); form.append(controls);
    if (s.settings.configured && voice?.blocked) form.append(small(voice.label), button(t('音声設定を開く', 'Open voice settings'), openVoiceSettings, { secondary: true, icon: 'settings', className: 'small-button' }));
    if (s.settings.images && !canSendImages) form.append(withHint(el('p', 'composer-capability', icon('image'), t('画像は Muse からの受信のみ', 'Images from Muse only')), t('画像を送信', 'Send images'), capabilityHelp));
    form.addEventListener('submit', event => {
      event.preventDefault();if (!composer.trim() && !attachment) return;
      const submittedText=composer,submittedImage=attachment;
      void run(async () => {
        await controller.sendText(submittedText.trim(), submittedImage);
        if(composer===submittedText)composer='';
        if(attachment===submittedImage)attachment=undefined;
      });
    });
    return form;
  }
  function spaceCard(id: string, index: number) {
    const s = controller.state;
    const space = s.snapshot.spaces.find(item => item.id === id);
    const title = space?.title || t('未受信のスペース', 'Space not received');
    const card = el('article', 'even-card space-card');
    if (editingSpaces) card.append(el('h3', 'space-card-title', title));
    else card.append(button(title, () => { activeSpace = id; render(); window.scrollTo({ top: 0 }); }, { secondary: true, icon: 'arrow', className: 'space-open', disabled: !space }));
    const actions = el('div', 'space-actions', el('span', 'muted', space ? t('{count} 件', '{count} items', { count: space.items.length }) : id));
    if (editingSpaces) {
      const move = (offset: number) => { void run(async () => {
        const ids = [...controller.state.selectedSpaceIds], from = ids.indexOf(id), to = from + offset;
        if (from < 0 || to < 0 || to >= ids.length) return;
        [ids[from], ids[to]] = [ids[to]!, ids[from]!]; await controller.selectSpaces(ids);
      }); };
      const up = button('↑', () => move(-1), { secondary: true, className: 'small-button space-move', disabled: !editable() || index === 0 });
      up.setAttribute('aria-label', t('{name}を上へ', 'Move {name} up', { name: title }));
      const down = button('↓', () => move(1), { secondary: true, className: 'small-button space-move', disabled: !editable() || index === s.selectedSpaceIds.length - 1 });
      down.setAttribute('aria-label', t('{name}を下へ', 'Move {name} down', { name: title }));
      actions.append(up, down, button(t('削除', 'Remove'), () => { spaceToRemove = { id, title }; render(); }, { secondary: true, className: 'small-button danger-button', disabled: !editable() }));
    }
    card.append(actions);
    return card;
  }
  function spaceExamples(): {id: SpaceExample; label: string; options: SpacePromptOptions}[] {
    return [
      { id: 'schedule', label: t('予定', 'Schedule'), options: { name: t('今日の予定', 'Today’s schedule'), purpose: t('今日と明日の予定を一覧にし、ボタンで要約する。', 'List today’s and tomorrow’s events, with a button to summarize them.'), layout: 'list', controls: ['button', 'choice'] } },
      { id: 'focus', label: t('集中タイマー', 'Focus timer'), options: { name: t('集中タイマー', 'Focus timer'), purpose: t('集中時間を5〜60分で選び、開始・停止と残り時間を表示する。', 'Choose 5–60 minutes of focus time, with start/stop controls and time remaining.'), layout: 'list', controls: ['slider', 'button'] } },
      { id: 'notes', label: t('音声メモ', 'Voice notes'), options: { name: t('音声メモ', 'Voice notes'), purpose: t('音声でメモを追加し、日時と文字起こしを新しい順に表示する。', 'Add voice notes and show their dates and transcripts, newest first.'), layout: 'cards', controls: ['microphone'] } },
    ];
  }
  function useSpaceExample(id: SpaceExample) {
    const example = spaceExamples().find(item => item.id === id)!;
    spaceExample = id; spaceCreation = { ...example.options, controls: [...example.options.controls] };
  }
  function spaceCreationField(key: 'name' | 'purpose', label: string) {
    const row = el('label', 'field', el('span', 'field-label', label));
    const input = key === 'purpose' ? el('textarea', 'even-input') : el('input', 'even-input');
    if (input instanceof HTMLTextAreaElement) input.rows = 3;
    input.value = spaceCreation![key]; input.maxLength = key === 'name' ? 60 : 400;
    input.setAttribute('aria-label', label); focusKey(input, `space-create-${key}`);
    input.addEventListener('input', () => {
      spaceCreation![key] = input.value;
      const next = root.querySelector<HTMLButtonElement>('[data-space-create]');
      if (next) next.disabled = !spaceCreation!.name.trim() || !spaceCreation!.purpose.trim();
    });
    row.append(input); return row;
  }
  function addToChatDraft(request: string): boolean {
    const next = composer.trim() ? `${composer}\n\n${request}` : request;
    if (next.length > 6000) { feedbackLocation = 'page'; uiError = t('下書きが長すぎます。コピーを使ってください。', 'Draft is too long. Use Copy.'); render(); return false; }
    composer = next; view = 'chat'; uiError = ''; uiNotice = t('下書きに追加しました。', 'Added to draft.'); feedbackLocation = 'page';
    return true;
  }
  function spaceAddContent() {
    const s = controller.state;
    const content = el('div', 'spaces-content');
    content.append(button(t('スペース一覧', 'All spaces'), () => { spaceAddPage = null; render(); window.scrollTo({ top: 0 }); }, { secondary: true, icon: 'back', className: 'quiet-button' }),
      el('h2', 'page-title', t('スペースを追加', 'Add a space')));
    if (spaceAddPage === 'choose') {
      content.append(el('div', 'space-add-choices',
        button(t('Museに作成を依頼', 'Ask Muse to create'), () => { if (!spaceCreation) useSpaceExample('schedule'); spaceAddPage = 'create'; render(); }, { icon: 'chat', className: 'full-width' }),
        button(t('受信済みから追加', 'Add an exported space'), () => { spaceAddPage = 'receive'; render(); }, { secondary: true, icon: 'spaces', className: 'full-width' })));
      return content;
    }
    const currentStep = spaceAddPage === 'register' ? 2 : spaceAddPage === 'receive' ? 1 : 0;
    const progress = el('ol', 'setup-steps space-add-steps'); progress.setAttribute('aria-label', t('スペース追加の手順', 'Steps to add a space'));
    [t('Museへ依頼', 'Ask Muse'), t('更新', 'Refresh'), t('追加', 'Add')].forEach((label, index) => {
      const item = el('li', index === currentStep ? 'current' : index < currentStep ? 'complete' : '', el('span', 'step-number', String(index + 1)), el('span', '', label));
      if (index === currentStep) item.setAttribute('aria-current', 'step'); progress.append(item);
    }); content.append(progress);
    if (spaceAddPage === 'create') {
      const form = el('div', 'even-card form-card');
      const presets = el('label', 'field', el('span', 'field-label', t('例から始める', 'Start from an example')));
      const preset = el('select', 'even-input'); preset.setAttribute('aria-label', t('例から始める', 'Start from an example')); focusKey(preset, 'space-example');
      for (const example of spaceExamples()) { const option = el('option', '', example.label); option.value = example.id; option.selected = spaceExample === example.id; preset.append(option); }
      preset.addEventListener('change', () => { useSpaceExample(preset.value as SpaceExample); render(); }); presets.append(preset);
      form.append(presets, spaceCreationField('name', t('名前', 'Name')), spaceCreationField('purpose', t('用途', 'Purpose')));
      const layout = el('fieldset', 'space-layout-choices', el('legend', 'field-label', t('表示形式', 'Layout')));
      for (const mode of ['list', 'cards'] as const) {
        const input = el('input', 'even-radio'); input.type = 'radio'; input.name = 'space-layout'; input.checked = spaceCreation!.layout === mode;
        input.addEventListener('change', () => { spaceCreation!.layout = mode; render(); });
        const preview = el('span', `space-layout-preview preview-${mode}`, el('i'), el('i'), el('i')); preview.setAttribute('aria-hidden', 'true');
        layout.append(el('label', `space-layout-option ${input.checked ? 'is-selected' : ''}`, preview, el('span', '', mode === 'list' ? t('リスト', 'List') : t('カード', 'Cards')), input));
      }
      form.append(layout);
      const controls = el('fieldset', 'space-control-choices', el('legend', 'field-label', t('追加する操作', 'Controls to include')));
      const types: [SpacePromptControl, string][] = [['button', t('ボタン', 'Button')], ['slider', t('スライダー', 'Slider')], ['choice', t('選択肢', 'Choice')], ['microphone', t('マイク', 'Microphone')]];
      for (const [type, label] of types) controls.append(toggle(label, spaceCreation!.controls.includes(type), checked => { spaceCreation!.controls = checked ? [...spaceCreation!.controls, type] : spaceCreation!.controls.filter(item => item !== type); }));
      form.append(controls); content.append(form);
      const next = button(t('依頼文を作る', 'Create request'), () => { spaceAddPage = 'prompt'; render(); window.scrollTo({ top: 0 }); }, { icon: 'arrow', className: 'full-width', disabled: !spaceCreation!.name.trim() || !spaceCreation!.purpose.trim() }); next.dataset.spaceCreate = '';
      content.append(el('div', 'wizard-actions', next));
    } else if (spaceAddPage === 'prompt') {
      const request = spacePrompt(s.settings, spaceCreation!);
      content.append(el('div', 'page-toolbar', el('h3', '', spaceCreation!.name), el('span', 'muted', s.settings.relay === 'gist' ? 'GitHub Gist' : 'Muse Gadget SDK')));
      const text = el('textarea', 'even-input prompt-text'); text.readOnly = true; text.value = request; text.rows = 9; text.setAttribute('aria-label', t('Museへの依頼文', 'Request for Muse')); focusKey(text, 'space-prompt');
      content.append(text, el('div', 'space-prompt-actions',
        button(t('コピー', 'Copy'), () => { void run(async () => {
          try { await navigator.clipboard.writeText(request); uiNotice = t('コピーしました。Muse に貼り付けてください。', 'Copied. Paste it into Muse.'); }
          catch { const current = root.querySelector<HTMLTextAreaElement>('[data-focus="space-prompt"]'); current?.focus(); current?.select(); uiNotice = t('選択した内容をコピーしてください。', 'Copy the selected text.'); }
        }); }, { icon: 'copy', disabled: !editable() }),
        button(t('チャットの下書きへ', 'Add to chat draft'), () => {
          if (!addToChatDraft(request)) return;
          spaceAddPage = 'receive'; render(); window.scrollTo({ top: 0 });
        }, { secondary: true, icon: 'chat' })));
      content.append(el('div', 'wizard-actions', button(t('編集', 'Edit'), () => { spaceAddPage = 'create'; render(); }, { secondary: true, icon: 'back' }),
        button(t('受信を確認', 'Check for received spaces'), () => { spaceAddPage = 'receive'; render(); window.scrollTo({ top: 0 }); }, { icon: 'arrow' })));
    } else {
      if (!s.settings.configured) { content.append(notConfigured()); return content; }
      const registrationFull = s.selectedSpaceIds.length >= 15;
      content.append(el('div', 'page-toolbar', el('span', 'muted', t('追加済み', 'Added')), el('span', 'muted', `${s.selectedSpaceIds.length} / 15`)));
      content.append(button(working ? t('確認中…', 'Checking…') : t('更新して受信', 'Refresh to receive'), () => { void run(async () => {
        await controller.refresh(); if (spaceAddPage === 'receive' || spaceAddPage === 'register') spaceAddPage = 'register';
      }); }, { icon: 'refresh', className: 'full-width', disabled: !editable() }));
      if (spaceAddPage === 'register') {
        if (!s.snapshot.spaces.length) content.append(el('div', 'empty-state', icon('spaces'), el('h3', '', t('受信したスペースはありません', 'No spaces received')), button(t('Museへの依頼文を作る', 'Create a request for Muse'), () => { if (!spaceCreation) useSpaceExample('schedule'); spaceAddPage = 'create'; render(); }, { secondary: true, icon: 'chat' })));
        for (const space of s.snapshot.spaces) {
          const added = s.selectedSpaceIds.includes(space.id);
          content.append(el('article', 'even-card space-received', el('div', 'space-received-copy', el('h3', '', space.title), el('span', 'muted', t('{count} 件', '{count} items', { count: space.items.length }))),
            button(added ? t('追加済み', 'Added') : t('追加', 'Add'), () => { void run(() => controller.selectSpaces([...controller.state.selectedSpaceIds, space.id])); }, { secondary: added, icon: added ? 'check' : 'arrow', className: 'small-button', disabled: added || registrationFull || !editable() })));
        }
        content.append(button(t('完了', 'Done'), () => { spaceAddPage = null; editingSpaces = false; render(); window.scrollTo({ top: 0 }); }, { secondary: true, className: 'full-width' }));
      }
    }
    return content;
  }
  function spaceControl(space:Space,item:SpaceItem){
    const control=item.control!,s=controller.state,key=JSON.stringify([space.id,item.id]);
    const block=el('div','space-control');
    const disabled=Boolean(control.disabled)||!editable()||s.recording;
    const action=s.spaceAction?.spaceId===space.id&&s.spaceAction.itemId===item.id?s.spaceAction:undefined;
    const submit=(value?:number|string)=>{void run(()=>controller.submitSpaceAction(space.id,item.id,value));};
    if(control.type==='button')block.append(button(control.label||t('実行','Run'),()=>{
      if(control.confirm){spaceConfirm={spaceId:space.id,itemId:item.id,title:item.title,message:control.confirm};render();}
      else submit();
    },{disabled,className:'small-button'}));
    if(control.type==='slider'||control.type==='choice'){
      const signature=JSON.stringify({...control,value:undefined});
      let draftValue=spaceDrafts.get(key);
      if(draftValue?.signature!==signature){spaceDrafts.delete(key);draftValue=undefined;}
      if(draftValue?.value===control.value){spaceDrafts.delete(key);draftValue=undefined;}
      const value=draftValue?.value??control.value;
      const send=button(t('送信','Send'),()=>submit(spaceDrafts.get(key)?.value??control.value),{disabled,className:'small-button'});
      if(control.type==='slider'){
        const input=el('input','space-range');input.type='range';input.min=String(control.min);input.max=String(control.max);input.step=String(control.step);input.value=String(value);input.disabled=disabled;
        input.setAttribute('aria-label',item.title);focusKey(input,`space-${key}`);
        const output=el('output','space-value',`${value}${control.unit?' '+control.unit:''}`);
        input.addEventListener('input',()=>{const next=sliderValue(control,Number(input.value));spaceDrafts.set(key,{signature,value:next});output.textContent=`${next}${control.unit?' '+control.unit:''}`;});
        input.addEventListener('pointerdown',event=>{draggingSlider=true;input.setPointerCapture(event.pointerId);});
        const finish=()=>{draggingSlider=false;scheduleRender();};
        input.addEventListener('pointerup',finish);input.addEventListener('pointercancel',finish);input.addEventListener('lostpointercapture',finish);
        block.append(el('div','space-slider',el('div','space-value-row',output,el('span','muted',`${control.min}–${control.max}`)),input),send);
      }else{
        const input=el('select','even-input space-choice');input.disabled=disabled;input.setAttribute('aria-label',item.title);focusKey(input,`space-${key}`);
        const placeholder=el('option','',t('選択','Choose'));placeholder.value='';placeholder.disabled=true;input.append(placeholder);
        for(const option of control.options){const node=el('option','',option.title);node.value=option.id;input.append(node);}
        input.value=String(value??'');send.disabled=disabled||!input.value;
        input.addEventListener('change',()=>{spaceDrafts.set(key,{signature,value:input.value});send.disabled=disabled;});block.append(input,send);
      }
    }
    if(control.type==='microphone'){
      const recording=action?.status==='recording';
      block.append(button(recording?t('録音を送信','Send recording'):t('録音を開始','Record voice'),()=>{
        if(recording)void run(()=>controller.toggleRecording());else submit();
      },{icon:'mic',disabled:recording?!s.recording||!editable():disabled,className:'small-button'}));
      if(recording)block.append(button(t('中止','Cancel'),()=>{void run(()=>controller.cancelRecording());},{secondary:true,className:'small-button'}));
      if(recording&&s.transcript)block.append(el('p','space-transcript',s.transcript));
    }
    if(control.disabled)block.append(el('span','muted',control.type==='unsupported'?t('未対応の操作','Unsupported control'):t('利用できません','Unavailable')));
    if(action){const notice=el('p',`space-action-status ${action.status==='error'?'error':''}`,action.message);notice.setAttribute('role',action.status==='error'?'alert':'status');block.append(notice);}
    return block;
  }
  function spacesContent() {
    if (spaceAddPage) return spaceAddContent();
    const s = controller.state;
    const content = el('div', 'spaces-content'); const space = s.snapshot.spaces.find(x => x.id === activeSpace);
    if (space) {
      content.append(button(t('スペース一覧', 'All spaces'), () => { activeSpace = ''; render(); }, { secondary: true, icon: 'back', className: 'quiet-button' }), el('div', 'page-toolbar', el('h2', 'page-title', space.title), button(t('Muse に更新を依頼', 'Ask Muse to refresh'), () => { void run(() => controller.requestSpace(space.id)); }, { secondary: true, icon: 'refresh', className: 'small-button', disabled: !editable() })));
      content.append(button(t('グラスに表示','Show on glasses'),()=>{void run(()=>controller.showSpace(space.id));},{secondary:true,icon:'glasses',className:'small-button'}));
      if (!space.items.length) content.append(el('div', 'empty-state', icon('spaces'), el('h3', '', t('項目はありません', 'No items yet'))));
      const items=el('div',space.layout==='cards'?'space-cards':'even-card space-list');content.append(items);
      for (const item of space.items) {
        const card = el('article', `${space.layout==='cards'?'even-card ':''}space-item`, el('h3', '', item.title));
        if(item.text)card.append(el('p','message-body',item.text));
        if (!s.settings.images && (item.image || item.image_file)) card.append(enableImages());
        if (s.settings.images && item.image) card.append(imagePreview(item.image));
        if(item.control)card.append(spaceControl(space,item));
        else card.append(button(t('グラスに表示', 'Show on glasses'), () => { void run(() => controller.showSpace(space.id, item.id)); }, { secondary: true, icon: 'glasses', className: 'small-button' })); items.append(card);
      }
    } else {
      content.append(el('div', 'page-toolbar', el('h2', 'page-title', t('スペース', 'Spaces')),
        button(t('追加', 'Add'), () => { spaceAddPage = 'choose'; editingSpaces = false; render(); window.scrollTo({ top: 0 }); }, { icon: 'spaces', className: 'small-button' }),
        button(t('更新', 'Refresh'), () => { void run(() => controller.refresh()); }, { secondary: true, icon: 'refresh', className: 'small-button', disabled: !s.settings.configured || !editable() })));
      if (!s.settings.configured) content.append(notConfigured());
      else if (!s.selectedSpaceIds.length) content.append(el('div', 'empty-state', icon('spaces'), el('h3', '', t('スペースはまだありません', 'No spaces yet')),
        el('p', 'space-add-flow', t('Museへ依頼 → 更新 → 追加', 'Ask Muse → Refresh → Add')),
        button(t('スペースを追加', 'Add a space'), () => { spaceAddPage = 'choose'; render(); }, { icon: 'arrow' })));
      else {
        content.append(el('div', 'history-toolbar', el('span', 'muted', t('グラスと同じ順序', 'Same order on glasses')),
          button(editingSpaces ? t('完了', 'Done') : t('並べ替え・削除', 'Reorder / remove'), () => { editingSpaces = !editingSpaces; render(); }, { secondary: true, className: 'small-button', disabled: !editable() })));
        s.selectedSpaceIds.forEach((id, index) => content.append(spaceCard(id, index)));
      }
    }
    return content;
  }
  function spaceConfirmation(){
    const pending=spaceConfirm!;const dialog=el('dialog','tutorial-dialog');dialog.setAttribute('aria-labelledby','space-confirm-title');
    const title=el('h2','page-title',pending.title);title.id='space-confirm-title';
    dialog.append(title,el('p','message-body',pending.message),el('div','wizard-actions',
      button(t('戻る','Cancel'),()=>{spaceConfirm=undefined;render();},{secondary:true}),
      button(t('実行','Run'),()=>{spaceConfirm=undefined;void run(()=>controller.submitSpaceAction(pending.spaceId,pending.itemId));})));
    dialog.addEventListener('cancel',event=>{event.preventDefault();spaceConfirm=undefined;render();});return dialog;
  }
  function removeSpaceDialog() {
    const pending = spaceToRemove!;
    const dialog = el('dialog', 'tutorial-dialog'); dialog.setAttribute('aria-labelledby', 'remove-space-title');
    const title = el('h2', 'page-title', t('アプリから削除しますか？', 'Remove from the app?')); title.id = 'remove-space-title';
    dialog.append(title, el('p', 'message-body', pending.title), small(t('Museの元のスペースは残ります。受信済みから再追加できます。', 'The original space stays in Muse. You can add the exported space again.')),
      el('div', 'wizard-actions', button(t('戻る', 'Cancel'), () => { spaceToRemove = null; render(); }, { secondary: true }),
        button(t('削除', 'Remove'), () => { spaceToRemove = null; void run(async () => {
          await controller.selectSpaces(controller.state.selectedSpaceIds.filter(id => id !== pending.id));
          if (activeSpace === pending.id) activeSpace = '';
        }); }, { disabled: !editable() })));
    dialog.addEventListener('cancel', event => { event.preventDefault(); spaceToRemove = null; render(); }); return dialog;
  }
  function avatarSettings() {
    const s = controller.state;
    const status = !draft.images ? t('オフ', 'Off') : s.avatarStatus === 'loading' ? t('画像を読み込み中…', 'Loading image…') : s.avatarStatus === 'ready' ? t('受信済み', 'Received') : s.avatarStatus === 'error' ? t('取得できません', 'Could not load') : t('未受信', 'Not received');
    const block = el('div', 'avatar-settings', el('div', 'even-row', el('span', 'even-row-label', t('Museのアバター', 'Muse avatar')), el('span', 'muted', status)));
    if (draft.images && s.snapshot.profile?.avatar) block.append(imagePreview(s.snapshot.profile.avatar, 'avatar-preview'));
    if (!draft.images) block.append(button(t('画像を有効にする', 'Enable images'), () => { changed('images', true); render(); }, { secondary: true, icon: 'image', className: 'full-width' }));
    block.append(button(t('Museにアバターを依頼', 'Ask Muse for avatar'), () => { avatarRequestOpen = !avatarRequestOpen; render(); }, { secondary: true, icon: 'copy', className: 'full-width' }));
    if (avatarRequestOpen) {
      const request = avatarPrompt(draft);
      const text = el('textarea', 'even-input prompt-text'); text.readOnly = true; text.value = request; text.rows = 6; text.setAttribute('aria-label', t('Museへの依頼文', 'Request for Muse')); focusKey(text, 'avatar-prompt');
      block.append(text, el('div', 'space-prompt-actions', button(t('コピー', 'Copy'), () => { void run(async () => {
        try { await navigator.clipboard.writeText(request); uiNotice = t('コピーしました。Muse に貼り付けてください。', 'Copied. Paste it into Muse.'); }
        catch { const current = root.querySelector<HTMLTextAreaElement>('[data-focus="avatar-prompt"]'); current?.focus(); current?.select(); uiNotice = t('選択した内容をコピーしてください。', 'Copy the selected text.'); }
      }); }, { icon: 'copy', disabled: !editable() }), button(t('チャットの下書きへ', 'Add to chat draft'), () => { if (addToChatDraft(request)) { render(); window.scrollTo({ top: 0 }); } }, { secondary: true, icon: 'chat' })));
    }
    return block;
  }
  function settingsContent() {
    const content = el('div', 'settings-content', el('h2', 'page-title', t('設定', 'Settings')));
    const storage = controller.state.persistence;
    content.append(small(storage === 'native' ? t('保存先: Evenアプリ', 'Storage: Even app') : storage === 'local' ? t('保存先: この端末のバックアップ', 'Storage: device backup') : t('設定の保存先を確認できません', 'Settings storage is unavailable')));
    content.append(settingsGroup('connection', t('接続', 'Connection'), draft.relay === 'gist' ? 'GitHub Gist' : 'Muse Gadget SDK', relayChoice(), credentials(), checkButton(), checkSummary(), promptPanel()));
    content.append(settingsGroup('voice', t('音声と画像', 'Voice & images'), draft.voice === 'soniox' ? 'Soniox' : t('中継先', 'Relay'), voiceOptions()));
    const chatLayout = select('chatLayout', t('チャット表示', 'Chat display'), [['exchange', t('入力と回答', 'Input & reply')], ['single', t('1件ずつ', 'One message at a time')]]);
    chatLayout.classList.add('chat-layout-row');
    content.append(settingsGroup('glasses', t('G2 表示', 'G2 display'), draft.autoHideSeconds ? t('{seconds} 秒', '{seconds} seconds', {seconds: draft.autoHideSeconds}) : t('自動非表示オフ', 'Auto-hide off'), el('div', 'even-card',
      chatLayout,
      select('autoHideSeconds', t('自動で非表示', 'Auto-hide display'), [0, 5, 10, 15, 20, 25, 30].map(seconds => [seconds, seconds ? t('{seconds} 秒', '{seconds} seconds', { seconds }) : t('オフ', 'Off')])),
      toggle(t('送信後にチャットへ戻る', 'Return to chat after sending'), draft.returnToChatAfterSend, value => changed('returnToChatAfterSend', value), t('チャット送信のみ', 'Chat messages only')),
      avatarSettings(),
      button(t('復帰操作を試す', 'Try restoring the display'), () => { tutorial = true; tutorialMode = 'chat'; tutorialStep = 4; tutorialDemo = false; render(); }, { secondary: true, icon: 'help', className: 'full-width' }))));
    content.append(settingsGroup('display', t('表示', 'Display'), draft.language === 'system' ? t('端末に合わせる', 'Follow phone') : languageOptions().find(([id]) => id === draft.language)![1], el('div', 'even-card',
      select('theme', t('テーマ', 'Theme'), [['system', t('システム', 'System')], ['light', t('ライト', 'Light')], ['dark', t('ダーク', 'Dark')]], theme),
      select('language', t('表示言語', 'Language'), languageOptions()),
      select('pollSeconds', t('通常の受信間隔', 'Normal receive interval'), [[5, t('5 秒', '5 seconds')], [15, t('15 秒', '15 seconds')], [30, t('30 秒', '30 seconds')], [60, t('60 秒', '60 seconds')]]),
      draft.relay==='gadget'?el('div','even-row',el('span','even-row-label',t('送信後の受信間隔', 'Receive interval after sending')),el('span','muted',t('自動で1秒', '1 second automatically'))):null)));
    content.append(el('div', 'settings-save', button(working ? t('保存中…', 'Saving…') : t('設定を保存', 'Save settings'), () => { if (needsConnectionCheck()) { feedbackLocation = 'connection'; uiError = t('変更した接続先を確認してください。', 'Check the changed connection first.'); settingsGroups.add('connection'); render(); root.querySelector('[data-group="connection"]')?.scrollIntoView({ block: 'start' }); return; } void run(async () => { await controller.saveSettings({ ...draft, configured: draft.configured || connectionChecked() }); draft.configured = controller.state.settings.configured; settingsDirty = false; uiNotice = controller.state.notice; }, 'save'); }, { disabled: !editable(), icon: 'check', className: 'full-width' }), notifications('save'), settingsDirty ? el('p', 'unsaved-status', t('未保存の変更', 'Unsaved changes')) : null));
    content.append(settingsGroup('controls', t('使い方', 'Controls'), t('ガイド・操作練習', 'Guides & practice'), el('div', 'even-card',
      el('div', 'guide-links',
        guideLink(t('セットアップガイド', 'Setup guide'), 'setup'),
        guideLink(t('中継の作り方', 'Build a relay'), 'relay'),
        guideLink(t('要望・不具合を送る', 'Send feedback'), 'feedback')),
      button(t('グラス操作を試す', 'Try the glasses controls'), () => { tutorial = true; tutorialMode = 'chat'; tutorialStep = 0; tutorialDemo = false; render(); }, { secondary: true, icon: 'help', className: 'full-width' }),
      button(t('スペース操作を試す', 'Try the space controls'), () => { tutorial = true; tutorialMode = 'spaces'; tutorialStep = 0; tutorialDemo = false; render(); }, { secondary: true, icon: 'spaces', className: 'full-width' }),
      button(t('接続ウィザードを開く', 'Open setup wizard'), () => { wizard = true; step = 0; render(); }, { secondary: true, icon: 'network', className: 'full-width' }))));
    content.append(button(t('保存した接続情報を削除', 'Remove saved connection details'), () => { confirmForget = true; render(); }, { secondary: true, className: 'danger-button full-width' }));
    return content;
  }
  function navigation() {
    const nav = el('nav', 'even-bottom-bar app-nav'); nav.setAttribute('aria-label', t('アプリメニュー', 'App navigation'));
    for (const [name, label, nameIcon] of [['chat', t('チャット', 'Chat'), 'chat'], ['spaces', t('スペース', 'Spaces'), 'spaces'], ['settings', t('設定', 'Settings'), 'settings']] as const) {
      const b = button(label, () => { view = name; uiError = ''; uiNotice = ''; render(); window.scrollTo({ top: 0 }); }, { secondary: true, icon: nameIcon, className: `nav-button ${name === view ? 'is-current' : ''}` });
      if (name === view) b.setAttribute('aria-current', 'page'); nav.append(b);
    }
    return nav;
  }
  function tutorialDialog() {
    const spaces = tutorialMode === 'spaces';
    const titles = spaces ? [t('リストで選択','Select from a list'),t('ボタンを実行','Run a button'),t('スライダーを調整','Adjust a slider'),t('マイクで入力','Use voice input'),t('ダブルタップで戻る','Double-tap to go back')]
      : [t('スワイプで移動','Swipe to navigate'),t('タップで開く','Tap to open'),t('長押しで話す','Hold to speak'),t('ダブルタップで戻る','Double-tap to go back'),t('非表示から戻る','Restore a hidden display')];
    const instructions = spaces ? [t('上下にスワイプして行を選び、タップ。Contextual Menu でリスト／カード表示を切り替えます。','Swipe to select a row, then tap. Switch list/card view in the contextual menu.'),t('タップで送信。確認画面があるボタンは、もう一度タップで実行します。','Tap to send. A button with confirmation needs another tap to run.'),t('上スワイプで増加、下で減少。タップで送信、ダブルタップで中止。','Swipe up to increase, down to decrease. Tap to send, double-tap to cancel.'),t('マイクの行をタップで録音開始。タップで送信、ダブルタップで中止。','Tap a microphone row to record. Tap to send, double-tap to cancel.'),t('項目 → 項目一覧 → スペース一覧 → ホーム。カード表示では項目からスペース一覧へ戻ります。','Item → item list → Spaces → Home. Card view returns from an item to Spaces.')]
      : [t('ホームでは項目を選択。チャットでは前後のメッセージへ切り替えます。','On Home, select an item. In Chat, move between messages.'),t('ホームの「チャット」をタップで開きます。本文ではタップで次のページへ。','Tap Chat on Home to open it. Tap the message for its next page.'),t('長押しで話し、離すと送信。「録音を開始」から始めた場合はタップで送信します。上限は {seconds} 秒です。','Hold to speak, then release to send. When started with Record voice, tap to send. Limit: {seconds} seconds.',{seconds:draft.relay==='gadget'?30:120}),t('チャットからホームへ戻ります。ホームでは終了確認、録音中は中止です。','Return from Chat to Home. On Home, open the exit confirmation; while recording, cancel.'),t('Ring／タッチパッドの最初の操作 → 直前画面。長押し → 復帰して録音。','First Ring/touchpad input → previous screen. Hold → restore and record.')];
    const mock = spaces ? [t('今日の予定 · 3件\n要約する · 実行\n集中時間 · 25 分\nメモ · 音声','Today · 3 events\nSummarize · Run\nFocus time · 25 min\nNote · Voice'),t('中継が受け付けました','Accepted by relay'),t('集中時間\n30 分\n[======----------]','Focus time\n30 min\n[======----------]'),t('メモ\n録音中…','Note\nRecording…'),t('予定\n買い物\nメモ','Schedule\nShopping\nNotes')]
      : [t('Muse · 新しいメッセージ','Muse · New message'),t('メッセージの本文\nタップで次のページへ','Message text\nTap for the next page'),t('録音中…\n離すと送信','Recording…\nRelease to send'),t('チャット\nスペース\n録音を開始','Chat\nSpaces\nRecord voice'),t('メッセージの本文\nタップで次のページへ','Message text\nTap for the next page')];
    const dialog = el('dialog', 'tutorial-dialog'); dialog.setAttribute('aria-labelledby', 'tutorial-title');
    const close = button(t('閉じる', 'Close'), () => { tutorial = false; render(); }, { secondary: true, icon: 'close', className: 'small-button' });
    dialog.append(el('div', 'page-toolbar', el('span', 'muted', t('操作の練習・送信しません', 'Practice · nothing is sent')), close));
    const title = el('h2', 'page-title', titles[tutorialStep]); title.id = 'tutorial-title';
    const restoring = !spaces && tutorialStep === 4;
    const screen = el('div', `glasses-demo ${tutorialDemo ? 'demo-active' : ''}`, el('span', 'demo-label', 'G2'), el('p', '', tutorialDemo ? mock[tutorialStep] : restoring ? '' : t('タッチパッドを操作', 'Use the touchpad')));
    if (restoring && !tutorialDemo) screen.setAttribute('aria-label', t('G2 表示は非表示中', 'G2 display hidden'));
    screen.setAttribute('aria-live', 'polite');
    const gesture = spaces ? ['swipe', 'tap', 'swipe', 'tap', 'double'][tutorialStep] : ['swipe', 'tap', 'hold', 'double', 'tap'][tutorialStep];
    const tap = button(gesture === 'swipe' ? t('↑ スワイプ ↓', '↑ Swipe ↓') : gesture === 'hold' ? t('長押しを試す', 'Try holding') : gesture === 'double' ? t('ダブルタップを試す', 'Try a double-tap') : t('タップを試す', 'Try a tap'), () => { tutorialDemo = true; render(); }, { secondary: true, className: 'gesture-pad' });
    dialog.append(title, screen, small(instructions[tutorialStep]), tap, el('div', 'wizard-actions',
      button(t('前へ', 'Previous'), () => { tutorialStep--; tutorialDemo = false; render(); }, { secondary: true, disabled: tutorialStep === 0 }),
      button(tutorialStep === titles.length - 1 ? t('完了', 'Done') : t('次へ', 'Next'), () => { if (tutorialStep === titles.length - 1) tutorial = false; else tutorialStep++; tutorialDemo = false; render(); })));
    dialog.addEventListener('cancel', event => { event.preventDefault(); tutorial = false; render(); });
    return dialog;
  }
  function forgetDialog() {
    const dialog = el('dialog', 'tutorial-dialog'); dialog.setAttribute('aria-labelledby', 'forget-title');
    const h = el('h2', 'page-title', t('接続情報を削除しますか？', 'Remove connection details?')); h.id = 'forget-title';
    dialog.append(h, small(t('このアプリに保存した接続先とトークンを削除します。', 'Remove endpoints and access tokens stored in this app.')), el('div', 'wizard-actions', button(t('戻る', 'Cancel'), () => { confirmForget = false; render(); }, { secondary: true }), button(t('削除', 'Remove'), () => { confirmForget = false; void run(async () => { await controller.clearCredentials(); draft = { ...controller.state.settings }; settingsDirty = false; testResult = null; testedSignature = ''; wizard = true; step = 0; }); })));
    dialog.addEventListener('cancel', event => { event.preventDefault(); confirmForget = false; render(); }); return dialog;
  }
  function historyDialog() {
    const dialog = el('dialog', 'tutorial-dialog history-dialog'); dialog.setAttribute('aria-labelledby', 'history-title');
    const title = el('h2', 'page-title', t('履歴を整理', 'Manage history')); title.id = 'history-title';
    dialog.append(el('div', 'page-toolbar', title, button(t('閉じる', 'Close'), () => { historyOpen = false; render(); }, { secondary: true, icon: 'close', className: 'small-button' })),
      small(t('この端末で非表示にします。あとで戻せます。', 'Hide on this device. Restore at any time.')));
    const choices = el('fieldset', 'relay-choices', el('legend', 'sr-only', t('非表示にするメッセージ', 'Messages to hide')));
    for (const mode of ['older', 'read'] as const) {
      const count = historyCandidates(mode).length;
      const input = el('input', 'even-radio'); input.type = 'radio'; input.name = 'history-mode'; input.checked = historyMode === mode;
      focusKey(input, `history-${mode}`); input.addEventListener('change', () => { historyMode = mode; render(); });
      choices.append(el('label', `relay-choice ${historyMode === mode ? 'is-selected' : ''}`,
        el('span', 'choice-copy', el('strong', '', mode === 'older' ? t('最新10件を残す', 'Keep the latest 10') : t('既読を非表示', 'Hide read messages')), el('span', '', t('{count} 件を非表示', 'Hide {count} messages', { count }))), input));
    }
    const count = historyCandidates().length;
    dialog.append(choices, button(t('{count} 件を非表示', 'Hide {count} messages', { count }), () => {
      const ids = historyCandidates().map(message => message.id); historyOpen = false;
      void run(async () => { await controller.hideMessages(ids); uiNotice = t('{count} 件を非表示にしました。', 'Hidden {count} messages.', { count: ids.length }); });
    }, { className: 'full-width', disabled: !count || !editable() }),
    button(t('非表示をすべて戻す', 'Restore all hidden messages'), () => { historyOpen = false; void run(() => controller.restoreHiddenMessages()); }, { secondary: true, icon: 'back', className: 'full-width restore-history', disabled: !controller.state.hiddenIds.length || !editable() }));
    dialog.addEventListener('cancel', event => { event.preventDefault(); historyOpen = false; render(); }); return dialog;
  }
  // Keep focused drafting fields and their connected ancestors in place during polling.
  // Replacing/re-focusing them dismisses or repositions the iOS keyboard.
  function preserveFocusedField(current: HTMLElement, next: HTMLElement, input: HTMLInputElement | HTMLTextAreaElement, nextInput: HTMLInputElement | HTMLTextAreaElement): boolean {
    if (current === input) {
      if (input.value !== nextInput.value) input.value = nextInput.value;
      input.disabled = nextInput.disabled; input.placeholder = nextInput.placeholder;
      input.setAttribute('aria-label', nextInput.getAttribute('aria-label') || '');
      return true;
    }
    const currentBranch = Array.from(current.children).find(child => child.contains(input));
    const nextBranch = Array.from(next.children).find(child => child.contains(nextInput));
    if (!(currentBranch instanceof HTMLElement) || !(nextBranch instanceof HTMLElement)
      || !preserveFocusedField(currentBranch, nextBranch, input, nextInput)) return false;
    current.className = next.className;
    if (current instanceof HTMLDetailsElement && next instanceof HTMLDetailsElement) current.open = next.open;
    for (const child of Array.from(current.childNodes)) if (child !== currentBranch) child.remove();
    let afterInput = false;
    for (const child of Array.from(next.childNodes)) {
      if (child === nextBranch) { afterInput = true; continue; }
      if (afterInput) current.append(child); else current.insertBefore(child, currentBranch);
    }
    return true;
  }
  function updateComposerViewport() {
    const input = document.activeElement;
    const editing = input instanceof HTMLTextAreaElement && input.dataset.focus === 'composer' && root.contains(input);
    root.classList.toggle('composer-editing', editing);
    const viewport = window.visualViewport;
    const inset = editing && viewport ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop) : 0;
    root.style.setProperty('--composer-keyboard-inset', `${inset > 80 ? inset : 0}px`);
    if (!editing) return;
    const top = viewport?.offsetTop || 0;
    const bottom = top + (viewport?.height || window.innerHeight);
    const inputBounds = input.getBoundingClientRect();
    const controls = input.closest('form')?.querySelector('.composer-actions')?.getBoundingClientRect();
    const targetBottom = controls && controls.bottom - inputBounds.top < bottom - top - 24 ? controls.bottom : inputBounds.bottom;
    if (targetBottom > bottom - 12) window.scrollBy({ top: targetBottom - bottom + 12, behavior: 'instant' });
    else if (inputBounds.top < top + 12) window.scrollBy({ top: inputBounds.top - top - 12, behavior: 'instant' });
  }
  function scheduleViewportUpdate() {
    cancelAnimationFrame(viewportFrame);
    viewportFrame = requestAnimationFrame(updateComposerViewport);
  }
  function render() {
    if(draggingSlider)return;
    theme();
    const focused = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
    const focus = focused?.dataset.focus;
    const selection = focused && (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) ? [focused.selectionStart, focused.selectionEnd] as const : null;
    const scroll = window.scrollY;
    const shell = el('div', 'app-shell', header());
    if (controller.state.settingsLoadFailed) shell.append(el('div', 'form-card', small(controller.state.persistence === 'local'
      ? t('Even側の設定を読み込めませんでした。この端末のバックアップを表示しています。', 'Could not load settings from Even. Showing this device’s backup.')
      : t('設定を読み込めませんでした。保存済みの接続情報は変更していません。', 'Could not load settings. Stored connection details have not been changed.')),
      button(t('設定を再読み込み', 'Reload settings'), () => { void run(() => controller.reloadSettings()); }, { secondary: true, icon: 'refresh', disabled: !editable() })));
    if (controller.state.persistence === 'loading') {
      const loading = el('p', 'feedback', t('設定を読み込み中…', 'Loading settings…')); loading.setAttribute('role', 'status');
      shell.append(el('main', 'page', loading));
    } else if (wizard) shell.append(wizardContent());
    else {
      const page = el('main', 'page', status());
      page.append(notifications(), view === 'chat' ? chatContent() : view === 'spaces' ? spacesContent() : settingsContent());
      shell.append(page, navigation());
    }
    const dialog = help ? helpDialog() : spaceConfirm ? spaceConfirmation() : spaceToRemove ? removeSpaceDialog() : tutorial ? tutorialDialog() : confirmForget ? forgetDialog() : historyOpen ? historyDialog() : null;
    if (dialog) shell.append(dialog);
    const currentShell = root.firstElementChild;
    const drafting = focus === 'composer' || focus?.startsWith('space-create-') || focus?.startsWith('setting-');
    const nextField = drafting ? shell.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-focus="${CSS.escape(focus!)}"]`) : null;
    const preserved = !dialog && (focused instanceof HTMLTextAreaElement || focused instanceof HTMLInputElement) && currentShell instanceof HTMLElement && nextField
      ? preserveFocusedField(currentShell, shell, focused, nextField) : false;
    if (!preserved) root.replaceChildren(shell);
    if (dialog) dialog.showModal();
    if (focus && !preserved && (!dialog || dialog.querySelector(`[data-focus="${CSS.escape(focus)}"]`))) {
      const target = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-focus="${CSS.escape(focus)}"]`);
      if (target) { target.focus({ preventScroll: true }); if (selection && selection[0] !== null && selection[1] !== null && typeof target.setSelectionRange === 'function') { try { target.setSelectionRange(selection[0], selection[1]); } catch { /* select / non-text input */ } } }
    }
    if (!preserved) window.scrollTo({ top: scroll, behavior: 'instant' });
  }
  const unsubscribe = controller.subscribe(() => {
    const nextSettings = JSON.stringify(controller.state.settings);
    if (nextSettings !== lastSettings) {
      lastSettings = nextSettings;
      if (!settingsDirty) { draft = { ...controller.state.settings }; if (draft.configured) wizard = false; }
    }
    scheduleRender();
  });
  root.addEventListener('focusin', scheduleViewportUpdate);
  root.addEventListener('focusout', scheduleViewportUpdate);
  window.visualViewport?.addEventListener('resize', scheduleViewportUpdate);
  window.addEventListener('resize', scheduleViewportUpdate);
  render();
  return () => {
    unsubscribe(); cancelAnimationFrame(viewportFrame);
    root.removeEventListener('focusin', scheduleViewportUpdate);
    root.removeEventListener('focusout', scheduleViewportUpdate);
    window.visualViewport?.removeEventListener('resize', scheduleViewportUpdate);
    window.removeEventListener('resize', scheduleViewportUpdate);
    root.classList.remove('composer-editing'); root.style.removeProperty('--composer-keyboard-inset');
  };
}
