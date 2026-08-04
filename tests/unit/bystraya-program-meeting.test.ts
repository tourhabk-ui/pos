/**
 * Программа дня не должна противоречить точке сбора.
 *
 * Повод: шаг 1 назывался «Выезд из Петропавловска-Камчатского», а в тексте под
 * ним стояло «Сбор в Паратунской зоне отдыха». Это разные места, между ними
 * около 50 км — турист по такому шагу не понимает, куда приезжать.
 *
 * Источник правды — operator_tours.meeting_point со слов оператора (797):
 * выезд из Петропавловска, а забор из Паратунки ВОЗМОЖЕН по договорённости.
 * В миграции 809 я превратил возможность в место сбора. Для safety-платформы
 * это не стилистика: человек может уехать за 50 км не туда и опоздать.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const fix = readFileSync(join(ROOT, 'migrations/814_bystraya_program_meeting_fix.sql'), 'utf-8');
const source = readFileSync(join(ROOT, 'migrations/797_operator_tours_meeting_point.sql'), 'utf-8');

/** Шаги программы, которые ставит миграция. */
const steps: Array<{ title: string; text: string }> = (() => {
  const json = fix.match(/'(\[[\s\S]*?\])'::jsonb/)?.[1];
  return json ? JSON.parse(json) : [];
})();

describe('источник правды о месте сбора', () => {
  it('оператор говорит: выезд из Петропавловска, Паратунка — возможен забор', () => {
    expect(source).toMatch(/Выезд из Петропавловска-Камчатского/);
    expect(source).toMatch(/возможен забор из Паратунской/i);
  });
});

describe('программа не противоречит точке сбора', () => {
  it('шаги разобрались', () => {
    expect(steps.length).toBeGreaterThanOrEqual(7);
  });

  it('Паратунка больше не названа местом СБОРА', () => {
    const all = steps.map(s => `${s.title} ${s.text}`).join(' ');
    expect(all).not.toMatch(/Сбор в Паратунской/i);
  });

  it('Паратунка подана как возможность, а не как факт', () => {
    const step1 = `${steps[0]?.title ?? ''} ${steps[0]?.text ?? ''}`;
    expect(step1).toMatch(/Петропавловск/);
    expect(step1).toMatch(/возможен забор/i);
    // Итог подтверждает оператор — карточка не обещает за него.
    expect(step1).toMatch(/подтверждает при бронировании/i);
  });

  it('километры трассы не дублируются: у них свой блок «Точка сбора»', () => {
    const all = steps.map(s => `${s.title} ${s.text}`).join(' ');
    expect(all).not.toMatch(/147|139/);
  });

  it('выдуманных эпитетов нет («знаменитые пирожки» добавил не оператор)', () => {
    const all = steps.map(s => `${s.title} ${s.text}`).join(' ');
    expect(all).not.toMatch(/знаменит/i);
  });
});

describe('миграция 814 безопасна', () => {
  it('без INSERT — именно он уронил 806', () => {
    const sql = fix.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
    expect(sql).not.toMatch(/\bINSERT\s+INTO\b/i);
  });

  it('трогает ровно один тур', () => {
    expect(fix).toContain('WITH canonical AS');
    expect(fix).toMatch(/LIMIT 1/);
  });

  it('идемпотентна: срабатывает только пока противоречие в базе', () => {
    expect(fix).toMatch(/LIKE '%Сбор в Паратунской%'/);
  });
});
