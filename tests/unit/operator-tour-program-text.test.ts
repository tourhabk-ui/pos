import { describe, it, expect } from 'vitest';
import { programFromText, programToText } from '@/lib/tours/program-text';
import { UpdateTourSchema } from '@/lib/api/operator-tours';

describe('программа по дням в форме оператора', () => {
  it('текст → шаги тем же разбором, что у гида', () => {
    const r = programFromText('1. День 1: Выезд в 8:00\nподъём к перевалу\n2. День 2: Восхождение');
    expect(r).toEqual({ ok: true, value: [
      { title: 'День 1', text: 'Выезд в 8:00\nподъём к перевалу' },
      { title: 'День 2', text: 'Восхождение' },
    ] });
  });

  it('пустое поле — программы нет (null)', () => {
    expect(programFromText('  \n ')).toEqual({ ok: true, value: null });
  });

  it('шаги → текст → те же шаги', () => {
    const steps = [{ title: 'День 1', text: 'Выезд' }, { title: 'День 2', text: 'Озёрки, купание' }];
    const back = programFromText(programToText(steps));
    expect(back).toEqual({ ok: true, value: steps });
  });

  it('не список из базы — пустое поле', () => {
    expect(programToText(null)).toBe('');
    expect(programToText('x')).toBe('');
  });

  it('больше 20 шагов — понятная ошибка, не запись', () => {
    const t = Array.from({ length: 21 }, (_, i) => `${i + 1}. Шаг ${i + 1}: текст`).join('\n');
    const r = programFromText(t);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('20');
  });

  it('PATCH-схема пропускает программу, а не выбрасывает её молча', () => {
    const p = UpdateTourSchema.parse({ program: [{ title: 'День 1', text: 'Выезд' }] });
    expect(p.program).toEqual([{ title: 'День 1', text: 'Выезд' }]);
    expect(UpdateTourSchema.parse({ program: null }).program).toBeNull();
    expect(() => UpdateTourSchema.parse({ program: [{ title: '', text: 'x' }] })).toThrow();
  });
});
