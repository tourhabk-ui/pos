/**
 * Лента предупреждений на главной: подпись про силу ограничения, а не про
 * возраст новости, и суть вместо стены текста.
 *
 * Живой случай 28.07: владелец прислал скриншот главной — лента развёрнута на
 * два экрана, в ней два дорожных ограничения целиком, с объездами и сайтом
 * подрядчика, и подписи «18 дн назад» / «21 дн назад». Оба ограничения при этом
 * ДЕЙСТВУЮТ (в базе они прошли фильтр expires_at > NOW()): реконструкция на
 * Халактырском без объявленного срока, пропускной режим на Вилючинском.
 * Подпись говорила «протухло» про то, что прямо сейчас в силе.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { alertStamp, clip } from '@/app/_home/_HomeV8Client';

const SRC = readFileSync(join(process.cwd(), 'app/_home/_HomeV8Client.tsx'), 'utf-8');

describe('подпись строки ленты', () => {
  it('у дорожного ограничения — срок действия, а не возраст новости', () => {
    const stamp = alertStamp({
      type: 'road_closure',
      at: '2026-07-10T09:00:00Z',
      until: '2026-09-01T00:00:00Z',
    });
    expect(stamp).toContain('действует до');
    expect(stamp).not.toContain('назад');
  });

  it('без известного срока — просто «действует», без выдуманной даты', () => {
    const stamp = alertStamp({ type: 'road_closure', at: '2026-07-10T09:00:00Z', until: null });
    expect(stamp).toBe('действует');
  });

  it('у новостных типов возраст осмыслен и остаётся', () => {
    const stamp = alertStamp({ type: 'weather', at: new Date(Date.now() - 3 * 3600_000).toISOString(), until: null });
    expect(stamp).toContain('назад');
  });

  it('срок действия показывают и другие ограничения, не только дороги', () => {
    for (const type of ['flood', 'avalanche', 'landslide']) {
      expect(alertStamp({ type, at: '2026-07-10T09:00:00Z', until: '2026-08-15T00:00:00Z' })).toContain('действует');
    }
  });
});

describe('описание в ленте', () => {
  const LONG = 'Дорога к Халактырскому пляжу на участке со стороны посёлка Дальний полностью перекрыта — началась масштабная реконструкция (новое полотно, тротуары, освещение). Сроки завершения не объявлены. На закрытом участке ведётся фото- и видеофиксация, за проезд под запрет — административная ответственность.';

  it('длинное описание обрезается: лента — поверхность одного взгляда', () => {
    const short = clip(LONG);
    expect(short.length).toBeLessThanOrEqual(141);
    expect(short.endsWith('…')).toBe(true);
  });

  it('режет по границе слова, а не посреди', () => {
    const short = clip(LONG);
    expect(short.slice(0, -1).endsWith(' ')).toBe(false);
    expect(LONG.startsWith(short.slice(0, 20))).toBe(true);
  });

  it('короткое описание остаётся целым и без многоточия', () => {
    const short = 'Перевал закрыт до утра.';
    expect(clip(short)).toBe(short);
  });
});

describe('раскрывашка — цель, а не вся площадь', () => {
  it('в свёрнутом виде кнопка не растянута на всю ленту', () => {
    // inset:0 делал кнопкой весь блок: случайный тап при прокрутке разворачивал
    // ленту на пол-экрана. Кнопка должна быть там, где нарисован шеврон.
    expect(SRC).not.toContain('.ticker-toggle:not(.open){inset:0');
    expect(SRC).toContain('.v7 .ticker-toggle:not(.open){right:0;bottom:0}');
  });

  it('цель остаётся пальцевой — не меньше 44px', () => {
    expect(SRC).toContain('width:44px;height:44px');
  });
});
