/**
 * Пост тура в канал не расходится с карточкой и ничего не выдумывает.
 *
 * Решение владельца 05.08: Кузьмич публикует тур в канале про туризм, с
 * фотографиями. Два правила, оба выстраданы на этой же карточке:
 *
 *  · фото — только настоящие снимки оператора из `operator_tours.photos`.
 *    Рисованная обложка вместо реки продаёт вымысел: турист поедет на другую
 *    реку. Нет снимков — нет поста;
 *  · текст — только из полей базы. Я уже вписывал в программу «знаменитые
 *    пирожки» и «сбор в Паратунской зоне» — оба поймал владелец, и это стоило
 *    миграции 814. В канале цена выше: пост уходит подписчикам и не правится.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildTourPostText,
  absolutePhotoUrls,
  tourPostHash,
  CAPTION_LIMIT,
  MAX_PHOTOS,
  type TourPostRow,
} from '@/lib/notifications/tour-channel-post';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const MODULE = read('lib/notifications/tour-channel-post.ts');

const BASE = 'https://vedarai.ru';

const row: TourPostRow = {
  id: '27',
  title: 'Сплав по реке Быстрая',
  short_description: 'Однодневный сплав с ухой из лосося и купанием в источниках.',
  base_price: 13000,
  price_unit: 'per_person',
  duration_hours: 10,
  multi_day_count: 1,
  max_participants: 12,
  difficulty: 'moderate',
  activity_type: 'rafting',
  location: 'Река Быстрая',
  photos: ['/images/tours/bystraya-rafting/01-river-volcanoes.jpg'],
  operator_name: 'Камчатка Рафтинг',
};

describe('текст поста — только факты из базы', () => {
  const text = buildTourPostText(row, BASE);

  it('несёт цену, оператора и ссылку на карточку', () => {
    // toLocaleString('ru-RU') разделяет разряды неразрывным пробелом — это
    // правильная типографика, поэтому сравниваем по нормализованному тексту.
    expect(text.replace(/ /g, ' ')).toContain('13 000 ₽');
    expect(text).toContain('Камчатка Рафтинг');
    expect(text).toContain(`${BASE}/catalog/tours/27`);
  });

  it('пустые поля не превращаются в текст', () => {
    const bare = buildTourPostText(
      { ...row, short_description: null, location: null, max_participants: null, difficulty: null, base_price: null },
      BASE,
    );
    expect(bare).toContain('Сплав по реке Быстрая');
    expect(bare).not.toMatch(/null|undefined|NaN/);
    expect(bare).not.toContain('₽');
  });

  it('укладывается в лимит подписи Telegram', () => {
    const long = buildTourPostText({ ...row, short_description: 'о'.repeat(3000) }, BASE);
    expect(long.length).toBeLessThanOrEqual(CAPTION_LIMIT);
  });

  it('разметка в названии экранируется, а не ломает пост', () => {
    const risky = buildTourPostText({ ...row, title: 'Сплав <b>&' }, BASE);
    expect(risky).toContain('&lt;b&gt;&amp;');
  });

  it('одинаковый текст даёт одинаковый хэш — на нём держится дедуп', () => {
    expect(tourPostHash(buildTourPostText(row, BASE))).toBe(tourPostHash(buildTourPostText(row, BASE)));
  });
});

describe('фотографии — настоящие и абсолютные', () => {
  it('относительные пути превращаются в абсолютные URL', () => {
    expect(absolutePhotoUrls(['/images/a.jpg'], BASE)).toEqual([`${BASE}/images/a.jpg`]);
  });

  it('внешние ссылки не переписываются', () => {
    expect(absolutePhotoUrls(['https://cdn.example/a.jpg'], BASE)).toEqual(['https://cdn.example/a.jpg']);
  });

  it('в альбом уходит не больше десяти — предел Telegram', () => {
    const many = Array.from({ length: 25 }, (_, i) => `/p/${i}.jpg`);
    expect(absolutePhotoUrls(many, BASE)).toHaveLength(MAX_PHOTOS);
  });

  it('пустые значения отбрасываются', () => {
    expect(absolutePhotoUrls(['', '   ', null as unknown as string], BASE)).toEqual([]);
  });

  it('источник — снимки оператора, а не генерация обложки', () => {
    // resolveCoverImage рисует картинку моделью: для новости честно, для
    // продажи конкретного тура — обман.
    expect(MODULE).toMatch(/operator_tours/);
    expect(MODULE).not.toMatch(/resolveCoverImage|pollinations/i);
  });

  it('без фотографий пост не уходит', () => {
    expect(MODULE).toMatch(/У тура нет фотографий/);
  });
});

describe('пост не может разойтись с карточкой', () => {
  it('снаружи приходит только id тура', () => {
    const trigger = JSON.parse(read('.github/triggers/channel-post-tour.json')) as Record<string, unknown>;
    expect(trigger.tourId).toBeTruthy();
    expect(trigger.text, 'текст снаружи — это способ разойтись с карточкой').toBeUndefined();
    expect(trigger.photos).toBeUndefined();
  });

  it('снятый с витрины тур не публикуется', () => {
    expect(MODULE).toMatch(/deleted_at IS NULL/);
    expect(MODULE).toMatch(/is_active = true/);
  });
});
