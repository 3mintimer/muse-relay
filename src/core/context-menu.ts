import { translate } from './i18n';
import type { Language } from './types';

// Native events identify actions by ID. Retired actions keep their IDs reserved.
export const contextItems = {
  home: [3, 'ホーム', 'Home'],
  sendRecording: [4, '録音を送信', 'Send audio'],
  spaces: [5, 'スペース', 'Spaces'],
  chat: [6, 'チャット', 'Chat'],
  cancelRecording: [7, '録音を中止', 'Discard audio'],
  cards: [8, 'カード表示', 'Card view'],
  list: [8, 'リスト表示', 'List view'],
  items: [9, '項目一覧', 'Space items'],
  wake: [10, '表示を戻す', 'Wake display'],
  markAllRead: [12, '全件既読', 'Mark all read'],
} as const;

export type ContextAction = keyof typeof contextItems;

export function contextItem(action: ContextAction, language: Language) {
  const [itemID, ja, en] = contextItems[action];
  return { itemID, itemName: translate(language, ja, en) };
}
