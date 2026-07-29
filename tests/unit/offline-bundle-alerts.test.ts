/**
 * Офлайн-пакет несёт обстановку, а не только карту.
 *
 * До этой правки `GET /api/routes/[id]/offline-bundle` отдавал маршрут,
 * точки, bbox и до двух тысяч тайлов — и ни слова о том, что происходит на
 * маршруте. Турист скачивал пакет перед выходом и уносил в поле всё, кроме
 * знания о пожаре, закрытой дороге или пеплопаде. Ровно там, где связи нет,
 * этого знания и не было.
 *
 * Второе: у офлайн-данных должна быть дата сборки. Без неё пакет трёхдневной
 * давности выглядит как сегодняшний, и пустой список предупреждений читается
 * как «всё спокойно» вместо «данные устарели».
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(
  join(process.cwd(), 'app/api/routes/[id]/offline-bundle/route.ts'),
  'utf-8',
);
const CODE = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

describe('офлайн-пакет маршрута', () => {
  it('спрашивает действующие предупреждения', () => {
    expect(CODE).toMatch(/FROM external_alerts|JOIN external_alerts/);
    expect(CODE, 'просроченные предупреждения в пакет не идут').toMatch(/expires_at > NOW\(\)/);
  });

  it('отдаёт их в ответе полем alerts', () => {
    expect(CODE).toMatch(/alerts:\s*alertRes\.rows\.map/);
  });

  it('в каждом предупреждении есть тип, серьёзность и срок', () => {
    const block = /alerts:\s*alertRes\.rows\.map\([\s\S]{0,400}?\)\)/.exec(CODE)?.[0] ?? '';
    expect(block, 'не разобрать блок alerts').not.toBe('');
    for (const field of ['type', 'severity', 'title', 'until']) {
      expect(block, `нет поля ${field}`).toMatch(new RegExp(`${field}:`));
    }
  });

  it('помечен временем сборки — офлайн-данные стареют молча', () => {
    expect(CODE).toMatch(/built_at:/);
  });

  it('маршрут по-прежнему читается с фильтром видимости', () => {
    // Скрытые маршруты не должны утекать даже через офлайн-пакет.
    expect(CODE).toMatch(/is_visible = TRUE OR is_visible IS NULL/);
  });
});

describe('структурированные данные точки не врут картинкой', () => {
  const PAGE = readFileSync(join(process.cwd(), 'app/places/[id]/page.tsx'), 'utf-8');
  const CODE_PAGE = PAGE.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  it('в OpenGraph идут только настоящие снимки', () => {
    // Раньше подзапрос брал любую строку ai_route_images, включая
    // сгенерированные моделью: ссылка на вулкан раскрывалась рисунком вулкана.
    expect(CODE_PAGE).not.toMatch(/EXISTS\(SELECT 1 FROM ai_route_images ai WHERE ai\.route_id = p\.ark_id\)/);
    expect(CODE_PAGE).toMatch(/ai\.model IN \('wikimedia', 'manual-upload'\)/);
  });

  it('нет снимка — нет поля image, а не ссылка в никуда', () => {
    // Прежний безусловный фолбэк публиковал URL, отдающий 404, и вдобавок
    // относительный — в JSON-LD нужен абсолютный.
    expect(CODE_PAGE).not.toMatch(/:\s*`\/api\/images\/route\/\$\{r\.ark_id\}`/);
    expect(CODE_PAGE).toMatch(/fullImgUrl[\s\S]{0,120}has_real_photo/);
  });
});
