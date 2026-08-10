/**
 * lib/on-route/connectivity.ts
 *
 * На какой ступени связи человек находится — и что из этого следует.
 *
 * До этого на экране был один флаг `isOffline` и одна подсказка: «Офлайн-режим:
 * карты и точки маршрута доступны». Она сообщала РЕЖИМ и умалчивала о двух
 * вещах, которые в поле важнее режима:
 *
 *   1. Доступны ли карты на самом деле. Фраза утверждала это безусловно, хотя
 *      карта лежит в телефоне, только если её скачали. Без пакета офлайн-режим
 *      означает пустой экран, а подсказка обещала обратное.
 *   2. Насколько свежо то, что показано. Снимок, снятый три дня назад, и живые
 *      данные выглядели одинаково. Предупреждение о циклоне, снятое вчера,
 *      сегодня уже ничего не значит — но выглядит как сегодняшнее.
 *
 * Ступеней три, и человек должен видеть, на какой он:
 *
 *   online   — данные живые;
 *   cache    — снимок от такого-то часа, живых предупреждений не будет;
 *   offline  — только то, что в пакете; SOS и 112 работают всегда.
 *
 * Чистые функции: ни сети, ни DOM. Время передаётся снаружи, чтобы проверка
 * не зависела от часов машины.
 */

export type ConnectivityStep = 'online' | 'cache' | 'offline';

export interface ConnectivityState {
  step: ConnectivityStep;
  /** Короткая строка состояния — то, что читается одним взглядом. */
  title: string;
  /** Что из этого следует. Пустая строка — следствий называть не нужно. */
  detail: string;
  /** Тон для подложки: спокойный, предупреждающий, тревожный. */
  tone: 'calm' | 'warn' | 'alarm';
}

/** «сегодня 14:32» / «вчера 09:05» / «08.08 в 19:40» — возраст снимка словами. */
export function snapshotStamp(at: number, now: number): string {
  const d = new Date(at);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const dayMs = 86_400_000;
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  if (at >= startOfToday) return `сегодня ${hh}:${mm}`;
  if (at >= startOfToday - dayMs) return `вчера ${hh}:${mm}`;
  const dd = String(d.getDate()).padStart(2, '0');
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mo} в ${hh}:${mm}`;
}

/**
 * Через сколько снимок перестаёт говорить о сегодняшнем дне.
 *
 * Предупреждения МЧС живут часами: погодное окно закрывается за сутки, а
 * дорожное ограничение может действовать неделю. Берём сутки — после них
 * снимок описывает не сегодня, и это надо назвать, а не подразумевать.
 */
export const SNAPSHOT_STALE_MS = 24 * 60 * 60 * 1000;

export function connectivityState(params: {
  online: boolean;
  /** Когда снят офлайн-пакет (карта маршрута). null — пакета нет. */
  packageAt: number | null;
  /** Когда последний раз успешно получили живые данные. null — ни разу. */
  liveAt: number | null;
  now: number;
}): ConnectivityState {
  const { online, packageAt, liveAt, now } = params;

  if (online) {
    return {
      step: 'online',
      title: 'Связь есть — данные живые',
      detail: '',
      tone: 'calm',
    };
  }

  // Связи нет. Дальше решает единственное: есть ли что показывать.
  if (packageAt === null && liveAt === null) {
    return {
      step: 'offline',
      title: 'Связи нет, и пакет не скачан',
      // Самое честное, что можно сказать: карты не будет. И сразу то, что
      // работает всегда, — иначе человек решит, что не работает ничего.
      detail: 'Карты и предупреждений в телефоне нет. SOS и 112 работают без сети.',
      tone: 'alarm',
    };
  }

  const at = Math.max(packageAt ?? 0, liveAt ?? 0);
  const stale = now - at > SNAPSHOT_STALE_MS;
  return {
    step: packageAt !== null ? 'cache' : 'offline',
    title: `Связи нет — снимок от ${snapshotStamp(at, now)}`,
    detail: stale
      ? 'Снимку больше суток: предупреждения могли измениться. Живых не будет до связи.'
      : 'Живых предупреждений не будет до связи. SOS и 112 работают.',
    tone: stale ? 'alarm' : 'warn',
  };
}
