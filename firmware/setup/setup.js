'use strict';
const el = id => document.getElementById(id);
let port, reader, pending, reading, generation = 0;
const result = (message, error = false) => {
  el('result').textContent = message;
  el('result').dataset.error = String(error);
};
const connected = value => {
  el('connect').disabled = value;
  el('disconnect').disabled = !value;
  el('save').disabled = !value;
  el('status').disabled = !value;
  el('connection').textContent = value ? 'USB 接続済み' : '未接続';
};

async function closePort() {
  generation++;
  if (pending) { pending.reject(new Error('USB 接続が終了しました。')); pending = null; }
  if (reader) await reader.cancel().catch(() => {});
  if (reading) await reading.catch(() => {});
  if (port) await port.close().catch(() => {});
  port = reader = reading = undefined;
  connected(false);
}

async function readPort(active, epoch) {
  const decode = new TextDecoder();
  let partial = '';
  try {
    while (epoch === generation) {
      const {value, done} = await active.read();
      if (done) break;
      partial += decode.decode(value, {stream:true});
      const lines = partial.split('\n');
      partial = lines.pop();
      if (partial.length > 4096) partial = ''; // Discard raw firmware logs.
      for (const raw of lines) {
        const line = raw.trim();
        // Never display arbitrary serial output: it can contain private logs.
        if (pending && line.startsWith(pending.prefix)) {
          const accepted = pending.status ? line.startsWith('@relay {') :
            line === pending.prefix + 'ok' || line.startsWith(pending.prefix + 'ok ');
          if (!accepted && !line.startsWith(pending.prefix + 'error ')) continue;
          const wait = pending; pending = null;
          if (!accepted) wait.reject(new Error('機器が設定を受け付けませんでした。入力値を確認してください。'));
          else wait.resolve(line);
        }
      }
    }
  } catch {
    if (epoch === generation) result('USB 接続が終了しました。再起動後に接続し直してください。');
  } finally {
    active.releaseLock();
    if (epoch === generation) {
      reader = undefined;
      if (pending) { pending.reject(new Error('機器が切断されました。保存済みの場合は再起動後に確認してください。')); pending = null; }
      connected(false);
    }
  }
}

async function command(text) {
  if (!port?.writable || pending) throw new Error('USB 接続を確認してください。');
  if (/[\r\n]/.test(text)) throw new Error('設定に改行は使えません。');
  let timeout, retry, wait, write;
  const response = new Promise((resolve, reject) => {
    wait = {resolve,reject, status:text === 'relay_status',
      prefix:text.startsWith('sdk_token=') ? '@sdk_token ' : '@relay '};
    pending = wait;
    timeout = setTimeout(() => {
      if (pending === wait) {
        pending = null;
        reject(new Error('機器から確認が届きません。Muse Relay ファームウェアと USB 接続を確認してください。'));
      }
    }, 25000);
  });
  // A disconnected port may reject before write() has returned.
  response.catch(() => {});
  const writer = port.writable.getWriter();
  try {
    // A port opening may restart the gadget. Repeating the same setting is
    // idempotent; the SDK token is last and must never be resent after its ACK.
    const bytes = new TextEncoder().encode('\n>' + text + '\n');
    while (pending === wait) {
      write = writer.write(bytes);
      await Promise.race([write, response]);
      if (pending !== wait) break;
      await Promise.race([response, new Promise(resolve => { retry = setTimeout(resolve, 3000); })]);
      clearTimeout(retry);
    }
    return await response;
  } finally {
    clearTimeout(timeout);
    clearTimeout(retry);
    if (pending === wait) pending = null;
    // Keep the port reserved until an in-flight USB write settles, even when
    // a disconnect or timeout has already rejected the ACK wait.
    await write?.catch(() => {});
    writer.releaseLock();
  }
}

el('connect').addEventListener('click', async () => {
  try {
    if (port) await closePort();
    port = await navigator.serial.requestPort({filters:[{usbVendorId:0x303a}]});
    await port.open({baudRate:115200});
    await port.setSignals({dataTerminalReady:false, requestToSend:false});
    reader = port.readable.getReader();
    reading = readPort(reader, ++generation);
    await new Promise(resolve => setTimeout(resolve, 1000));
    if (!reader) throw new Error('USB disconnected during startup');
    connected(true); result('接続しました。必要な設定を入力して保存します。');
  } catch {
    await closePort();
    result('機器を接続できませんでした。USB とブラウザーの機器選択を確認してください。', true);
  }
});
el('disconnect').addEventListener('click', () => void closePort());
el('config-file').addEventListener('change', async event => {
  try {
    const file = event.target.files[0];
    if (!file) return;
    if (file.size > 8192) throw new Error();
    const config = JSON.parse(await file.text());
    if (typeof config.relay_url !== 'string' || typeof (config.device_token ?? config.relay_token) !== 'string') throw new Error();
    const gateway = config.relay_gateway_token ?? config.gateway_token;
    if (gateway !== undefined && typeof gateway !== 'string') throw new Error();
    el('relay-url').value = config.relay_url;
    el('relay-token').value = config.device_token ?? config.relay_token;
    el('gateway-token').value = gateway ?? '';
    el('clear-gateway').checked = gateway === '';
    if (typeof config.sdk_token === 'string') el('sdk-token').value = config.sdk_token;
    result('設定ファイルを読み込みました。まだ機器には保存していません。');
  } catch { result('設定ファイルを読み込めませんでした。機器用 JSON を選んでください。', true); }
});
el('settings').addEventListener('submit', async event => {
  event.preventDefault();
  el('save').disabled = el('status').disabled = true;
  try {
    const url = el('relay-url').value.trim();
    const token = el('relay-token').value.trim();
    const gateway = el('gateway-token').value.trim();
    const clearGateway = el('clear-gateway').checked;
    const sdk = el('sdk-token').value.trim();
    if (!url && !token && !sdk && !gateway && !clearGateway) throw new Error('保存する設定を入力してください。');
    if ((url && !token) || (!url && token)) throw new Error('中継 URL と機器用トークンを両方入力してください。');
    if (url) {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || url.length > 191) throw new Error('HTTPS の中継 URL を確認してください。');
      if (token.length < 32 || token.length > 127 || /[^!-~]/.test(token)) throw new Error('機器用トークンは 32〜127 文字で入力してください。');
    }
    if (gateway.length > 1024 || /[^!-~]/.test(gateway)) throw new Error('追加の認証トークンは半角の印字可能文字で 1,024 文字以内にしてください。');
    if (gateway && clearGateway) throw new Error('追加認証を保存する場合は、解除のチェックを外してください。');
    if (sdk && !/^mgst_[A-Za-z0-9_-]+$/.test(sdk)) throw new Error('Muse Gadget SDK トークンを確認してください。');
    if (url) { await command('relay_url=' + url); await command('relay_token=' + token); }
    if (gateway || clearGateway) await command('relay_gateway_token=' + gateway);
    if (sdk) await command('sdk_token=' + sdk);
    el('relay-token').value = el('gateway-token').value = el('sdk-token').value = '';
    el('clear-gateway').checked = false;
    el('config-file').value = '';
    result(sdk ? '保存しました。機器の再起動後、Muse アプリでペアリングしてください。' : '保存しました。USB 電源を入れ直して設定を反映してください。');
  } catch (error) { result(error.message, true); }
  finally { el('save').disabled = el('status').disabled = !reader; }
});
el('status').addEventListener('click', async () => {
  try {
    const reply = await command('relay_status');
    const status = JSON.parse(reply.slice('@relay '.length));
    result('中継設定: ' + (status.configured ? '設定済み' : '未設定') + '\nMuse: ' + (status.sdk_connected ? '接続済み' : '未接続') +
      (typeof status.gateway_configured === 'boolean' ? '\n追加認証: ' + (status.gateway_configured ? '設定済み' : '未設定') : ''));
  } catch (error) { result(error.message, true); }
});
if (!('serial' in navigator)) {
  el('connect').disabled = true;
  result('USB 設定には Chrome または Edge のデスクトップ版が必要です。', true);
}
