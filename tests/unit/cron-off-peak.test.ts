// @vitest-environment node
/**
 * Сторож: плановые вызовы модели не попадают в пик DeepSeek.
 *
 * Уведомление DeepSeek 09.09 (в силе с 10.09) удвоило цену в окнах пика —
 * 1:00–4:00 и 6:00–10:00 UTC по будням (lib/ai/deepseek-peak.ts, единственное
 * место, где окна записаны). Замер 10.09 по расписаниям: в пике стояли
 * cron-intelligence (03, 09), cron-kuzmich-places (03:00 — двадцать рецензий
 * за прогон, самый объёмный плановый вызов), scout-digest (07:00), evo-judge
 * (06:20, до сотни вызовов) и eval-kuzmich (пн 06:37). Все уведены, и ни один
 * из них не был поставлен на этот час ради аудитории — час выбирался
 * «до рабочего дня владельца», то есть безразлично.
 *
 * В пике остаются только те, кому час диктует не цена: получасовые
 * safety-кроны и очереди (двигать нечего) и посты с временем аудитории
 * Камчатки (одна генерация за прогон — цена вопроса копейки, аудитория —
 * нет). Каждое исключение — поимённо и с причиной. Список может только
 * сокращаться: новый AI-крон в пике краснеет, пока не объяснён здесь.
 *
 * Расписание судится ТАК ЖЕ, как в lib/ai/deepseek-peak.ts (isPeakCronSlot),
 * а не своей копией окон: два правила разошлись бы, как разошлись четыре
 * записи «16:30–00:30».
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isPeakCronSlot } from '@/lib/ai/deepseek-peak';
import { CRON_CAPABILITIES } from '@/lib/agents/cron-capability-registry';

const WF_DIR = join(process.cwd(), '.github/workflows');
const files = readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f)).sort();
const read = (f: string) => readFileSync(join(WF_DIR, f), 'utf8');

/**
 * Workflow с раннера, которые зовут модель мимо /api/cron/: скрипт в шаге
 * run. Перечислены явно — по коду их не найти (модель зовётся через прод или
 * через ключ раннера), а молчание сторожа не ответ.
 */
const RUNNER_AI_WORKFLOWS: Record<string, string> = {
  'evo-judge.yml': 'судья эволюции: флагман через OpenRouter, DeepSeek последней ступенью',
  'eval-kuzmich.yml': 'safety-eval задаёт живому Кузьмичу вопросы через /api/ai/chat',
  'evo-review.yml': 'AI-ревью Growth Scan с раннера',
  'editor-runner.yml': 'Editor на раннере (Opus по умолчанию, DeepSeek в водопаде)',
};

/**
 * Кому разрешено стоять в пике, и почему. Список может только СОКРАЩАТЬСЯ.
 */
const PEAK_ALLOWED: Record<string, string> = {
  'cron-danger-analysis.yml': 'safety: оценка риска по зонам каждые 30 минут — час не выбирается',
  'cron-leads.yml': 'лиды каждые 30 минут: Watchdog тревожит о лиде старше 2 часов',
  'cron-rescue.yml': 'safety-tier, каждые 30 минут',
  'cron-kernel-worker.yml': 'очередь ядра каждые 30 минут',
  'cron-health.yml': 'ежечасная проба провайдеров — один короткий вызов',
  'cron-tg-watchdog.yml': 'проверка вебхука бота каждые 30 минут',
  'cron-watchdog.yml': 'Watchdog каждые 30 минут; заодно зовёт telegram-webhook-watchdog',
  'cron-tour-reminder.yml': '06:00 UTC = 18:00 Камчатки, напоминание туристу; объём — туры ближайших двух дней',
  'cron-kuzmich-tour.yml': '07:23 UTC = 19:23 Камчатки, один пост в канал: час — аудитории',
  'cron-kuzmich-route.yml': '09:00 UTC = 21:00 Камчатки, один пост в канал: час — аудитории',
};

interface Slot { minute: string; hour: string; dow: string; raw: string }

function scheduleSlots(src: string): Slot[] {
  const out: Slot[] = [];
  for (const m of src.matchAll(/^\s*-\s*cron:\s*['"]([^'"]+)['"]/gm)) {
    const [minute, hour, , , dow] = m[1].trim().split(/\s+/);
    out.push({ minute, hour, dow, raw: m[1] });
  }
  return out;
}

function stripComments(src: string): string {
  return src.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
}

/** Cron-эндпоинты, которые workflow зовёт сам или через свой скрипт. */
function cronEndpoints(src: string): string[] {
  const names = new Set<string>();
  const addFrom = (s: string) => {
    for (const line of stripComments(s).split('\n')) {
      for (const m of line.matchAll(/\/api\/cron\/([a-z0-9-]+)/g)) names.add(m[1]);
    }
  };
  addFrom(src);
  for (const m of src.matchAll(/scripts\/[A-Za-z0-9._/-]+/g)) {
    const p = join(process.cwd(), m[0]);
    if (existsSync(p) && statSync(p).isFile()) addFrom(readFileSync(p, 'utf8'));
  }
  return [...names];
}

const callsAi = (f: string) =>
  f in RUNNER_AI_WORKFLOWS ||
  cronEndpoints(read(f)).some((n) => (CRON_CAPABILITIES[n] ?? []).includes('ai'));

/** Часы запуска по полю hour; null — «каждый час / каждые N часов». */
function explicitHours(hour: string): number[] | null {
  if (hour === '*' || hour.includes('/')) return null;
  const hours: number[] = [];
  for (const part of hour.split(',')) {
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) {
      for (let h = Number(range[1]); h <= Number(range[2]); h++) hours.push(h);
    } else {
      hours.push(Number(part));
    }
  }
  return hours;
}

const weekendOnly = (dow: string) => /^[06](,[06])?$/.test(dow);

/** Есть ли у workflow слот в пике (будний день). */
function hasPeakSlot(f: string): boolean {
  return scheduleSlots(read(f)).some((s) => {
    if (weekendOnly(s.dow)) return false;
    const hours = explicitHours(s.hour);
    if (hours === null) return true; // каждый час — заходит и в пик
    const minute = s.minute === '*' || s.minute.includes('/') ? 0 : Number(s.minute.split(',')[0]);
    return hours.some((h) => isPeakCronSlot(h, minute));
  });
}

describe('плановые AI-кроны стоят вне пика DeepSeek', () => {
  const aiScheduled = files.filter((f) => scheduleSlots(read(f)).length > 0 && callsAi(f));

  it('AI-кронов с расписанием больше нуля — иначе сторож ничего не сторожит', () => {
    expect(aiScheduled.length).toBeGreaterThan(5);
  });

  it('каждый AI-крон в пике объяснён поимённо', () => {
    const offenders = aiScheduled.filter((f) => hasPeakSlot(f) && !(f in PEAK_ALLOWED));
    expect(
      offenders,
      `в пике DeepSeek без объяснения: ${offenders.join(', ')} — перенести или внести в PEAK_ALLOWED с причиной`,
    ).toEqual([]);
  });

  it('список исключений может только сокращаться: каждый в нём существует, зовёт модель и всё ещё в пике', () => {
    const stale = Object.keys(PEAK_ALLOWED).filter(
      (f) => !files.includes(f) || !callsAi(f) || !hasPeakSlot(f),
    );
    expect(stale, `строку пора удалить: ${stale.join(', ')}`).toEqual([]);
  });

  it('уведённые 10.09 стоят вне пика и не вернулись', () => {
    for (const f of [
      'cron-intelligence.yml',
      'cron-kuzmich-places.yml',
      'cron-scout-digest.yml',
      'evo-judge.yml',
      'eval-kuzmich.yml',
    ]) {
      expect(hasPeakSlot(f), `${f} снова в пике`).toBe(false);
    }
  });

  it('окна не повторяются цифрами в расписаниях — только ссылкой на lib/ai/deepseek-peak.ts', () => {
    for (const f of ['cron-intelligence.yml', 'cron-kuzmich-places.yml', 'cron-scout-digest.yml', 'evo-judge.yml', 'eval-kuzmich.yml']) {
      const src = read(f);
      expect(src, `${f}: нет ссылки на источник окон`).toMatch(/deepseek-peak\.ts/);
      expect(src, `${f}: окна переписаны цифрами`).not.toMatch(/1:00[–-]4:00|6:00[–-]10:00/);
    }
  });
});
