import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { getTextWidth } from '@evenrealities/pretext';
import { contextItem, contextItems, type ContextAction } from '../src/core/context-menu.ts';
import { locales } from '../src/core/i18n.ts';
import type { Locale } from '../src/core/types.ts';

// Review each column in the context of its action before accepting a wording change.
// An exact comparison catches valid-length translations accidentally assigned to a different action.
const order: Locale[] = ['en', 'ja', 'zh-Hans', 'zh-Hant', 'ko', 'es', 'fr', 'de', 'it'];
const reviewed: Record<ContextAction, string[]> = {
  singleMessages: ["Single messages", "1件ずつ表示", "逐条显示", "逐則顯示", "한 건씩 보기", "De uno en uno", "Un par un", "Einzeln zeigen", "Uno alla volta"],
  inputAndReply: ["Input + reply", "入力と回答を表示", "输入和回复", "輸入與回覆", "입력과 답변", "Entrada y resp.", "Saisie + réponse", "Eingabe + Antwort", "Input e risposta"],
  suggestionsOff: ["Suggestions off", "候補をオフ", "关闭建议", "關閉建議", "추천 끄기", "Sin sugerencias", "Sans suggestions", "Vorschläge aus", "Niente proposte"],
  museDecides: ["Muse decides", "候補はMuse任せ", "由 Muse 决定", "由 Muse 決定", "Muse가 결정", "Muse decide", "Muse décide", "Muse entscheidet", "Decide Muse"],
  alwaysAsk: ["Always ask", "候補を毎回依頼", "每次请求建议", "每次要求建議", "매번 추천 요청", "Pedir siempre", "À chaque réponse", "Immer anfragen", "Chiedi sempre"],
  markAllRead: ['Mark all read', '全件既読', '全部标为已读', '全部標為已讀', '모두 읽음 처리', 'Dar todo por leído', 'Tout marquer lu', 'Alle als gelesen', 'Tutti come letti'],
  home: ['Home', 'ホーム', '主页', '首頁', '홈', 'Inicio', 'Accueil', 'Startseite', 'Home'],
  sendRecording: ['Send audio', '録音を送信', '发送录音', '傳送錄音', '녹음 전송', 'Enviar audio', 'Envoyer l’audio', 'Audio senden', 'Invia audio'],
  cancelRecording: ['Discard audio', '録音を中止', '取消录音', '取消錄音', '녹음 취소', 'Descartar audio', 'Annuler l’audio', 'Audio verwerfen', 'Scarta audio'],
  chat: ['Chat', 'チャット', '聊天', '聊天', '채팅', 'Chat', 'Discussion', 'Chat', 'Chat'],
  spaces: ['Spaces', 'スペース', '空间', '空間', '스페이스', 'Espacios', 'Espaces', 'Spaces', 'Spazi'],
  cards: ['Card view', 'カード表示', '卡片视图', '卡片檢視', '카드 보기', 'Vista de tarjetas', 'Vue en cartes', 'Kartenansicht', 'Vista schede'],
  list: ['List view', 'リスト表示', '列表视图', '列表檢視', '목록 보기', 'Vista de lista', 'Vue en liste', 'Listenansicht', 'Vista elenco'],
  items: ['Space items', '項目一覧', '空间项目', '空間項目', '공간 항목', 'Elementos', 'Éléments', 'Einträge', 'Elementi'],
  wake: ['Wake display', '表示を戻す', '恢复显示', '恢復顯示', '화면 켜기', 'Mostrar pantalla', 'Réafficher', 'Anzeige wecken', 'Mostra display'],
};

test('every contextual action and supported locale has reviewed wording', () => {
  assert.deepEqual(new Set(order), new Set(locales.map(locale => locale.code)));
  assert.deepEqual(Object.keys(reviewed).sort(), Object.keys(contextItems).sort());
});
for (const [column, locale] of order.entries()) {
  test(`context menu labels in ${locale} match their action and fit a single row`, () => {
    const dictionary = ['ja', 'en'].includes(locale) ? undefined : JSON.parse(readFileSync(
      new URL(`../src/core/locales/${locale}.json`, import.meta.url), 'utf8'));
    for (const action of Object.keys(contextItems) as ContextAction[]) {
      const { itemName } = contextItem(action, locale);
      if (dictionary) assert.ok(Object.hasOwn(dictionary, contextItems[action][2]), `${locale}: missing translation for ${action}`);
      assert.equal(itemName, reviewed[action][column], `${locale}: review the label for ${action}`);
      assert.ok(itemName.trim() && !/[\r\n…]|\.\.\./.test(itemName));
      assert.ok(Buffer.byteLength(itemName) <= 32, `${action}: SDK name limit`);
      // App width budget leaves room for the OS overlay's left and right margins.
      assert.ok(getTextWidth(itemName) <= 160, `${action}: label too wide for compact menu`);
    }
  });
}
