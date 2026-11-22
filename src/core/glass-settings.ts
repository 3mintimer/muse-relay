import { translate } from './i18n';
import type { Settings } from './types';

export type GlassSettingKey = 'shareLocation' | 'locationIntervalMinutes' | 'images' | 'chatLayout'
  | 'returnToChatAfterSend' | 'autoHideSeconds' | 'pollSeconds';

export function glassSettings(settings: Settings) {
  const t = (ja: string, en: string, values?: Record<string, number>) => translate(settings.language, ja, en, values);
  const onOff = [[false, t('オフ', 'Off')], [true, t('オン', 'On')]] as const;
  const seconds = (value: number) => t('{seconds} 秒', '{seconds} seconds', {seconds: value});
  function field<K extends GlassSettingKey>(key: K, title: string, options: ReadonlyArray<readonly [Settings[K], string]>) {
    return { key, title, options: options.map(([value, label]) => ({
      label, selected: settings[key] === value, change: { [key]: value } as Pick<Settings, K>,
    })) };
  }
  return [
    field('shareLocation', t('チャットに現在地を付ける', 'Share location in chat'), onOff),
    ...(settings.shareLocation ? [field('locationIntervalMinutes', t('位置の取得間隔', 'Location update interval'),
      ([1, 3, 5] as const).map(minutes => [minutes, t('{minutes} 分', '{minutes} min', {minutes})]))] : []),
    field('images', t('画像を使用', 'Enable images'), onOff),
    field('chatLayout', t('チャット表示', 'Chat display'), [
      ['exchange', t('入力と回答', 'Input & reply')], ['single', t('メッセージごと', 'One message at a time')],
    ]),
    field('returnToChatAfterSend', t('送信後にチャットへ戻る', 'Return to chat after sending'), onOff),
    field('autoHideSeconds', t('自動で非表示', 'Auto-hide display'),
      [0, 5, 10, 15, 20, 25, 30].map(value => [value, value ? seconds(value) : t('オフ', 'Off')])),
    field('pollSeconds', t('通常の受信間隔', 'Normal receive interval'),
      [...new Set([5, 15, 30, 60, settings.pollSeconds])].sort((a, b) => a - b).map(value => [value, seconds(value)])),
  ];
}
