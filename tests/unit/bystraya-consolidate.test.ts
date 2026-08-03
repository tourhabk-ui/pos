/**
 * Сторож миграции 806: тур «Сплав по реке Быстрая» сводится к ОДНОЙ честной
 * карточке. Ловит регресс, из-за которого карточка на проде осталась голой:
 * 795/796 обогащали тур строго по длинному названию ('Однодневная экскурсия…'),
 * а видимый туристу тур (короткое имя, привязан к демо-оператору «Рога и Копыта»)
 * под матч не попадал. 806 обязана матчить КАНОНИЧЕСКИЙ тур ПО СОДЕРЖАНИЮ,
 * чинить оператора, галерею и состав, и гасить дубли без броней.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(
  join(process.cwd(), 'migrations/806_bystraya_tour_consolidate.sql'),
  'utf-8',
);

describe('миграция 806 — консолидация тура сплава', () => {
  it('матчит тур по СОДЕРЖАНИЮ (Быстрая + сплав/rafting), не только по длинному имени', () => {
    expect(src).toMatch(/title ILIKE '%быстр%'/i);
    expect(src).toMatch(/ILIKE '%сплав%'|activity_type IN \('rafting'/i);
    // не должна опираться ИСКЛЮЧИТЕЛЬНО на длинное имя из 800
    const onlyLongTitle =
      src.includes("'Однодневная экскурсия СПЛАВ ПО РЕКЕ БЫСТРАЯ'") &&
      !src.includes("ILIKE '%быстр%'");
    expect(onlyLongTitle).toBe(false);
  });

  it('привязывает канонический тур к реальному оператору kamchatka-rafting', () => {
    expect(src).toContain("slug = 'kamchatka-rafting'");
    expect(src).toMatch(/operator_id\s*=\s*op\.id/);
    // демо-заглушку НЕ записываем как значение (в комментарии-объяснении — можно)
    expect(src).not.toContain("'Рога и Копыта'");
    expect(src).not.toMatch(/name\s*=\s*'Рога/);
    // но настоящие контакты оператора присутствуют (Катерина/Ярослав из 060)
    expect(src).toContain('Катерина');
    expect(src).toContain('Ярослав');
  });

  it('ставит галерею реальных фото и состав тура', () => {
    expect(src).toContain('/images/tours/bystraya-rafting/01-river-volcanoes.jpg');
    expect(src).toContain('/images/tours/bystraya-rafting/02-rafting.jpg');
    expect(src).toMatch(/photos\s*=\s*ARRAY\[/);
    expect(src).toMatch(/included\s*=\s*ARRAY\[/);
    expect(src).toContain('activity_type = ');
    expect(src).toContain("'rafting'");
  });

  it('нормализует имя к «Сплав по реке Быстрая»', () => {
    expect(src).toContain("title        = 'Сплав по реке Быстрая'");
  });

  it('гасит дубли только без броней (мягкое удаление)', () => {
    expect(src).toContain('operator_bookings');
    expect(src).toMatch(/NOT EXISTS/);
    expect(src).toMatch(/deleted_at\s*=\s*NOW\(\)/);
  });

  it('не вставляет gen_random_uuid в id (та самая ловушка BIGSERIAL)', () => {
    expect(src).not.toMatch(/id[^,]*gen_random_uuid/i);
  });
});
