import { getTextWidth } from '@evenrealities/pretext';
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

export function glassPromptLabel(prompt: string, slot: number): string | undefined {
  if (!prompt.trim()) return undefined;
  const firstLine = prompt.split(/[\r\n\u2028\u2029]/u, 1)[0]!.trim().replace(/\s+/gu, ' ');
  return firstLine ? `${slot + 1}. ${firstLine}` : `${slot + 1}.`;
}

export function promptMenuItems(prompts: string[]) {
  const encoder = new TextEncoder();
  return prompts.flatMap((prompt, slot) => {
    const label = glassPromptLabel(prompt, slot);
    if (!label) return [];
    let itemName = '';
    for (const char of label) {
      const next = itemName + char;
      if (encoder.encode(next + '…').length > 32 || getTextWidth(next + '…') > 160) {
        itemName += '…';
        break;
      }
      itemName = next;
    }
    return [{ itemID: 13 + slot, itemName, slot }];
  });
}
