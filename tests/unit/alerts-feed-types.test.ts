/**
 * Сторож: список типов ленты безопасности — один на всех (07.09).
 *
 * ── Зачем ──────────────────────────────────────────────────────────────────
 *
 * Владелец прислал снимок главной с отчётом службы о собственной работе в
 * блоке предупреждений. Разбирать такой вопрос можно только переписью: что
 * именно висит в ленте и что о каждой строке думает страж жанров.
 *
 * Но перепись, набравшая список типов СВОИМ перечнем, ответила бы про другую
 * ленту — и звучала бы при этом уверенно. Это ровно тот дефект, что в этом
 * репозитории уже стоил дороже всего: два независимых источника одной истины
 * (карточка тура в двух копиях, SOS-кнопка в двух копиях, список глаголов
 * жанра в TS и в SQL миграции 846).
 *
 * Поэтому список живёт в lib/services/safety/feed-types и цитируется, а не
 * переписывается.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { FEED_ALERT_TYPES, isFeedAlertType } from '@/lib/services/safety/feed-types';

const HOME = readFileSync(join(process.cwd(), 'app/_home/data.ts'), 'utf8');
const CENSUS = readFileSync(join(process.cwd(), 'app/api/cron/alerts-census/route.ts'), 'utf8');

describe('список типов ленты не размножается', () => {
  it('лента главной берёт типы из общего модуля, а не из строки запроса', () => {
    expect(HOME).toContain("from '@/lib/services/safety/feed-types'");
    expect(HOME).toContain('alert_type = ANY($1::text[])');
    // Прежний перечень внутри SQL — то, что разошлось бы с переписью.
    expect(HOME).not.toContain("'road_closure', 'volcano', 'volcanic_eruption'");
  });

  it('перепись судит тем же списком', () => {
    expect(CENSUS).toContain("from '@/lib/services/safety/feed-types'");
    expect(CENSUS).toContain('isFeedAlertType');
  });

  it('землетрясения и общие сводки в ленту не входят', () => {
    // Сейсмика идёт отдельным блоком «Пульс полуострова», `info` и
    // `fire_danger` — новостные, не решающие ничего сегодня.
    for (const t of ['quake', 'earthquake', 'info', 'fire_danger']) {
      expect(isFeedAlertType(t), t).toBe(false);
    }
  });

  it('решающие типы в ленте есть', () => {
    for (const t of ['road_closure', 'volcano', 'tsunami_warning', 'weather']) {
      expect(isFeedAlertType(t), t).toBe(true);
    }
    expect(isFeedAlertType(null)).toBe(false);
    expect(FEED_ALERT_TYPES.length).toBeGreaterThan(0);
  });
});

describe('перепись отдаёт текст, а не только счётчики', () => {
  it('по каждой живой тревоге виден приговор того же стража, что чистит базу', () => {
    // Счётчик `service_statistics: 0` и жанровая строка на экране —
    // противоречие, которое разрешает только текст строки рядом с вердиктом.
    expect(CENSUS).toContain('rejectedGenre');
    expect(CENSUS).toContain('rejected_genre');
    expect(CENSUS).toContain('description_head');
  });

  it('живой набор берётся тем же предикатом, что и чистка', () => {
    expect(CENSUS).toContain('expires_at IS NULL OR expires_at > NOW()');
  });
});
