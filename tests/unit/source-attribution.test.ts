import { describe, it, expect } from 'vitest';
import { stripSourceAttribution, hasSourceAttribution, publicSourceUrl, EXTERNAL_SOURCE_NAME } from '@/lib/text/source-attribution';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

describe('publicSourceUrl — адрес конкурента не уходит в ответ страницы', () => {
  it('прячет idilesom.com и подпись «сторонний источник»', () => {
    expect(publicSourceUrl('https://idilesom.com/kam/places/2772', EXTERNAL_SOURCE_NAME)).toBeNull();
    expect(publicSourceUrl('https://www.idilesom.com/kam/places/1460')).toBeNull();
    expect(publicSourceUrl('https://idilesom.com/kam/places/2748', null)).toBeNull();
    expect(publicSourceUrl('https://example.com/page', EXTERNAL_SOURCE_NAME)).toBeNull();
  });

  it('оставляет прочие адреса и пустые значения', () => {
    expect(publicSourceUrl('https://vulcanikamchatki.ru/page', 'Вулканы Камчатки')).toBe(
      'https://vulcanikamchatki.ru/page',
    );
    expect(publicSourceUrl(null)).toBeNull();
    expect(publicSourceUrl('')).toBeNull();
  });

  it('карточка маршрута, каталог, похожие и публичные API отдают sourceUrl через фильтр', () => {
    const files = [
      'lib/routes/route-detail.ts',
      'lib/routes/catalog-query.ts',
      'app/routes/[id]/page.tsx',
      'app/api/kamchatka-routes/route.ts',
      'app/api/routes/nearby/route.ts',
      'app/api/routes/by-region/route.ts',
      'lib/places/place-detail.ts',
    ];
    for (const f of files) {
      const src = readFileSync(join(process.cwd(), f), 'utf-8');
      expect(src, f).toMatch(/publicSourceUrl\(/);
      // сырой source_url больше не кладётся в поле ответа как есть
      expect(src, f).not.toMatch(/sourceUrl:\s*\(r\.source_url as string \| null\) \?\? null/);
    }
  });
});
