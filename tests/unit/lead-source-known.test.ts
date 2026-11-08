/**
 * Сторож: заявка из планера и из «Моих поездок» доходит целиком и узнаётся.
 *
 * Разбор планера 09.10 нашёл два разрыва в одном месте:
 *
 *   — «Мои поездки» слали `sourceData`, а схема /api/leads ждёт `source_data`.
 *     Zod отбрасывает незнакомый ключ, и оператор получал один комментарий —
 *     без дат, рейсов и мест поездки;
 *   — оценка лида давала +15 источнику `trip_planner`, а планер слал
 *     `planner_page`, сохранённая поездка — `saved_trip`. Бонус за собранную
 *     поездку не срабатывал ни разу, подписи в админке и Телеграме не
 *     находились.
 *
 * Сторож держит связку: имя ключа у всех форм заявки и источник у двух
 * производителей против потребителей — оценки и подписи «откуда».
 *
 * С 08.11 подпись одна на админку, кабинет оператора и уведомление админу —
 * lib/leads/origin (слово владельца: «нужно писать, откуда лиды — человек или
 * ИИ»). Прежде здесь сверялись ключи двух словарей в исходниках; теперь —
 * ответ самого правила на источник производителя.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { computeQuickScore } from '@/lib/leads/scoring';
import { plannerLeadSource } from '@/lib/planner/trip-request-lines';
import { leadOrigin } from '@/lib/leads/origin';

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf-8');

/** Файлы, которые шлют заявку в /api/leads, — переписью по коду, а не по памяти. */
function leadForms(): string[] {
  const out = execFileSync('git', ['-c', 'color.ui=false', 'grep', '-l', "'/api/leads'", '--', 'app', 'components'], {
    encoding: 'utf-8',
  });
  return out.split('\n').filter(Boolean).filter((f) => !f.startsWith('app/api/'));
}

/** Источник заявки — первое `source: '…'` после `source_data: {`. */
function leadSource(file: string): string {
  const src = read(file);
  const at = src.indexOf('source_data: {');
  expect(at, `${file}: тело заявки без source_data`).toBeGreaterThan(-1);
  const m = /source:\s*'([a-z_]+)'/.exec(src.slice(at));
  expect(m, `${file}: в source_data нет source`).not.toBeNull();
  return m![1];
}

describe('формы заявки шлют source_data, а не sourceData', () => {
  it('перепись нашла формы', () => {
    expect(leadForms().length).toBeGreaterThanOrEqual(5);
  });

  it('ни одна форма не кладёт ключ, который схема отбросит', () => {
    const bad = leadForms().filter((f) => /\bsourceData\s*:/.test(read(f)));
    expect(bad, `sourceData вместо source_data: ${bad.join(', ')}`).toEqual([]);
  });
});

describe('собранная поездка узнаётся оценкой и подписями', () => {
  // Тело заявки планера собирает `plannerLeadSource` (07.11) — источник берётся
  // вызовом; что форма шлёт именно его, держит planner-request-form.test.tsx.
  const PRODUCERS: Array<[string, () => string]> = [
    ['lib/planner/trip-request-lines.ts (форма /planner)', () => String(plannerLeadSource({
      interests: [], arrival: '', departure: '', tripDays: null, transportByDay: {}, adults: 2, childAges: [],
      seasickness: false, riskMode: 'safe_only', plan: null,
    }).source)],
    ['app/hub/tourist/trips/[id]/_TripDetailClient.tsx', () => leadSource('app/hub/tourist/trips/[id]/_TripDetailClient.tsx')],
  ];
  for (const [file, sourceOf] of PRODUCERS) {
    it(`${file}: источник заявки получает бонус оценки за собранную поездку`, () => {
      const source = sourceOf();
      const base = computeQuickScore('Иван Петров', '+79991234567', undefined, { source: 'unknown_source' });
      expect(computeQuickScore('Иван Петров', '+79991234567', undefined, { source }) - base, source).toBe(15);
    });

    it(`${file}: источник заявки узнаётся подписью «откуда» — человек и путь словами`, () => {
      const source = sourceOf();
      const o = leadOrigin({ source_data: { source } });
      expect(o.actor, `${source}: кто отправил`).toBe('human');
      expect(o.label, `${source}: путь не узнан`).not.toMatch(/не распознано|не записано/);
      expect(o.label).not.toContain(source);
    });
  }
});
