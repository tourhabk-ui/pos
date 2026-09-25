/**
 * Сторож: тур вне сезона в канал не уходит (25.09).
 *
 * Владелец прислал снимок канала: «Летняя рыбалка на чавычу и нерку» 25.09 —
 * «летняя? уже сентябрь». Сезон этого тура на проде — 01.06–15.08 (проба 595);
 * выбор тура для поста на даты не смотрел вовсе.
 *
 * Фикстуры — живые туры прода на 25.09 (id, заголовок, сезон из /api/tours).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tourPostSeason, pickInSeason, type PostSeasonInput } from '@/lib/tours/post-season';

const NOW = new Date('2026-09-25T07:00:00Z');

function tour(title: string, start: string | null, end: string | null, extra: Partial<PostSeasonInput> = {}): PostSeasonInput {
  return {
    title, short_description: null, season_start: start, season_end: end,
    duration_type: null, multi_day_count: null, duration_hours: null, ...extra,
  };
}

const CHAVYCHA = tour('Летняя рыбалка на чавычу и нерку', '2026-06-01', '2026-08-15');
const KIZUCH = tour('Летняя рыбалка на кижуча', '2026-08-01', '2026-10-15');
const FAMILY = tour('Семейный тур выходного дня', '2026-06-01', '2026-09-15');
const AUTUMN_2025 = tour('Осенняя рыбалка (октябрь-ноябрь)', '2025-10-01', '2025-11-15');
const RAFT = tour('Сплав по реке Быстрая', '2026-06-01', '2026-09-30');
const NO_DATES = tour('Сплав по реке Быстрая (два дня)', null, null);

describe('сезон тура для поста', () => {
  it('случай 25.09: чавыча и нерка с сезоном до 15.08 — вне сезона, с датой в причине', () => {
    const v = tourPostSeason(CHAVYCHA, NOW);
    expect(v.season).toBe('out_of_season');
    expect(v.reason).toContain('15.08.2026');
  });

  it('рыба в тексте поста опровергает даже без дат: чавыча в сентябре', () => {
    const v = tourPostSeason({ ...CHAVYCHA, season_start: null, season_end: null }, NOW);
    expect(v.season).toBe('out_of_season');
    expect(v.reason).toMatch(/чавыча/);
  });

  it('рыба судит и против дат оператора: чавыча с сезоном «до октября» всё равно не идёт', () => {
    expect(tourPostSeason({ ...CHAVYCHA, season_end: '2026-10-31' }, NOW).season).toBe('out_of_season');
  });

  it('слово «летняя» сезоном не считается: кижуч до 15.10 в сентябре — сезон', () => {
    expect(tourPostSeason(KIZUCH, NOW).season).toBe('in_season');
  });

  it('рыба следующего месяца не отсекает анонс: чавыча в апреле (ход с мая)', () => {
    const april = new Date('2026-04-20T07:00:00Z');
    expect(tourPostSeason({ ...CHAVYCHA, season_start: '2026-06-01', season_end: '2026-08-15' }, april).season)
      .not.toBe('out_of_season');
  });

  it('даты прошлого года — вне сезона: сезон не переносится на новый год догадкой', () => {
    expect(tourPostSeason(AUTUMN_2025, NOW).season).toBe('out_of_season');
  });

  it('многодневный тур, не влезающий в остаток сезона, — вне сезона (правило каталога)', () => {
    const week = tour('Сплав', '2026-06-01', '2026-09-28', { duration_type: 'multi_day', multi_day_count: 7 });
    expect(tourPostSeason(week, NOW).season).toBe('out_of_season');
  });

  it('дат нет и опровержения нет — «не знаю», а не «сезон»', () => {
    expect(tourPostSeason(NO_DATES, NOW).season).toBe('unknown');
  });
});

describe('выбор тура для поста', () => {
  it('первый в порядке вызывающего, если он в сезоне; вне сезона не выбирается никогда', () => {
    const r = pickInSeason([CHAVYCHA, FAMILY, RAFT, KIZUCH], NOW);
    expect(r.pick?.title).toBe('Сплав по реке Быстрая');
    expect(r.skipped.map((s) => s.title)).toEqual(['Летняя рыбалка на чавычу и нерку', 'Семейный тур выходного дня']);
  });

  it('подтверждённый сезон впереди незаписанного', () => {
    expect(pickInSeason([NO_DATES, RAFT], NOW).pick?.title).toBe('Сплав по реке Быстрая');
  });

  it('все вне сезона — пусто, но отсеянные названы', () => {
    const r = pickInSeason([CHAVYCHA, AUTUMN_2025], NOW);
    expect(r.pick).toBeNull();
    expect(r.skipped).toHaveLength(2);
  });
});

describe('обе двери в канал спрашивают сезон', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

  it('ежедневный пост выбирает через pickInSeason и не берёт LIMIT 1 до суда', () => {
    const src = read('lib/notifications/telegram-channel.ts');
    const fn = src.slice(src.indexOf('export async function postKuzmichTour'), src.indexOf('// ── AI News channel post'));
    expect(fn).toContain('pickInSeason(');
    expect(fn).toMatch(/season_end/);
    expect(fn).not.toMatch(/LIMIT 1/);
  });

  it('ручная публикация отказывает туру вне сезона', () => {
    const src = read('lib/notifications/tour-channel-post.ts');
    expect(src).toContain('tourPostSeason(');
    expect(src).toMatch(/season\.season === 'out_of_season'/);
  });
});
