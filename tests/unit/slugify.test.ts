/**
 * ЧПУ-слаги (RU→latin) для /routes/[id] и /places/[id]. Логика зеркалится в
 * plpgsql-функции миграции 779 — тест фиксирует ожидаемую транслитерацию, длину
 * и распознавание UUID (роутинг отличает slug от uuid).
 */
import { describe, it, expect } from 'vitest';
import { slugify, isUuid, SLUG_MAX_LEN } from '@/lib/text/slugify';

describe('slugify', () => {
  it('транслитерирует кириллицу и разделяет дефисами', () => {
    expect(slugify('Вулкан Горелый')).toBe('vulkan-gorelyj');
    expect(slugify('Долина гейзеров')).toBe('dolina-gejzerov');
    expect(slugify('Халактырский пляж')).toBe('halaktyrskij-plyazh');
  });

  it('многобуквенные звуки', () => {
    expect(slugify('Щ ж ц ч ш ю я ё')).toBe('shch-zh-ts-ch-sh-yu-ya-yo');
  });

  it('немые знаки ъ/ь выпадают', () => {
    expect(slugify('Подъезд объездная')).toBe('podezd-obezdnaya');
  });

  it('латиница и цифры сохраняются, регистр вниз', () => {
    expect(slugify('Camp 2 Base')).toBe('camp-2-base');
  });

  it('схлопывает мусорные символы и обрезает дефисы по краям', () => {
    expect(slugify('  «Тёплое» озеро!!!  ')).toBe('tyoploe-ozero');
    expect(slugify('---a---b---')).toBe('a-b');
  });

  it('пустой результат из не-буквенных символов', () => {
    expect(slugify('!!! ??? …')).toBe('');
  });

  it('ограничивает длину по границе слова', () => {
    const long = 'очень '.repeat(40);
    const s = slugify(long);
    expect(s.length).toBeLessThanOrEqual(SLUG_MAX_LEN);
    expect(s.endsWith('-')).toBe(false);
  });

  it('детерминирован', () => {
    expect(slugify('Мутновский')).toBe(slugify('Мутновский'));
  });
});

describe('isUuid', () => {
  it('распознаёт UUID', () => {
    expect(isUuid('bbb42f24-b8db-41f5-805a-99c42cafb4c7')).toBe(true);
    expect(isUuid('BBB42F24-B8DB-41F5-805A-99C42CAFB4C7')).toBe(true);
  });
  it('slug — не UUID', () => {
    expect(isUuid('vulkan-gorelyj')).toBe(false);
    expect(isUuid('dolina-gejzerov-2')).toBe(false);
    expect(isUuid('')).toBe(false);
  });
});
