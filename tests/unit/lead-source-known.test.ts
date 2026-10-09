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
 * производителей против потребителей — оценки и обеих подписей.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { computeQuickScore } from '@/lib/leads/scoring';

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

/** Ключи карты подписей, объявленной как `const NAME ... = { … };`. */
function labelKeys(file: string, name: string): Set<string> {
  const src = read(file);
  const start = src.indexOf(`const ${name}`);
  expect(start, `${file}: карта ${name} не найдена`).toBeGreaterThan(-1);
  const block = src.slice(start, src.indexOf('};', start));
  return new Set([...block.matchAll(/^\s*([a-z_]+):/gm)].map((m) => m[1]));
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
  const PRODUCERS = ['app/planner/_PlannerClient.tsx', 'app/hub/tourist/trips/[id]/_TripDetailClient.tsx'];
  const admin = labelKeys('app/hub/admin/leads/_LeadsClient.tsx', 'SOURCE_LABELS');
  const telegram = labelKeys('lib/notifications/telegram-channel.ts', 'LEAD_SOURCE_LABELS');

  for (const file of PRODUCERS) {
    it(`${file}: источник заявки получает бонус оценки за собранную поездку`, () => {
      const source = leadSource(file);
      const base = computeQuickScore('Иван Петров', '+79991234567', undefined, { source: 'unknown_source' });
      expect(computeQuickScore('Иван Петров', '+79991234567', undefined, { source }) - base, source).toBe(15);
    });

    it(`${file}: источник заявки подписан в админке и в Телеграме`, () => {
      const source = leadSource(file);
      expect(admin.has(source), `нет подписи ${source} в админке`).toBe(true);
      expect(telegram.has(source), `нет подписи ${source} в Телеграме`).toBe(true);
    });
  }
});
