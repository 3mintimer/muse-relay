const ja = {
  title:'ATOM の診断と復旧', token:'管理者トークン', show:'状態を確認', history:'端末の履歴',
  controls:'復旧操作', hint:'指示は5分間有効です。ATOMが待機状態に戻ると実行します。',
  reconnect:'Muse に再接続', reboot:'端末を再起動', confirm:'この操作を指示しますか？',
  auth:'管理者トークンを確認してください。', conflict:'指示が更新されました。現在の状態を確認してください。',
  received:'診断の最終受信', lastPoll:'最後に成功したジョブ取得（概算）', never:'この起動以降は未確認',
  state:'報告時の状態', up:'接続', down:'切断', boot:'起動識別子', fw:'FW ／ 取得結果 ／ 通信エラー ／ TLS',
  empty:'まだ端末から報告がありません', cmd:'最後の指示', restarted:'再起動後の報告を受信',
  accepted:'端末で受理', expired:'期限切れ', pending:'実行待ち', updated:'状態を更新しました。',
  phases:['待機','ジョブ取得','会話処理','FW 更新','復旧処理'],
  events:['','起動','Wi-Fi 切断','Wi-Fi 接続','Muse 切断','Muse 接続','ジョブ取得失敗','ジョブ取得成功','診断通信失敗','診断通信復帰','取得処理停止','Muse 再接続操作','再起動操作','再接続失敗','ジョブ取得の通信エラー','TLS 検証エラー','復旧指示を延期'],
};
const en = {
  title:'ATOM diagnostics and recovery', token:'Administrator token', show:'Check status', history:'Device history',
  controls:'Recovery controls', hint:'Commands expire after five minutes. The ATOM executes them when idle.',
  reconnect:'Reconnect Muse', reboot:'Restart device', confirm:'Send this command?',
  auth:'Check your administrator token.', conflict:'The command changed. Refresh the status before retrying.',
  received:'Last diagnostic report', lastPoll:'Last successful job poll (estimated)', never:'No success since boot',
  state:'State at last report', up:'connected', down:'disconnected', boot:'Boot ID', fw:'Firmware / poll result / transport error / TLS',
  empty:'Waiting for the first device report', cmd:'Last command', restarted:'Device reported after restart',
  accepted:'Accepted by device', expired:'Expired', pending:'Pending', updated:'Status updated.',
  phases:['idle','polling','processing chat','updating firmware','recovering'],
  events:['','Boot','Wi-Fi disconnected','Wi-Fi connected','Muse disconnected','Muse connected','Poll failed','Poll succeeded','Diagnostics failed','Diagnostics resumed','Poll stalled','Reconnect requested','Restart requested','Reconnect failed','Poll transport error','TLS verification error','Recovery deferred'],
};

export function maintenancePage(acceptLanguage) {
  const japanese = /^ja\b/i.test(acceptLanguage || '');
  const t = japanese ? ja : en;
  return `<!doctype html><html lang="${japanese ? 'ja' : 'en'}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${t.title}</title><style>
:root{color-scheme:light dark;font:17px system-ui}body{max-width:48rem;margin:2rem auto;padding:0 1rem}section{margin:1.5rem 0}input,button{font:inherit;padding:.55rem;margin:.2rem;max-width:100%;box-sizing:border-box}dt{font-weight:650}dd{margin:.1rem 0 .8rem}li{margin:.4rem 0}#msg{min-height:1.5rem}
</style><main><h1>${t.title}</h1><form id="auth"><label>${t.token} <input type="password" id="token" required autocomplete="off"></label><button>${t.show}</button></form>
<p role="status" id="msg"></p><section id="panel" hidden><dl id="values"></dl><h2>${t.history}</h2><ol id="history"></ol><h2>${t.controls}</h2>
<p>${t.hint}</p><button data-action="reconnect">${t.reconnect}</button><button data-action="reboot">${t.reboot}</button></section></main>
<script>
const t=${JSON.stringify(t)};
const el=id=>document.getElementById(id);
const fmt=ms=>new Date(ms).toLocaleString(document.documentElement.lang);
let timer, previous=null, pending=null;
async function call(method, data) {
  const res=await fetch('/admin/device-maintenance',{method,headers:{Authorization:'Bearer '+el('token').value,'Content-Type':'application/json'},
    body:data && JSON.stringify(data),cache:'no-store',redirect:'error'});
  if (res.status===401) { el('panel').hidden=true; clearInterval(timer); throw Error(t.auth); }
  if (res.status===409) { pending=null; throw Error(t.conflict); }
  if (!res.ok) throw Error('HTTP '+res.status);
  return res.json();
}
function item(key,value) {
  const label=document.createElement('dt'), field=document.createElement('dd');
  label.textContent=key; field.textContent=value; el('values').append(label,field);
}
async function refresh() {
  try {
    const {report:r,command:c}=await call('GET');
    previous=c?.id??null; el('panel').hidden=false; el('values').replaceChildren(); el('history').replaceChildren();
    if (r) {
      item(t.received,fmt(r.seen)+' ('+Math.max(0,Math.floor((Date.now()-r.seen)/1000))+' s)');
      item(t.lastPoll,r.poll_age<0?t.never:fmt(r.seen-r.poll_age*1000));
      item(t.state,'Wi-Fi '+(r.wifi?t.up:t.down)+' / Muse '+(r.muse?t.up:t.down)+' / '+t.phases[r.phase]);
      item(t.boot,r.boot); item(t.fw,[r.fw,r.poll,r.transport,r.tls].join(' / '));
      for (const [boot,at,event,detail] of [...r.history].reverse()) {
        const row=document.createElement('li'); row.textContent=t.events[event]+' ('+t.boot+' '+boot+', +'+at+' s, '+detail+')'; el('history').append(row);
      }
    } else item(t.received,t.empty);
    if (c) {
      let status=Date.now()>=c.expires?t.expired:t.pending;
      if (r?.command===c.id) status=c.action==='reboot'&&r.boot!==r.command_boot?t.restarted:t.accepted;
      item(t.cmd,t[c.action]+' / '+status);
    }
    el('msg').textContent=t.updated;
  } catch(error) { el('msg').textContent=error.message; }
}
el('auth').onsubmit=async e=>{e.preventDefault();clearInterval(timer);await refresh();if(!el('panel').hidden)timer=setInterval(refresh,15000)};
for (const button of document.querySelectorAll('[data-action]')) button.onclick=async()=>{
  if (!confirm(button.textContent+' — '+t.confirm)) return;
  try {
    const action=button.dataset.action;
    if (pending?.action!==action) pending={action,id:crypto.randomUUID(),previous};
    await call('POST',pending); pending=null; await refresh();
  } catch(error) { el('msg').textContent=error.message; }
};
</script></html>`;
}
