/**
 * lib/agents/cron-idle.ts
 *
 * Холостой крон: запускается, отчитывается успехом и не делает работы.
 *
 * `cron-liveness` отвечает на вопрос «крон запускался». Этого мало. Весь июль
 * поломки платформы жили именно в щели между «запускался» и «сделал»: KVERT
 * отдавал ноль вулканов в день, когда Шивелуч дважды выбросил пепел на 8 и 12
 * км, и прогон был зелёным; прочёс эволюции считал репозиторий из десяти файлов;
 * шесть фидов разведки молчали при `sources_ok: 6`. Ни одну из этих поломок не
 * нашла платформа — все нашёл владелец, глазами.
 *
 * Здесь — детерминированный ответ на второй вопрос. Судим только там, где ноль
 * объявлен ненормальным (`CRON_IDLE_MEANING`), и только по серии подряд: один
 * пустой прогон бывает у всех, три подряд — это оборванный канал.
 *
 * Чистые функции: тестируются без БД и без сети.
 */
import { idleMeaning, type CronEntry } from './cron-registry';

/** Строка истории прогонов: сколько работы сделал один запуск. */
export interface CronRunRow {
  agent_id: string;
  /** items_processed прогона; null — крон счётчик не пишет. */
  items: number | null;
  ended_at: string;
}

export type IdleReason = 'idle' | 'no_metric';

export interface IdleCron {
  key: string;
  label: string;
  reason: IdleReason;
  /** Сколько подряд идущих прогонов оказались холостыми. */
  runs: number;
  /** Когда крон в последний раз что-то сделал (ISO) или null. */
  lastProductiveAt: string | null;
}

/**
 * Сколько холостых прогонов подряд считать обрывом. Один ноль — обычное дело
 * даже у живого источника; три подряд у канала, который публикует постоянно,
 * объяснить нечем.
 */
export const IDLE_RUNS_THRESHOLD = 3;

/**
 * Находит кроны, которые отчитались успехом, не сделав работы (чистая).
 *
 * @param entries  записи реестра (обычно CRON_REGISTRY)
 * @param runs     история успешных прогонов, свежие первыми внутри каждого агента
 */
export function findIdleCrons(
  entries: readonly CronEntry[],
  runs: readonly CronRunRow[],
  threshold = IDLE_RUNS_THRESHOLD,
): IdleCron[] {
  const byAgent = new Map<string, CronRunRow[]>();
  for (const r of runs) {
    const list = byAgent.get(r.agent_id);
    if (list) list.push(r);
    else byAgent.set(r.agent_id, [r]);
  }
  for (const list of byAgent.values()) {
    list.sort((a, b) => Date.parse(b.ended_at) - Date.parse(a.ended_at));
  }

  const idle: IdleCron[] = [];

  for (const e of entries) {
    if (idleMeaning(e.key) !== 'broken') continue;
    // Без телеметрии судить не по чему — это не молчание, а отсутствие слуха.
    if (e.agentId === null) continue;

    const history = byAgent.get(e.agentId) ?? [];
    // Меньше порога прогонов — ещё рано судить: свежий крон или свежая
    // инструментовка выглядели бы мёртвыми на пустой истории.
    if (history.length < threshold) continue;

    const window = history.slice(0, threshold);

    // Объявлен обязанным работать, но счётчик не пишет: тревога не о нуле, а о
    // том, что проверить нечем — и это отдельный дефект, не «всё хорошо».
    if (window.every((r) => r.items === null)) {
      idle.push({ key: e.key, label: e.label, reason: 'no_metric', runs: window.length, lastProductiveAt: null });
      continue;
    }

    if (!window.every((r) => r.items === 0)) continue;

    const productive = history.find((r) => (r.items ?? 0) > 0) ?? null;
    idle.push({
      key: e.key,
      label: e.label,
      reason: 'idle',
      runs: window.length,
      lastProductiveAt: productive?.ended_at ?? null,
    });
  }

  return idle;
}

/** Человекочитаемая строка для Telegram. */
export function formatIdleCrons(idle: IdleCron[]): string {
  return idle
    .map((c) => {
      if (c.reason === 'no_metric') {
        return `${c.label}: ${c.runs} прогона подряд без счётчика работы — проверить нечем`;
      }
      const since = c.lastProductiveAt
        ? `последний результат ${new Date(c.lastProductiveAt).toLocaleDateString('ru-RU')}`
        : 'результата не было ни разу';
      return `${c.label}: ${c.runs} прогона подряд вхолостую (${since})`;
    })
    .join('; ');
}
