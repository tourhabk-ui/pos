/**
 * lib/routes/verdict-facts.ts
 *
 * Факты под вердиктом маршрута — словами. Одни слова на карточку маршрута
 * (components/routes/RouteVerdict) и на ответ Кузьмича и MCP о маршруте
 * (lib/routes/route-today, #3302).
 *
 * До 12.11 строки жили внутри клиентского компонента. Ответу агента о том же
 * маршруте пришлось бы завести свои — и «не смогли узнать», «администратор не
 * отмечал», «в 25 км нет» разошлись бы между экраном и чатом молча, как уже
 * расходились два предиката тревог (шапка collect-signals).
 *
 * Различение, ради которого строки написаны, то же, что у сборщика:
 * `null` — не смогли узнать; пустой список — узнали, там ничего нет. Один
 * текст на оба случая свёл бы его к нулю на экране (§4.0).
 */
import type { RouteSignals } from '@/lib/routes/go-verdict';
import { CORRIDOR_VOLCANO_KM } from '@/lib/safety/corridor';

/** Код KVERT словом. Неизвестный код печатается как есть, а не «зелёный». */
export const ACC_RU: Record<string, string> = {
  green: 'зелёный', yellow: 'жёлтый', orange: 'оранжевый',
  red: 'красный', unassigned: 'код не присвоен',
};

/** Оговорка под вердиктом: чем он является и чем нет. */
export const VERDICT_DISCLAIMER_RU =
  'Это не официальный бюллетень: районных сводок по Камчатке нет. '
  + 'Вердикт складывается по правилам из того, что известно платформе, и решение остаётся за вами.';

export interface VerdictFact {
  label: string;
  value: string;
  /** Приглушённая строка: «не смогли узнать». */
  dim: boolean;
}

export interface VerdictFactsOptions {
  /**
   * Сколько предупреждений назвать поимённо; остальные — числом «и ещё N».
   * Не задано — все (карточка). Срезать молча нельзя: пропавшее
   * предупреждение читалось бы как «его нет».
   */
  maxAlerts?: number;
}

/** Строка факта: что спросили и что ответили. `null` называется словами. */
export function verdictFactLines(s: RouteSignals, opts: VerdictFactsOptions = {}): VerdictFact[] {
  const out: VerdictFact[] = [];

  if (s.alerts === null) {
    out.push({ label: 'Предупреждения', value: 'не смогли узнать', dim: true });
  } else if (s.alerts.length === 0) {
    out.push({ label: 'Предупреждения', value: 'действующих нет', dim: false });
  } else {
    const titles = s.alerts.map((a) => a.title);
    const max = opts.maxAlerts != null && opts.maxAlerts > 0 ? opts.maxAlerts : titles.length;
    const rest = titles.length - max;
    const shown = titles.slice(0, max).join(' · ');
    out.push({ label: 'Предупреждения', value: rest > 0 ? `${shown} · и ещё ${rest}` : shown, dim: false });
  }

  out.push(s.volcanoes === null
    ? { label: 'Вулканы на маршруте', value: 'не смогли узнать', dim: true }
    : s.volcanoes.length === 0
      ? { label: 'Вулканы на маршруте', value: `в ${CORRIDOR_VOLCANO_KM} км нет`, dim: false }
      : {
          label: 'Вулканы на маршруте',
          value: s.volcanoes.map((v) => `${v.name} — ${ACC_RU[v.acc] ?? v.acc}`).join(' · '),
          dim: false,
        });

  // Закрытые точки пути (issue #2079). Старый ответ сервера поля не несёт —
  // тогда строки нет вовсе, а не «закрытых нет».
  if (s.closures !== undefined) {
    out.push(s.closures === null
      ? { label: 'Закрытые точки', value: 'не смогли узнать', dim: true }
      // «Нет» читалось как проверка точек. Закрытие — отметка администратора,
      // и её отсутствие ничего не проверяет (15.10, §0).
      : s.closures.length === 0
        ? { label: 'Закрытые точки', value: 'администратор не отмечал', dim: false }
        : {
            label: 'Закрытые точки',
            value: s.closures.map((c) => (c.reason ? `${c.place} — ${c.reason}` : c.place)).join(' · '),
            dim: false,
          });
  }

  if (s.inSeason !== null) {
    out.push({ label: 'Сезон', value: s.inSeason ? 'маршрут в своём сезоне' : 'маршрут вне сезона', dim: false });
  }

  return out;
}
