'use strict';

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
  const a = el('a', text); a.href = href;
  if (href.startsWith('https://')) { a.target = '_blank'; a.rel = 'noopener'; }
  return a;
}
function replaceList(target, items) { $(target).replaceChildren(...items.map(text => el('li', text))); }
function setPairs(target, pairs) { $(target).replaceChildren(...pairs.flatMap(([label, value]) => [el('dt', label), el('dd', value)])); }
const routes = {
  gist: {
    name: 'GitHub Gist', app: 'GitHub Gist', medium: 'Gist', device: '受信処理',
    supplies: ['GitHubのSecret Gistとgist権限のトークン', '新規依頼をMuseへ渡す監視処理とハンドラー'],
    note: 'Secret Gistは、URLを知る人が閲覧できます。音声・画像も変更履歴に残り得ます。',
    flow: [['G2', '表示・音声'], ['スマホ', 'Muse Relay'], ['Gist', '自分の保存先'], ['受信処理', '自分で用意'], ['Muse', '処理・返信']],
    fields: [['Gist ID または URL', '自分のGist'], ['GitHub トークン', '本人のgist権限トークン']],
    input: 'muse-relay-request-<id>.json',
    output: 'g2muse-relay.json\nmuse-relay-spaces.json\nmuse-relay-profile.json',
    inputDetail: '依頼ごとのファイルを読みます。音声・画像はbase64の別ファイルを参照。',
    outputDetail: '1つの書き込み処理で既存データを保ち、返信のreply_toに元の依頼IDを付けます。',
  },
  atom: {
    name: '自宅の ATOM S3', app: 'Muse Gadget SDK', medium: 'HTTPS中継', device: 'ATOM S3',
    supplies: ['外出先から届くHTTPS中継と役割別の接続キー', 'ATOM S3・USB電源・2.4 GHz Wi-Fi', 'Muse Gadget SDKトークンとMuseとのペアリング'],
    note: 'ATOMは自宅から中継へ外向きに接続します。スマホへ自宅LANのIPを入力せず、ATOM向けのポート開放も不要です。',
    flow: [['G2', '表示・音声'], ['スマホ', 'Muse Relay'], ['HTTPS', '自分の中継'], ['ATOM S3', '自宅・外向き接続'], ['Muse', 'SDKで処理']],
    fields: [['中継サーバー URL', '外出先から届くHTTPS'], ['スマートフォン用トークン', 'アプリ用の接続キー']],
    input: 'POST /v1/requests',
    output: 'GET /v1/snapshot\nGET /v1/files/:name',
    inputDetail: 'スマートフォン用キーで送信。ATOMは別の機器用キーで依頼を取得します。',
    outputDetail: 'アプリの読み取り口。Museの追加出力はMuse用キーで /v1/messages・/v1/spaces/:id・/v1/profile へ。',
  },
  linux: {
    name: 'Linux / Raspberry Pi', app: 'Muse Gadget SDK', medium: 'HTTPS中継', device: 'Linux',
    supplies: ['公式Linux SDKに対応するLinux機とペアリング環境', 'Muse Gadget SDKトークン', 'HTTPS中継と、SDKのチャット入出力を結ぶアダプターの実装'],
    note: '公式SDKはLinuxに対応します。Muse Relay用Linuxアダプターは同梱しておらず、この構成の統合動作は未実測です。',
    flow: [['G2', '表示・音声'], ['スマホ', 'Muse Relay'], ['HTTPS', '自分の中継'], ['Linux', '自宅・外向き接続'], ['Muse', 'SDKで処理']],
    fields: [['中継サーバー URL', '実装したHTTPS入出力'], ['スマートフォン用トークン', 'アプリ用の接続キー']],
    input: 'POST /v1/requests',
    output: 'GET /v1/snapshot\nGET /v1/files/:name',
    inputDetail: 'アプリのHTTP境界はGadget方式と共通。Linux SDKへの橋渡しを別途実装します。',
    outputDetail: 'SDKの返信を公開仕様のメッセージへ変換。画面描画コマンドの転送ではありません。',
  },
};
const voiceName = () => state.voice === 'muse' ? '中継先で文字起こし' : state.voice === 'soniox-key' ? 'Soniox · APIキーを入力' : 'Soniox · 一時キー発行サーバー';

function renderRoute() {
  const route = routes[state.route];
  $('#flow-choice').textContent = route.name;
  $('#main-flow').replaceChildren(...route.flow.map(([title, subtitle]) => {
    const item = el('li'); item.append(el('strong', title), el('span', subtitle)); return item;
  }));
  $('#main-flow').setAttribute('aria-label', `${route.flow.map(node => node[0]).join('、')}の順に接続。依頼を送り、返信を読み取ります。`);
  replaceList('#supplies', route.supplies);
  $('#app-route').textContent = `中継方式 → ${route.app}`;
  $('#route-note').textContent = route.note;
  $('#input-title').textContent = state.route === 'gist' ? '依頼ごとのJSON' : 'アプリからの依頼';
  $('#output-title').textContent = state.route === 'gist' ? '返信・スペース・プロフィール' : 'アプリが読む表示データ';
  $('#input-contract').textContent = route.input;
  $('#output-contract').textContent = route.output;
  $('#input-detail').textContent = route.inputDetail;
  $('#output-detail').textContent = route.outputDetail;
  $('#implementation-name').textContent = route.name;
  renderImplementation(); renderStep(); renderVoice(); renderPrompt();
}

function stepContent() {
  const route = routes[state.route];
  const isGist = state.route === 'gist';
  if (state.step === 0) return {
    title: `${route.app}を選ぶ`,
    actions: [`「中継方式」で「${route.app}」を選択。`, state.route === 'linux' ? 'Linuxはアプリに専用の選択肢はありません。対応アダプターの実装後、同じGadget接続を使います。' : '「次へ」で接続設定を開く。'],
    fields: [['中継方式', route.app], ['次へ', '→']], link: ['中継がまだない場合 →', '#relay'],
  };
  if (state.step === 1) return {
    title: isGist ? 'Gistとトークンを入力する' : 'スマートフォン用の設定を読み込む',
    actions: isGist ? ['自分のGistのIDまたはURLを入力。', '本人のGitHubトークンを「GitHub トークン」へ入力。', '新規Gistなら「初めて Gist を作る」でファイル名・初期内容をコピー。']
      : ['中継の設定画面で、スマートフォン用の「設定をコピー」。', 'Muse Relayの「接続設定を読み込む」へ貼り付け、「読み込む」。', '手入力なら「中継サーバー URL」と「スマートフォン用トークン」を設定。'],
    fields: route.fields, link: isGist ? ['Gistの初期ファイルと監視処理 →', '#relay'] : ['HTTPS中継と役割別のキー →', '#relay'],
  };
  if (state.step === 2) return {
    title: '文字起こし先とマイクを選ぶ',
    actions: ['「文字起こし先」を選び、「マイク」をG2グラスまたはスマートフォンに設定。', state.voice === 'muse' ? '送信時にWAVを中継へ渡します。録音中の字幕は表示しません。' : 'Sonioxの接続方法を設定し、「Sonioxへの接続を確認」。', '必要なときだけ「画像を使用」をオン。設定を選んだ後でMuseへの依頼文をコピーします。'],
    fields: [['文字起こし先', state.voice === 'muse' ? '中継先で文字起こし' : 'Soniox（アプリから直接）'], ['マイク', 'G2 グラス / スマートフォン'], ['画像を使用', state.images ? 'オン' : 'オフ']], link: ['音声の経路と追加設定 →', '#voice'],
  };
  return {
    title: '読み取りを確認して保存する',
    actions: ['「Muse に渡す設定手順」をコピーし、自分のMuse側の設定を用意。', '「接続を確認」で中継の読み取りを確認。成功後に「保存して開く」。', 'チャットで短いテキストを送信し、自分の入力とMuseの対応する返信を確認。'],
    fields: [['接続を確認', '中継の読み取り'], ['保存して開く', '設定を保存'], ['チャットで送信', 'Museの返答を確認']], link: ['選択中の設定で依頼文を作る →', '#relay'],
  };
}
function renderStep() {
  const titles = ['中継方式', '接続設定', '音声と画像', '接続確認'];
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
  $('#step-next').textContent = state.step === 3 ? '最後の手順' : '次の手順';
}

function renderVoice() {
  const isGist = state.route === 'gist';
  let flow, settings, keyFlow;
  if (state.voice === 'muse') {
    $('#voice-title').textContent = '送信時に音声ファイルを渡す';
    flow = ['G2 / スマホ', '送信時 →', routes[state.route].medium, '→', isGist ? 'Muse側の処理' : `${routes[state.route].device} → Muse`];
    keyFlow = '録音中の字幕は表示しません。返された文字起こしがあればチャットに表示します。';
    settings = [['アプリの選択', '中継先で文字起こし'], ['処理する場所', isGist ? 'Muse側のハンドラーに文字起こしを実装' : 'GadgetがWAVをSDKでMuseへ転送'], ['録音の上限', isGist ? '120秒' : '30秒'], ['追加の音声契約', 'この方式にSonioxは不要']];
  } else {
    $('#voice-title').textContent = '話している間、G2とスマホに字幕を表示';
    flow = ['G2 / スマホ', '音声 →', 'Soniox', '文字 →', 'アプリ', '確定文字 →', routes[state.route].medium];
    keyFlow = state.voice === 'soniox-key' ? '本人のAPIキーはアプリ設定に保存し、Sonioxにだけ使用。Muse・Gist・中継には送りません。'
      : 'キーの流れ：アプリ → 発行サーバー → 一時キー。音声は発行サーバーを経由しません。';
    settings = [['文字起こし先', 'Soniox（アプリから直接）'], ['Soniox 接続方法', state.voice === 'soniox-key' ? 'APIキーを入力' : '一時キー発行サーバー']];
    if (state.voice === 'soniox-key') settings.push(['入力する場所', 'アプリ内の「Soniox APIキー」'], ['キーの保存先', 'Evenのアプリ設定と端末バックアップ']);
    else settings.push(['発行先', isGist ? '自分の「一時キー発行 URL」と認証を設定' : '参考中継は /v1/soniox-token を自動使用'], ['長期キーの保存先', '発行サーバーのみ']);
    settings.push(['確認する操作', 'Sonioxへの接続を確認'], ['確認で使うデータ', '1秒の無音。マイク・Museは使わず、利用量に計上される場合があります。']);
  }
  $('#voice-flow').replaceChildren(...flow.map((part, i) => el(i % 2 === 0 ? 'span' : 'b', part)));
  $('#voice-flow').setAttribute('aria-label', flow.join(' '));
  $('#voice-key-flow').textContent = keyFlow; setPairs('#voice-settings', settings);
}

async function copyText(text, target, status) {
  try { await navigator.clipboard.writeText(text); status.textContent = 'コピーしました。使用するAIや設定画面へ貼り付けてください。'; }
  catch { target?.focus(); target?.select(); status.textContent = target ? '内容を選択しました。端末のコピー操作を使ってください。' : 'コピーできませんでした。表示されているコマンドを選択してコピーしてください。'; }
}
function codeBlock(command) {
  const block = el('div', undefined, 'code-block');
  const code = el('code', command), button = el('button', 'コピー'), status = el('span', undefined, 'sr-only');
  button.type = 'button'; button.setAttribute('aria-label', 'コマンドをコピー'); status.setAttribute('role', 'status');
  button.addEventListener('click', () => { void copyText(command, null, status); }); block.append(code, button, status); return block;
}
function renderImplementation() {
  const body = $('#implementation-body'); body.replaceChildren();
  const steps = el('ol', undefined, 'implementation-steps');
  const item = (title, text) => { const li = el('li'); li.append(el('strong', title), el('span', text, 'small')); return li; };
  const links = el('div', undefined, 'doc-links');
  if (state.route === 'gist') {
    steps.append(item('1. Gistを作る', 'g2muse-relay.json の初期内容は {"messages":[]}。既存Gistを使う場合は上書きしません。'), item('2. 処理を用意', '参考watcherが呼ぶMUSE_HANDLERを自分で実装、またはMuseに依頼。watcherだけではMuseにつながりません。'), item('3. 常時実行', '秘密設定を .local/gist-watcher.env へ保存し、監視処理を起動。新規依頼があるときだけMuseを呼びます。'));
    body.append(steps, codeBlock('node --env-file=.local/gist-watcher.env adapters/gist/watcher.mjs'));
    body.append(el('p', 'Node.js 22以降。G2Museの既存メッセージは読めますが、旧watcherはMuse Relayの独立した依頼ファイルへの対応が必要です。', 'small muted'));
    links.append(link('Gistを作る ↗', 'https://gist.github.com/'), link('watcherの設定 ↗', `${repo}/blob/main/adapters/gist/README.md`), link('GitHubのGist説明 ↗', 'https://docs.github.com/en/get-started/writing-on-github/editing-and-sharing-content-with-gists/creating-gists'));
  } else if (state.route === 'atom') {
    steps.append(item('1. HTTPS中継', '参考サーバーのローカル設定UIで公開HTTPS URLと許可Originを設定。スマホ・機器・Museのキーを分けます。'), item('2. ATOM S3', '参考ファームウェアを書き込み。USB設定画面で中継URL・機器用キー・SDKトークンを保存し、Museでペアリング。'), item('3. 自宅に置く', 'USB電源とWi-Fiを維持。外出時のスマホは中継URLへ、ATOMも自宅から同じ中継へ接続します。'));
    body.append(steps, codeBlock('node server/setup.mjs'), el('p', 'プロジェクトのルートから実行し、http://127.0.0.1:8788 を開きます。これは設定用画面です。HTTPSホスティングの配備は別途行います。', 'small muted'));
    links.append(link('サーバー設定・HTTPS配備例 ↗', `${repo}/blob/main/docs/server.md`), link('ATOMの書き込み・USB設定 ↗', `${repo}/blob/main/docs/atoms3.md`), link('再現手順と確認範囲 ↗', `${repo}/blob/main/docs/public-source.md`));
    body.append(el('p', '確認した参考構成：ATOM S3実機からMuseへのテキスト往復と合成WAVへの対応返信。G2の実マイクや、すべての利用者環境の確認を意味しません。', 'small muted'));
  } else {
    steps.append(item('1. SDKで往復を確認', '公式手順でMuseと初回BLEペアリング。新しい専用会話IDで下のコマンドを実行し、対応する返信を確認します。'), item('2. HTTP入出力を接続', 'POST /v1/requests の依頼をSDKへ渡し、返信のreply_toへ元の依頼IDを付けて保存するアダプターを実装します。'), item('3. 合格条件', 'GET /v1/snapshot で元のIDに対応するMuse返信を読み、アプリに表示できること。別の会話や依頼の返信を混ぜません。'));
    const pairing = el('div', undefined, 'voice-diagram'); pairing.setAttribute('aria-label', '初回はMuseアプリから自宅LinuxへBLEペアリング');
    pairing.append(el('b', '初回'), el('span', 'Museアプリ'), el('b', 'BLE →'), el('span', '自宅Linux'));
    const away = el('div', undefined, 'voice-diagram'); away.setAttribute('aria-label', '外出先のスマホと自宅LinuxがHTTPS中継へ接続し、自宅LinuxからMuseへ接続');
    away.append(el('b', '外出時'), el('span', 'スマホ'), el('b', '→'), el('span', 'HTTPS中継'), el('b', '←'), el('span', '自宅Linux'), el('b', '→'), el('span', 'Muse'));
    body.append(steps, pairing, away, el('p', '初回のペアリング後は自宅Linuxが外向きに通信します。スマホを自宅のBLE範囲に置く必要はありません。', 'small muted'),
      codeBlock('musegadget send-user-msg --session-id "<新しいUUID>" --wait 60 "test"'),
      el('p', '<新しいUUID>をテスト用に生成したUUIDへ置き換えます。このコマンドはMuseへ送信し、最大60秒待ちます。CLIでの返信確認後、HTTP入口からも新しいテスト要求を送って確認します。', 'small muted'));
    links.append(link('公式CLIの説明 ↗', `${sdk}/blob/main/linux/README.md#hack-and-extend-it`), link('公式ブリッジ例 ↗', `${sdk}/blob/main/linux/examples/pebble_ring_bridge.py`), link('アプリ側のHTTP契約 ↗', `${repo}/blob/main/docs/protocol.md`));
  }
  body.append(links);
}

const contractLink = `${repo}/blob/main/docs/protocol.md`;
const safeConfiguration = '接続先と資格情報は安全な設定画面・秘密設定から受け取り、チャット本文・公開コード・ログ・Gistの内容へトークンを記載しないでください。個人の接続先を共通EvenHubアプリへ埋め込まず、アプリは変更しません。';
function transportPrompt() {
  if (state.route === 'gist') return `GitHub Gist方式です。新規作成時だけ g2muse-relay.json を {"messages":[]} で初期化し、既存ファイルを保持してください。
入口: muse-relay-request-<id>.json。{protocol:"muse-relay/1",id,kind:"chat"|"space",text,created_at,space_id?,space_action?} を読みます。audio_file/audio_mime/audio_name または image_file/image_mime/image_name はbase64を格納した別ファイルを参照します。
出口: g2muse-relay.json の {messages:[{id,from:"Muse",type:"text",text,ts,reply_to}]}。tsはUnix秒、reply_toは元の依頼ID。書き込み処理を1つにし、既存メッセージを保持して直近50件へ整理します。古いG2Muse watcherをそのまま流用せず、この独立outboxに対応してください。
任意の参考実装 ${repo}/tree/main/adapters/gist は監視のみです。Museとの接続・処理はハンドラーへ実装してください。`;
  const linux = state.route === 'linux' ? `公式Linux SDK ${sdk}/blob/main/linux/README.md を利用します。Muse Relay用アダプターは別途実装してください。初回BLEペアリング後は自宅Linuxから中継・Museへ外向きに接続します。公式CLIの musegadget send-user-msg --session-id "<新しいUUID>" --wait 60 "test" で専用会話の対応返信を確認してください。<新しいUUID>はテスト用に生成する値です。公式例 ${sdk}/blob/main/linux/examples/pebble_ring_bridge.py の既存SDK接続を使う方式を参考にできます。合格条件は POST /v1/requests の元idをMuse返信のreply_toへ保持し、GET /v1/snapshot から同じ返信を読んでアプリ表示できることです。存在しないAPIを仮定せず、実測した範囲だけ報告してください。`
    : `参考機器は自宅に据え置くATOM S3です。${repo}/blob/main/docs/atoms3.md のファームウェアとUSB設定を使えます。電源とWi-Fiを維持し、機器からHTTPS中継へ外向きに接続します。スマホに自宅LANのIPを入力させず、ATOM向けのポート開放を要求しないでください。`;
  return `Muse Gadget SDK方式です。${linux}
アプリの入口: スマートフォン用キーで POST /v1/requests。出口: GET /v1/snapshot と GET /v1/files/:name。公開仕様の {messages,spaces?,profile?,device?,capabilities?} を返してください。
任意の参考サーバー ${repo}/tree/main/server を使う場合、機器は別の機器用キーで /device/jobs を取得し、ACK・対応するMuse会話のイベント・heartbeatを /device/events へ返します。専用会話IDと要求を対応付け、他の会話を流さないでください。
Museからの追加出力は別のMUSE_TOKENで POST /v1/messages {id:"muse_export_<unique-id>",type:"text",text,reply_to?}。送信者はMuseです。/v1/messagesでYou発言を作らないでください。スマホ用キー・機器用キー・Muse更新用キーを分けます。
利用者へスマホ用の接続設定JSON {relay:"gadget",relayUrl,relayToken} を安全な設定画面から渡してください。必要なホスティング認証は該当する中継Originにだけ送ります。Even内に表示されたOriginを許可し、可変の http://127.0.0.1 ポートは参考設定の専用許可で対応してください。`;
}
function voicePrompt() {
  if (state.voice === 'soniox-key') return `音声は「Soniox（アプリから直接）」・「APIキーを入力」です。本人がアプリ内の「Soniox APIキー」へ入力します。追加の一時キーサーバーは作成不要で、Museや中継がこのキーを受け取ってはいけません。アプリが音声をSonioxへ直接送り、途中の文字をG2とスマホに表示し、送信時に確定テキストだけを${routes[state.route].medium}へ渡します。確定テキストはそのまま使用し、Whisper等で再文字起こししないでください。`;
  if (state.voice === 'soniox-server') return `音声は「Soniox（アプリから直接）」・「一時キー発行サーバー」です。${state.route === 'gist'
    ? '認証付きHTTPSの一時キー発行口を別途用意し、そのURLと専用認証をアプリへ設定できるようにしてください。Gistへ長期キーや一時キーを保存しないでください。'
    : '参考中継の POST /v1/soniox-token を使えば、アプリは既存の中継URL・スマホ用認証を再利用します。別Originの発行先には既存の認証を引き継がないでください。'}
長期Sonioxキーは発行サーバーだけに保管し、Sonioxの transcribe_websocket 用の一時キーを発行してください。音声はアプリからSonioxへ直接送られ、発行サーバーを通りません。途中の文字はG2とスマホへ、確定テキストだけを${routes[state.route].medium}へ送ります。Muse側で再文字起こししないでください。公式形式と制限は https://docs.soniox.com/authentication/temporary-api-keys と既存参考実装で確認してください。`;
  return `音声は「中継先で文字起こし」です。録音中に音声を中継へストリーミングせず、送信時に16kHz・16bit・mono WAVを1つ渡します。${state.route === 'gist'
    ? 'Muse側ハンドラーへWhisper互換等の文字起こしを実装してください。参考watcherにはtranscriptを返します。元の依頼IDと同じidのfrom:"You"発言を文字起こしで更新し、Muse返信のreply_toを同じIDにします。'
    : 'ペアリング済みGadgetのSDK経由でWAVをMuseへ渡します。対応するSDKのmessage.userに文字起こしが返る場合は、参考中継が元のYou発言を更新します。返らない場合に文字起こし済みと偽らず、音声メッセージとして表示します。'}
この方式にはSoniox設定を要求しないでください。G2の話者選択で無音化した対象外・判定不明の発言を推測して復元しないでください。`;
}
function imagesPrompt() {
  if (!state.images) return '画像はオフです。接続設定ではテキスト返信と文字だけで理解できるスペースを扱い、画像の有効化やアバター作成を要求しないでください。';
  return `画像はオンです。PNG/JPEG/WebPの画像本体を読み、decoded 250000 bytes以下で書き出します。URLやローカルパスだけを返信しないでください。${state.route === 'gist'
    ? '画像返信はtype:"image", image_file:<base64を格納したGistファイル名>, mime_type。captionは任意。参考watcherの返信imageは利用できますが、spaces出力の画像は独自エクスポーターが必要です。'
    : 'Muse用キーで POST /v1/messages {id:"muse_export_<unique-id>",type:"image",image:{mime,data_base64,name},text?,reply_to?}。SDK display.draw_* はGadget本体向けでG2には使いません。capabilities.imagesはMuseへの画像入力の可否で、Museからの画像受信を制限しません。参考ATOMの画像入力は別途確認するまで無効のままにしてください。'}
G2では288×144・16階調に変換されるため、小さな文字や色だけに依存しない画像にしてください。`;
}
function spacePrompt() {
  const examples = {
    schedule: ['今日の予定', '今日の予定を時刻順に短く表示。読み取りを基本にし、要約はボタンを押した場合だけ実行する。', 'list', [{type:'button',label:'要約する'}]],
    focus: ['集中タイマー', '集中する時間を5〜60分で選び、開始ボタンで実行。現在の状態と終了予定時刻を表示。操作しない更新ではタイマーを開始しない。', 'cards', [{type:'slider',min:5,max:60,step:5,value:25,unit:'分'},{type:'button',label:'開始',confirm:'集中タイマーを開始しますか？'}]],
    notes: ['音声メモ', '選んだ項目へ音声メモを追加し、本文と短い要約を表示。項目を開くだけでは録音しない。', 'list', [{type:'microphone'}]],
  };
  const [name, purpose, layout, controls] = examples[state.preset];
  return `Museに「${name}」というスペースを作成、または既存の同目的スペースを再利用してください。用途: ${purpose}
表示形式: layout:"${layout}"。部品: ${JSON.stringify(controls)}。名前と本文は日本語で短くし、Muse側に実処理を実装してください。ひな形を置くだけで完成としないでください。
出力は {id,title,layout,items:[{id,title,text,control?}]}。安定したIDを使い、他のスペースを保持してください。最大20スペース・各50項目。HTML・JavaScript・Museページの埋め込みは使いません。
${state.route === 'gist' ? '既存Gist writerで muse-relay-spaces.json の {spaces:[...]} を更新します。全体を書き出すため他のスペースも保持してください。' : '既存HTTPS中継のMUSE_TOKENを使い、GET /v1/spaces で現在値を読んで PUT /v1/spaces/<id> へ対象1件を保存します。URLと本文のidは一致させます。追加のために全件を上書きしないでください。'}
kind:"space",space_id,space_action:{item_id,type,value?} を既存経路から受け取り、同じ依頼IDは一度だけ処理します。space_actionのない更新要求は再出力のみで、ボタン・タイマー等を実行しません。処理後に現在値と本文を再出力し、返信のreply_toへ元の依頼IDを付けます。受付は完了ではありません。
G2でスワイプは項目選択・値調整、タップは開く・実行・確定、ダブルタップは戻る・中止。マイクは選択後のタップで開始し、タップで送信、ダブルタップで中止します。キーボード・外部ページ・長押しは操作の必須条件にしません。
${state.preset === 'notes' ? voicePrompt() : '既存の音声・中継設定は変更しないでください。'}
書き出しに成功したら「スペース → 追加 → 受信済みから追加 → 更新して受信 → 追加」を案内してください。`;
}
function avatarPrompt() {
  return `Museで現在設定しているアバターを、既存プロフィール・persona・ファイルから探してください。見つからなければ見つからないと伝え、別の画像の生成・選定・代用はしないでください。
元画像のバイト列を読み、PNG/JPEG/WebP・decoded 250000 bytes以下の avatar:{mime,data_base64,name} を書き出します。URLやファイルパスだけでは不足です。
${state.route === 'gist' ? '既存のGist writerで muse-relay-profile.json を {profile:{name,avatar:{mime,data_base64,name},updated_at}} として保存。他のファイルは保持してください。' : '既存の中継へMUSE_TOKENで PUT /v1/profile、本文 {name,avatar:{mime,data_base64,name}}。スマホ用キーでは更新できません。'}
成功後にアプリの「設定 → 音声と画像 → 画像を使用」をオンにして「設定を保存」を案内します。受信した画像はG2ホームに表示されます。取得・書き出し・G2表示の確認を混同せず、実際にできた段階だけ報告してください。`;
}
function renderPrompt() {
  const route = routes[state.route];
  $('#space-preset-field').hidden = state.topic !== 'space';
  $('#prompt-context').textContent = `${route.name} · ${voiceName()} · 画像${state.images ? 'オン' : 'オフ'}`;
  const parts = [`Muse Relayの${state.topic === 'connection' ? '中継を私の環境に設定' : state.topic === 'voice' ? '音声設定を確認・実装' : state.topic === 'space' ? 'スペースを作成' : '設定済みアバターを取得'}してください。公開仕様: ${contractLink}`, safeConfiguration];
  if (state.topic === 'connection') parts.push(transportPrompt(), voicePrompt(), imagesPrompt(), '同じ依頼IDのclaimと結果を永続化して重複実行を防ぎ、結果不明の要求を無条件に再送しないでください。軽い監視で新規依頼があるときだけMuseを起動します。スペースやアバターは接続設定の一環として勝手に作らず、別の依頼を待ってください。');
  else if (state.topic === 'voice') parts.push(`現在の中継は${route.name}です。既存チャットと資格情報の分離を保ってください。`, voicePrompt(), 'アプリで選んだマイクを使うのは本人が録音したときだけです。「Sonioxへの接続を確認」は1秒の無音で、利用量に計上される場合があります。接続成功と実音声の文字起こし成功を分けて確認してください。');
  else if (state.topic === 'space') parts.push(spacePrompt());
  else parts.push(avatarPrompt());
  if (state.route === 'linux' && state.topic !== 'connection') parts.push('既存のLinuxアダプターがない場合はまず接続を実装し、HTTP入口から対応返信を読み取れることを確認してください。');
  parts.push('最後に、利用者が設定する場所と、実際に確認した入口・処理・出口を短く示してください。秘密値は回答に含めないでください。');
  $('#prompt-output').value = parts.join('\n\n'); $('#copy-status').textContent = '';
}

// The on-page HUD is an illustration. It never accesses a microphone or a relay.
const demo = { type: 'chat', index: 0, page: 0, home: false, homeIndex: 0, recording: false, spaceIndex: 0, detail: '', minutes: 25 };
const homeScreen = el('div', undefined, 'hud-screen hud-home'); homeScreen.hidden = true;
homeScreen.append(el('p', 'チャット', 'hud-selected'), el('p', 'スペース'), el('p', '録音を開始'), el('span', 'ホーム · 表示例', 'hud-footer'));
const recordingScreen = el('div', undefined, 'hud-screen'); recordingScreen.hidden = true;
recordingScreen.append(el('p', '録音中…'), el('p', 'タップで送信 · ダブルタップで中止'), el('span', '表示例 · 実際の録音・送信はしません', 'hud-footer'));
$('#hud').append(homeScreen, recordingScreen);
function renderDemo() {
  $$('[data-hud]').forEach(screen => { screen.hidden = demo.home || demo.recording || screen.dataset.hud !== demo.type; });
  homeScreen.hidden = !demo.home;
  recordingScreen.hidden = !demo.recording;
  $$('[data-demo]').forEach(button => { const on = button.dataset.demo === demo.type; button.classList.toggle('selected', on); button.setAttribute('aria-pressed', String(on)); });
  $('#hud').setAttribute('aria-label', `${demo.recording ? '録音' : demo.home ? 'ホーム' : demo.type === 'chat' ? 'チャット' : demo.type === 'image' ? '画像' : 'スペース'}の表示例。ダミーデータ。`);
  if (demo.recording) { $('#demo-description').textContent = '録音を開始した後はタップで送信、ダブルタップで中止。ここではマイクを使いません。'; return; }
  if (demo.home) { [...homeScreen.querySelectorAll('p')].forEach((row, i) => row.classList.toggle('hud-selected', i === demo.homeIndex)); $('#demo-description').textContent = 'ダブルタップでホームへ。スワイプで選び、タップで開きます。'; return; }
  if (demo.type === 'chat') {
    const chats = [['You: 今日の予定を教えて', ['10:00 ミーティング', '14:30 資料の確認', '夕方は空いています。']], ['You: 持ち物を短くまとめて', ['ノートと充電器', '折りたたみ傘', '確認する資料']]];
    $('[data-hud="chat"] .hud-input').textContent = chats[demo.index][0];
    $('[data-hud="chat"] .hud-answer').replaceChildren(...(demo.page ? ['本文の続きです。', 'タップでページを送り、', 'スワイプで会話を切り替えます。'] : chats[demo.index][1]).map(text => el('p', text)));
    $('#demo-description').textContent = '入力とMuseの回答を併記。自分の入力は薄く表示します。';
  } else if (demo.type === 'image') {
    $('.hud-image').toggleAttribute('hidden', demo.page === 1); $('.hud-image-caption').hidden = demo.page !== 1;
    $('[data-hud="image"] .hud-footer').textContent = demo.page ? '本文 · 表示例' : 'タップで本文';
    $('#demo-description').textContent = 'Museが出力した画像を表示。タップで本文へ進みます。';
  } else {
    $('.hud-list').hidden = Boolean(demo.detail); $('.hud-space-detail').hidden = !demo.detail;
    $$('.hud-list p').forEach((row, i) => row.classList.toggle('hud-selected', i === demo.spaceIndex));
    const lines = demo.detail === 'slider' ? ['集中時間', `${demo.minutes} 分`, 'スワイプで調整 · タップで送信'] : demo.detail === 'accepted' ? ['中継が受け付けました', '処理結果はMuseの更新で表示', '表示例・実際には送信しません'] : [demo.spaceIndex === 0 ? '10:00 ミーティング' : '14:30 資料の確認', '確認することを3つにまとめる', '終了後に内容を更新'];
    $('.hud-space-detail').replaceChildren(...lines.map(text => el('p', text)));
    $('[data-hud="space"] .hud-footer').textContent = demo.detail ? 'ダブルタップで一覧へ' : 'スワイプで選択 · タップで開く';
    $('#demo-description').textContent = 'Museが書き出すリストと操作部品。集中時間を選ぶと値の調整を試せます。';
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
  $$('.header-row nav a').forEach(a => { if (a.hash === hash) a.setAttribute('aria-current', 'location'); else a.removeAttribute('aria-current'); });
}
window.addEventListener('hashchange', markNavigation);
$('#theme').addEventListener('change', event => { document.documentElement.dataset.theme = event.target.value; });
$$('input[name="route"]').forEach(input => input.addEventListener('change', () => { state.route = input.value; state.step = 0; renderRoute(); }));
$$('input[name="voice"]').forEach(input => input.addEventListener('change', () => { state.voice = input.value; renderVoice(); renderStep(); renderPrompt(); }));
$('#guide-images').addEventListener('change', event => { state.images = event.target.checked; renderStep(); renderPrompt(); });
$$('[data-step]').forEach(button => button.addEventListener('click', () => { state.step = Number(button.dataset.step); renderStep(); }));
$('#step-prev').addEventListener('click', () => { state.step = Math.max(0, state.step - 1); renderStep(); });
$('#step-next').addEventListener('click', () => { state.step = Math.min(3, state.step + 1); renderStep(); });
$('#prompt-topic').addEventListener('change', event => { state.topic = event.target.value; renderPrompt(); });
$('#space-preset').addEventListener('change', event => { state.preset = event.target.value; renderPrompt(); });
$$('[data-prompt-link]').forEach(a => a.addEventListener('click', () => { state.topic = a.dataset.promptLink; $('#prompt-topic').value = state.topic; renderPrompt(); }));
$('#copy-prompt').addEventListener('click', () => { void copyText($('#prompt-output').value, $('#prompt-output'), $('#copy-status')); });

const form = $('#feedback-form');
const feedbackMessage = $('#feedback-message');
const submit = $('#feedback-submit');
let sending = false, lastSent = '';
function formPayload() {
  const data = new FormData(form);
  return { kind: data.get('kind'), message: String(data.get('message') || '').trim(), share: data.get('share') === 'on', website: String(data.get('website') || '') };
}
function feedbackStatus(message, type = '') {
  const status = $('#feedback-status'); status.textContent = message; status.className = `feedback-status ${type}`;
  status.setAttribute('role', type === 'error' ? 'alert' : 'status');
}
function updateFeedback() {
  const length = [...feedbackMessage.value].length;
  $('#feedback-count').textContent = `${length} / 4000`;
  feedbackMessage.setAttribute('aria-invalid', String(length > 4000));
  if (!sending) { const unchanged = lastSent === JSON.stringify(formPayload()); submit.disabled = unchanged; submit.textContent = unchanged ? '送信済み' : '送信する'; }
}
form.addEventListener('input', updateFeedback);
form.addEventListener('change', updateFeedback);
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (sending) return;
  const payload = formPayload(), length = [...payload.message].length;
  if (length < 10 || length > 4000) { feedbackStatus('内容を10〜4000文字で入力してください。', 'error'); feedbackMessage.setAttribute('aria-invalid', 'true'); feedbackMessage.focus(); return; }
  const body = JSON.stringify(payload);
  if (new TextEncoder().encode(body).length > 16384) { feedbackStatus('データ量が上限を超えました。内容を少し短くして送信してください。', 'error'); feedbackMessage.focus(); return; }
  sending = true; submit.disabled = true; submit.textContent = '送信中…'; feedbackStatus('送信しています。');
  const abort = new AbortController(), timeout = window.setTimeout(() => abort.abort(), 25000);
  try {
    const response = await fetch('/api/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'omit', body, signal: abort.signal });
    let result; try { result = await response.json(); } catch { result = null; }
    if (response.status === 201 && typeof result?.receipt === 'string' && result.receipt.length <= 100) {
      lastSent = body; feedbackStatus(`受け付けました。受付番号: ${result.receipt}`, 'success');
    } else if (response.status === 429) {
      const seconds = Number(response.headers.get('Retry-After'));
      feedbackStatus(Number.isFinite(seconds) && seconds > 0 && seconds <= 86400 ? `送信間隔が短すぎます。約${Math.ceil(seconds / 60)}分後に再試行してください。内容は残っています。` : '送信が混み合っています。しばらく待って再試行してください。内容は残っています。', 'error');
    } else if (response.status === 400 || response.status === 422) feedbackStatus('入力内容を確認してください。内容は10〜4000文字で送信できます。', 'error');
    else if (response.status === 413) feedbackStatus('データ量が上限を超えました。内容を少し短くしてください。', 'error');
    else if (response.status === 403) feedbackStatus('このページから送信できませんでした。ガイドを開き直すか、GitHub Issueを利用してください。', 'error');
    else if (response.status === 503 || response.status === 404) feedbackStatus('現在、このフォームの受付を利用できません。内容は残っています。時間をおくか、GitHub Issueを利用してください。', 'error');
    else feedbackStatus(`受付結果を確認できませんでした（HTTP ${response.status}）。内容は残っています。`, 'error');
  } catch {
    feedbackStatus('受付結果を確認できませんでした。接続を確認し、再送前にしばらくお待ちください。内容は残っています。', 'error');
  } finally {
    window.clearTimeout(timeout); sending = false; updateFeedback();
  }
});

renderRoute(); renderDemo(); markNavigation(); updateFeedback();
