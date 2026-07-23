import { describe, it, expect } from 'vitest';
import { stripSourceAttribution, hasSourceAttribution } from '@/lib/text/source-attribution';

describe('source-attribution: hasSourceAttribution', () => {
  it('ловит все формы имени источника', () => {
    expect(hasSourceAttribution('подробности на ИдиЛесом')).toBe(true);
    expect(hasSourceAttribution('Иди Лесом')).toBe(true);
    expect(hasSourceAttribution('см. идилесом')).toBe(true);
    expect(hasSourceAttribution('ИДИЛЕСОМ')).toBe(true);
  });

  it('не ложно-срабатывает на чистый текст', () => {
    expect(hasSourceAttribution('Вулкан Авачинский, высота 2741 м')).toBe(false);
    expect(hasSourceAttribution('')).toBe(false);
    expect(hasSourceAttribution(null)).toBe(false);
    expect(hasSourceAttribution(undefined)).toBe(false);
  });
});

describe('source-attribution: stripSourceAttribution', () => {
  it('кейс владельца — Бухта Асача: убирает рекламный хвост, сохраняет факт', () => {
    const raw = 'Это Бухта Асача в Камчатском крае. Место, которое стоит посмотреть. Маршрут и все подробности на ИдиЛесом';
    const out = stripSourceAttribution(raw);
    expect(out).not.toMatch(/иди\s*лесом/i);
    expect(out).toContain('Бухта Асача');
    expect(out).toContain('стоит посмотреть');
    // Нет висящих пробелов/двойных точек
    expect(out).not.toMatch(/\s{2,}/);
    expect(out).not.toMatch(/\.\s*\./);
    expect(out.endsWith('.')).toBe(true);
  });

  it('вариант с точкой в конце', () => {
    const out = stripSourceAttribution('Красивое озеро. Маршрут и все подробности на ИдиЛесом.');
    expect(out).toBe('Красивое озеро.');
  });

  it('суффикс заголовка « — ИдиЛесом» снимается, имя сохраняется', () => {
    expect(stripSourceAttribution('Бухта Асача — ИдиЛесом')).toBe('Бухта Асача');
    expect(stripSourceAttribution('Гора Замок | ИдиЛесом')).toBe('Гора Замок');
    expect(stripSourceAttribution('Долина гейзеров · Иди Лесом')).toBe('Долина гейзеров');
  });

  it('голый хвост «на ИдиЛесом» убирается', () => {
    expect(stripSourceAttribution('Смотрите фото на ИдиЛесом')).toBe('Смотрите фото');
  });

  it('чистый текст не меняется (идемпотентность на «хорошем»)', () => {
    const clean = 'Авачинский вулкан — действующий вулкан высотой 2741 м рядом с Петропавловском.';
    expect(stripSourceAttribution(clean)).toBe(clean);
  });

  it('идемпотентна — повторный прогон ничего не меняет', () => {
    const raw = 'Это Бухта Асача. Маршрут и все подробности на ИдиЛесом';
    const once = stripSourceAttribution(raw);
    const twice = stripSourceAttribution(once);
    expect(twice).toBe(once);
    expect(hasSourceAttribution(once)).toBe(false);
  });

  it('пустые/nullable входы → пустая строка', () => {
    expect(stripSourceAttribution('')).toBe('');
    expect(stripSourceAttribution(null)).toBe('');
    expect(stripSourceAttribution(undefined)).toBe('');
  });
});
