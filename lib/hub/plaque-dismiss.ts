/**
 * Крестик плашки «подключите MAX» помнит, ЧТО именно скрыто (проверка
 * качества 24.10).
 *
 * Прежде скрытие писалось одним ключом без состояния: закрыл мягкую подсказку
 * «Telegram без имён» — и предупреждение «заявки до вас не дойдут» после
 * отвалившегося чата не появлялось больше никогда.
 *
 *  - мягкая подсказка (`telegram`) — скрыта в этом браузере, пока состояние
 *    то же; сменилось — плашка о новом состоянии показывается заново;
 *  - предупреждение (`none`) — скрыто только до конца сессии вкладки: о том,
 *    что заявки не доходят, крестик навсегда не заставит молчать.
 *
 * Хранилище недоступно (приватное окно, запрет сайта) — «не скрыто»:
 * лишний показ плашки честнее, чем молчание о недоставке.
 */
import { logSwallowedFailure } from '@/lib/observability/swallowed';

export type ChannelPlaque = 'none' | 'telegram';

function storeFor(plaque: ChannelPlaque): Storage {
  return plaque === 'none' ? window.sessionStorage : window.localStorage;
}

export function isPlaqueDismissed(base: string, plaque: ChannelPlaque): boolean {
  try {
    return storeFor(plaque).getItem(`${base}.${plaque}`) === '1';
  } catch {
    return false;
  }
}

export function rememberPlaqueDismissed(base: string, plaque: ChannelPlaque, scope: string): void {
  try {
    storeFor(plaque).setItem(`${base}.${plaque}`, '1');
  } catch (err) {
    logSwallowedFailure(scope, 'сохранение свёрнутой плашки', err);
  }
}
