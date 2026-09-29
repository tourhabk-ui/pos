/**
 * Закрытая точка видна на карте и в скачанном пакете (issue #2079, 29.09).
 *
 * Статус `is_open` у точки был, карточка точки его показывала, а карта — нет,
 * и пакет региона его не нёс. Сторож держит связку: пакет везёт поле, запись
 * в IndexedDB его хранит, карта в обоих режимах ставит «Закрыто» первым.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withClosure, CLOSED_LABEL } from '@/lib/safety/place-closure';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

describe('правило', () => {
  it('закрыто — первой строкой, перед прочими ограничениями', () => {
    expect(withClosure(['Дорога перекрыта'], false)).toEqual([CLOSED_LABEL, 'Дорога перекрыта']);
  });
  it('открыто и «не записано» список не меняют: незнание не выдаётся за закрытие', () => {
    expect(withClosure(['Пожар'], true)).toEqual(['Пожар']);
    expect(withClosure(['Пожар'], null)).toEqual(['Пожар']);
    expect(withClosure([], undefined)).toEqual([]);
  });
});

describe('связка: пакет → хранение → карта', () => {
  it('пакет региона везёт is_open', () => {
    const api = read('app/api/routes/by-region/route.ts');
    expect(api).toMatch(/lrs\.is_open\s+AS is_open/);
    expect(api).toMatch(/isOpen:\s+\(r\.is_open as boolean \| null\) \?\? null/);
  });
  it('запись пакета хранит поле, старый ответ даёт null, а не «открыто»', () => {
    expect(read('lib/offline/db.ts')).toMatch(/isOpen: boolean \| null;/);
    expect(read('lib/offline/useOfflineRegion.ts')).toMatch(/isOpen: r\.isOpen \?\? null/);
  });
  it('карта ставит «Закрыто» и в офлайне, и онлайн', () => {
    const map = read('app/map/_MapPageClient.tsx');
    expect(map).toMatch(/restrictions:\s+withClosure\(r\.activeAlerts \?\? \[\], r\.isOpen\)/);
    expect(map).toMatch(/restrictions:\s+withClosure\(\[\], r\.isOpen\)/);
  });
});
