/**
 * Время толчка у EQKam — очаг из текста бюллетеня, а не время поста (01.10).
 *
 * Бюллетень выходит минут через шесть после толчка: 30.09 очаг 18:36:18 UTC,
 * пост 18:42. Записывалось время поста, а сверка «тот же толчок уже пришёл от
 * USGS или emsd.ru» (findSameQuake) ищет запись в окне ±30 с по времени
 * очага. Шесть минут в окно не влезают — и один толчок вставал в ленту
 * дважды: M5.5 и M5.0, оба «5 ч назад» (снимок владельца 01.10).
 */
import { describe, it, expect } from 'vitest';
import {
  classifyEqkam,
  eqkamEventTime,
  parseEqkamOriginTime,
  SAME_QUAKE_SECONDS,
} from '@/lib/services/safety/seismic-parser';

/** Бюллетень 30.09 дословно — как его видит разбор после снятия разметки. */
const POST = [
  'Время UTC: 30 SEP 2026  18:36:18',
  'Координаты: 52.2028, 160.6734',
  'Расстояние от ПК: 169',
  'Глубина (КМ): 15.8',
  'Магнитуда (Ml): 5.0',
  'Ощутили землетрясение? Сообщите о нем здесь!',
].join('\n');

/** Время поста в канале — `<time datetime>` превью t.me. */
const POSTED = '2026-09-30T18:42:10+00:00';

describe('время очага из бюллетеня', () => {
  it('строка «Время UTC» разбирается дословно, с двойным пробелом', () => {
    expect(parseEqkamOriginTime(POST)?.toISOString()).toBe('2026-09-30T18:36:18.000Z');
  });

  it('месяц любым регистром', () => {
    expect(parseEqkamOriginTime('Время UTC: 1 oct 2026 00:05:09')?.toISOString())
      .toBe('2026-10-01T00:05:09.000Z');
  });

  it('несуществующая дата не «поправляется» в соседнюю', () => {
    expect(parseEqkamOriginTime('Время UTC: 31 SEP 2026  18:36:18')).toBeNull();
    expect(parseEqkamOriginTime('Время UTC: 30 SEP 2026  24:36:18')).toBeNull();
    expect(parseEqkamOriginTime('Время UTC: 30 XYZ 2026  18:36:18')).toBeNull();
  });

  it('строки нет — времени нет, а не выдуманное', () => {
    expect(parseEqkamOriginTime('Магнитуда (Ml): 5.0')).toBeNull();
  });
});

describe('какое время пишется', () => {
  it('очаг, если он рядом с постом', () => {
    expect(eqkamEventTime(POST, POSTED).toISOString()).toBe('2026-09-30T18:36:18.000Z');
  });

  it('нет строки очага — время поста', () => {
    expect(eqkamEventTime('Магнитуда (Ml): 4.1', POSTED).toISOString()).toBe('2026-09-30T18:42:10.000Z');
  });

  it('очаг позже поста больше чем на четверть часа — не очаг этого поста', () => {
    const late = POST.replace('18:36:18', '19:10:00');
    expect(eqkamEventTime(late, POSTED).toISOString()).toBe('2026-09-30T18:42:10.000Z');
  });

  it('очаг за неделю до поста — не тот пост, берётся время поста', () => {
    const old = POST.replace('30 SEP 2026', '20 SEP 2026');
    expect(eqkamEventTime(old, POSTED).toISOString()).toBe('2026-09-30T18:42:10.000Z');
  });

  it('время поста нечитаемо — очаг', () => {
    expect(eqkamEventTime(POST, 'не дата').toISOString()).toBe('2026-09-30T18:36:18.000Z');
  });
});

describe('событие EQKam встаёт в окно сверки с USGS и emsd.ru', () => {
  const event = classifyEqkam('t.me/eqkam/9001', POST, POSTED);

  it('разбирается: M5.0, координаты, 169 км', () => {
    expect(event).not.toBeNull();
    expect(event?.magnitude).toBe(5);
    expect(event?.lat).toBeCloseTo(52.2028, 4);
    expect(event?.lng).toBeCloseTo(160.6734, 4);
    expect(event?.epicenter).toBe('169 км от Петропавловска-Камчатского');
  });

  it('время записи — очаг, и оно в окне сверки с агентством, давшим очаг', () => {
    // USGS и emsd.ru пишут время очага; расхождение агентств — секунды.
    const agencyOrigin = Date.parse('2026-09-30T18:36:21Z');
    const at = event?.published_at.getTime() ?? NaN;
    expect(Math.abs(at - agencyOrigin)).toBeLessThanOrEqual(SAME_QUAKE_SECONDS * 1000);
  });

  it('с временем поста тот же толчок в окно НЕ попадал — ради этого и правка', () => {
    const agencyOrigin = Date.parse('2026-09-30T18:36:21Z');
    expect(Math.abs(Date.parse(POSTED) - agencyOrigin)).toBeGreaterThan(SAME_QUAKE_SECONDS * 1000);
  });
});
