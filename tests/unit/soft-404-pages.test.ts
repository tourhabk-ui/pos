/**
 * Карточки сущностей отвечают настоящим 404, а не «не найдено» с HTTP 200.
 *
 * Повод (#1776, прогулка туристом 10.09): несуществующее место отдавало 200 с
 * надписью внутри клиента. Для поисковика это живая страница с мусорным
 * заголовком, для внешнего монитора — «всё хорошо». Маршрут и тур уже звали
 * notFound(); место — нет, и сторожа не было ни у кого из трёх.
 *
 * Правило: серверная page.tsx карточки зовёт notFound(), рядом лежит свой
 * not-found.tsx с осмысленным текстом (общий 404 приложения не знает, что
 * именно не нашлось).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const CARDS = [
  'app/routes/[id]',
  'app/places/[id]',
  'app/catalog/tours/[id]',
  'app/marketplace/tours/[id]',
];

describe.each(CARDS)('%s', (dir) => {
  const page = readFileSync(join(ROOT, dir, 'page.tsx'), 'utf-8');

  it('page.tsx зовёт notFound() при отсутствии записи', () => {
    expect(page).toMatch(/import \{[^}]*\bnotFound\b[^}]*\} from 'next\/navigation'/);
    expect(page).toMatch(/notFound\(\)/);
  });

  it('свой not-found.tsx лежит рядом', () => {
    // Карточка тура живёт по двум адресам одной реализацией (§11): свой
    // not-found есть хотя бы у канона /catalog/tours, второй адрес наследует
    // ближайший not-found вверх по дереву.
    const own = existsSync(join(ROOT, dir, 'not-found.tsx'));
    const canon = dir === 'app/marketplace/tours/[id]' && existsSync(join(ROOT, 'app/catalog/tours/[id]/not-found.tsx'));
    expect(own || canon, `${dir}: нет not-found.tsx`).toBe(true);
  });
});

describe('places/[id]: отказ БД — не 404', () => {
  it('notFound только при найденном отсутствии, не при ошибке резолва', () => {
    const page = readFileSync(join(ROOT, 'app/places/[id]/page.tsx'), 'utf-8');
    // Три исхода (§4.0): found true / false / null (не смогли спросить).
    expect(page).toMatch(/let found: boolean \| null = null/);
    expect(page).toMatch(/if \(found === false\) notFound\(\)/);
    expect(page).toMatch(/console\.error\('\[places\/page\]/);
  });
});
