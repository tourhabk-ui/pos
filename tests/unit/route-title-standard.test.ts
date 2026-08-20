/**
 * Стандарт имени маршрута — «один формат, без поэзии» (владелец 20.08).
 *
 * Сторож держит обе стороны черты: настоящие имена из базы, которые
 * стандарт обязан пропускать (включая точки-сокращения «о. Беринга»),
 * и настоящих нарушителей, которых он обязан ловить.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { judgeRouteTitle } from '@/lib/routes/title-standard';

describe('канонические имена проходят', () => {
  it.each([
    'Вулкан Горелый',
    'Пиначево — Центральный',
    'Водопад Спокойный (Снежный Барс)',
    'Сплав по реке Быстрая',
    'Восхождение на Авачинский вулкан',
    'Горный массив Вачкажец (лыжный)',
    'Озеро Толмачёва',
    'Бухта Буян, о. Беринга',
    'Видовая площадка п. Ключи',
    'SUP-маршрут Полуостров Завойко',
  ])('%s', (title) => {
    expect(judgeRouteTitle(title)).toEqual({ ok: true, violations: [] });
  });
});

describe('поэзия ловится — примеры из живой базы', () => {
  it('предложения через точку и эпитет', () => {
    const v = judgeRouteTitle('Камчатка глазами детей. 100 километров до Мутновской ГеоТЭС');
    expect(v.ok).toBe(false);
    expect(v.violations.join(' ')).toContain('предложения через точку');
    expect(v.violations.join(' ')).toContain('глазами');
  });

  it('кавычки-лозунг и эпитет', () => {
    const v = judgeRouteTitle('«Скалы Океаны» - приключения на Камчатке');
    expect(v.ok).toBe(false);
    expect(v.violations.join(' ')).toContain('кавычки');
    expect(v.violations.join(' ')).toContain('приключения');
  });

  it('маркетинговый эпитет без объекта', () => {
    expect(judgeRouteTitle('Идеальный выходной').ok).toBe(false);
  });

  it('капс', () => {
    expect(judgeRouteTitle('КАМЧАТКА').ok).toBe(false);
    expect(judgeRouteTitle('ТРОПА МЕДВЕДЯ (ДОЛИНА СМЕРТИ)').ok).toBe(false);
  });

  it('восклицание', () => {
    expect(judgeRouteTitle('Голубые озёра на Камчатке!').ok).toBe(false);
  });

  it('длиннее семи слов', () => {
    expect(judgeRouteTitle('Авачинский перевал и экструзия Верблюд и евражки и безопасность').ok).toBe(false);
  });

  it('точка-сокращение нарушением не считается', () => {
    expect(judgeRouteTitle('Бухта Гладковская, о. Беринга').ok).toBe(true);
  });
});

describe('перепись остаётся переписью', () => {
  const src = readFileSync(join(process.cwd(), 'app/api/cron/route-title-census/route.ts'), 'utf-8');

  it('только чтение: ни INSERT, ни UPDATE, ни DELETE', () => {
    expect(src).not.toMatch(/INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM/i);
  });

  it('судит только живое и не слитое', () => {
    expect(src).toContain('r.is_visible = true AND r.merged_into_id IS NULL');
  });
});
