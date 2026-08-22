/**
 * lib/agents/cron-fruitless.ts
 *
 * Крон идёт, отчитывается — и не доводит дело до конца.
 *
 * Три вопроса о кроне уже заданы: `cron-liveness` — «запускался ли»,
 * `cron-idle` — «сделал ли работу», `cron-failing` — «отчитывается ли отказом
 * подряд». Между ними осталась щель, и в ней 23.08.2026 нашлись двадцать два
 * дня немоты разведчика.
 *
 * Разведчик каждое утро запускался (liveness зелёный), находил свежие
 * материалы в лентах — `items_processed` больше нуля, значит для `cron-idle`
 * он «сделал работу», — и не выпускал НИЧЕГО, потому что фактчек-судья не мог
 * ответить: провайдеры молчали. Статус таких прогонов `partial`, а
 * `cron-failing` считает только `failed`. Двадцать два прогона подряд не
 * подняли ни одной тревоги; владелец нашёл немоту сам, вручную.
 *
 * Здесь четвёртый вопрос: «когда крон в последний раз ДОВЁЛ дело до конца».
 * Судим по отсутствию `success` за окно, а не по одному прогону: `partial`
 * бывает и законным (нечего было выпускать), а вот две недели подряд — нет.
 *
 * Чистая функция: тестируется без БД и без сети.
 */
import type { CronEntry } from './cron-registry';

/** Строка истории: чем закончился прогон и когда. */
export interface CronOutcomeRow {
  agent_id: string;
  status: string;
  ended_at: string;
  /** Причина пропуска, если крон её записал (scout-digest пишет). */
  skip_reason?: string | null;
}

export interface FruitlessCron {
  key: string;
  label: string;
  /** Сколько прогонов подряд закончились без успеха. */
  runs: number;
  /** Когда крон в последний раз довёл дело до конца (ISO) или null. */
  lastSuccessAt: string | null;
  /** Сколько суток прошло с последнего успеха; null — успеха не было в окне. */
  daysSinceSuccess: number | null;
  /** Самая частая причина пропуска за серию — с неё начинают разбор. */
  dominantReason: string | null;
}

/**
 * Сколько бесплодных прогонов подряд считать поломкой.
 *
 * Три — потому что у суточной джобы это трое суток тишины: случайность такой
 * длины не бывает, а два дня подряд у разведчика случаются законно (выходные
 * без новостей).
 */
export const FRUITLESS_RUNS_THRESHOLD = 3;

/**
 * Кроны, которые идут и не доводят дело до конца (чистая).
 *
 * @param entries записи реестра (обычно CRON_REGISTRY)
 * @param runs    история прогонов любого статуса, порядок значения не имеет
 * @param nowMs   текущее время — передаётся, чтобы функция осталась чистой
 */
export function findFruitlessCrons(
  entries: readonly CronEntry[],
  runs: readonly CronOutcomeRow[],
  nowMs: number,
  threshold = FRUITLESS_RUNS_THRESHOLD,
): FruitlessCron[] {
  const byAgent = new Map<string, CronOutcomeRow[]>();
  for (const r of runs) {
    const list = byAgent.get(r.agent_id);
    if (list) list.push(r);
    else byAgent.set(r.agent_id, [r]);
  }
  for (const list of byAgent.values()) {
    list.sort((a, b) => Date.parse(b.ended_at) - Date.parse(a.ended_at));
  }

  const out: FruitlessCron[] = [];

  for (const e of entries) {
    if (e.agentId === null) continue;
    const history = byAgent.get(e.agentId) ?? [];
    // Пустая или короткая история — предмет liveness, не этой проверки.
    if (history.length < threshold) continue;

    // Серия без успеха с самого свежего прогона.
    let streak = 0;
    while (streak < history.length && history[streak].status !== 'success') streak++;
    if (streak < threshold) continue;

    // `failed` подряд уже ловит cron-failing: не дублируем тревогу, у неё
    // другой адрес разбора (упало) и другая формулировка.
    const window = history.slice(0, streak);
    if (window.every((r) => r.status === 'failed')) continue;

    const success = history.find((r) => r.status === 'success') ?? null;
    const daysSince = success === null
      ? null
      : Math.floor((nowMs - Date.parse(success.ended_at)) / 86_400_000);

    // Самая частая причина пропуска в серии. Одна и та же двадцать раз подряд
    // означает стену; разные — что молчат разные вещи, и разбор другой.
    const tally = new Map<string, number>();
    for (const r of window) {
      const reason = (r.skip_reason ?? '').trim();
      if (reason === '') continue;
      tally.set(reason, (tally.get(reason) ?? 0) + 1);
    }
    let dominant: string | null = null;
    let best = 0;
    for (const [reason, n] of tally) {
      if (n > best) { dominant = reason; best = n; }
    }

    out.push({
      key: e.key,
      label: e.label,
      runs: streak,
      lastSuccessAt: success?.ended_at ?? null,
      daysSinceSuccess: daysSince,
      dominantReason: dominant,
    });
  }

  return out;
}

/** Человекочитаемая строка для Telegram. */
export function formatFruitlessCrons(list: readonly FruitlessCron[]): string {
  return list
    .map((c) => {
      const since = c.daysSinceSuccess === null
        ? 'успеха не было за всё окно'
        : `последний выпуск ${c.daysSinceSuccess} дн назад`;
      const why = c.dominantReason === null
        ? 'причина пропуска не записана'
        : `чаще всего: ${c.dominantReason}`;
      return `${c.label} — ${c.runs} прогонов подряд без результата, ${since}, ${why}`;
    })
    .join('; ');
}
