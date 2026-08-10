/**
 * lib/agents/cron-failing.ts
 *
 * Крон, который падает КАЖДЫЙ раз, невидим обоим сторожам сразу.
 *
 * Их два, и каждый по отдельности разумен:
 *   `cron-liveness`  — «крон запускался?» Читает историю прогонов без разбора
 *                      статуса, потому что падение — тоже отметка о запуске.
 *                      Крон, падающий раз в шесть часов, для него живее всех.
 *   `cron-idle`      — «крон сделал работу?» Берёт только УСПЕШНЫЕ прогоны,
 *                      потому что судит о нулевой выработке при зелёном
 *                      статусе. У постоянно падающего успешных нет вовсе,
 *                      история пуста, и он выпадает по правилу «меньше порога
 *                      прогонов — судить рано».
 *
 * Между «запускался» и «сделал» есть третье состояние: запускался, честно
 * сообщил об отказе — и так каждый раз. Синк авиационных кодов вулканов
 * (KVERT) прожил в нём тринадцать дней: последний успех 28.07, дальше HTTP 502
 * каждые шесть часов, потому что источник сменил формат и стал отдавать HTML
 * вместо VONA. Парсер отказывался писать разобранные нули — правильно, лучше
 * ничего, чем ложь. Но `volcano_status` замер на снимке двухнедельной
 * давности, а главная показывает вулканы только с повышенным кодом. Пусто в
 * этом блоке значит либо «всё спокойно», либо «мы смотрим в прошлое», и
 * снаружи это неотличимо. Устаревший ЗЕЛЁНЫЙ — самый опасный из цветов.
 *
 * Здесь третий вопрос: «крон отчитывается отказом подряд?» Судим по серии, а
 * не по одному падению: сеть моргает у всех. И судим по ВСЕМ кронам реестра, а
 * не только там, где ноль объявлен ненормальным: серия отказов — это отказ при
 * любой семантике нуля.
 *
 * Чистые функции: тестируются без БД и без сети.
 */
import type { CronEntry } from './cron-registry';

/** Строка истории прогонов со статусом — в отличие от CronRunRow сторожа холостых. */
export interface CronStatusRow {
  agent_id: string;
  status: string;
  ended_at: string;
  /** Текст последней ошибки (agent_run_history.error_msg), если крон его записал. */
  error?: string | null;
}

export interface FailingCron {
  key: string;
  label: string;
  /** Сколько подряд идущих прогонов завершились отказом. */
  runs: number;
  /** Когда крон в последний раз отработал успешно (ISO) или null. */
  lastSuccessAt: string | null;
  /** Ошибка свежайшего падения — с неё начинают разбор. */
  lastError: string | null;
}

/**
 * Сколько отказов подряд считать поломкой. Два — уже не случайность (при
 * шестичасовом расписании это половина суток), но ещё не паника на одном
 * сетевом сбое.
 */
export const FAILING_RUNS_THRESHOLD = 2;

/**
 * Находит кроны, у которых ВСЕ последние прогоны — отказ (чистая).
 *
 * @param entries записи реестра (обычно CRON_REGISTRY)
 * @param runs    история прогонов ЛЮБОГО статуса, порядок значения не имеет
 */
export function findFailingCrons(
  entries: readonly CronEntry[],
  runs: readonly CronStatusRow[],
  threshold = FAILING_RUNS_THRESHOLD,
): FailingCron[] {
  const byAgent = new Map<string, CronStatusRow[]>();
  for (const r of runs) {
    const list = byAgent.get(r.agent_id);
    if (list) list.push(r);
    else byAgent.set(r.agent_id, [r]);
  }
  for (const list of byAgent.values()) {
    list.sort((a, b) => Date.parse(b.ended_at) - Date.parse(a.ended_at));
  }

  const failing: FailingCron[] = [];

  for (const e of entries) {
    if (e.agentId === null) continue;
    const history = byAgent.get(e.agentId) ?? [];
    // Пустая история — это молчание, и оно уже предмет liveness. Здесь судим
    // только то, что реально отчиталось.
    if (history.length < threshold) continue;

    const window = history.slice(0, threshold);
    if (!window.every((r) => r.status === 'failed')) continue;

    const success = history.find((r) => r.status === 'success') ?? null;
    failing.push({
      key: e.key,
      label: e.label,
      runs: window.length,
      lastSuccessAt: success?.ended_at ?? null,
      lastError: window[0].error ?? null,
    });
  }

  return failing;
}

/** Человекочитаемая строка для Telegram. */
export function formatFailingCrons(failing: FailingCron[]): string {
  return failing
    .map((c) => {
      const since = c.lastSuccessAt
        ? `последний успех ${new Date(c.lastSuccessAt).toLocaleDateString('ru-RU')}`
        : 'успешных прогонов в истории нет';
      const why = c.lastError ? ` — ${c.lastError}` : '';
      return `${c.label}: ${c.runs} прогона подряд с отказом (${since})${why}`;
    })
    .join('; ');
}
