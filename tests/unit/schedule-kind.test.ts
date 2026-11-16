/**
 * Признак «как тур выезжает» (#3476, шаг 1, миграция 1455) и вторая группа
 * правила 1в — «Выезды первыми» (слово владельца 16.11).
 *
 * Судится вызовом на граничных данных: правило чтения, окно «любого дня»,
 * порядок туров и компаний, фраза о датах, подписи витрин.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scheduleKindOf, anyDayWindow, isAnyDayOpen, anyDayPhrase } from '@/lib/tours/schedule-kind';
import {
  compareTourOffers, groupOffersByCompany, offerTier, orderOffers, offerDatesPhrase,
  OFFER_ORDER_NOTE, OFFER_ORDER_NOTE_SHORT_RU, OFFER_ORDER_NOTE_GROUPED_RU, OFFER_ORDER_NOTE_AGENT,
} from '@/lib/tours/offer-order';
import { HOME_PLATES_ORDER_NOTE, orderPlates } from '@/lib/home/plate-facts';

const TODAY = '2026-11-16';
const season = (start: string | null, end: string | null) => ({
  season_start: start, season_end: end, duration_type: 'single_day', multi_day_count: null, duration_hours: 8,
});

describe('правило чтения schedule_kind', () => {
  it('два значения и «не указано»; мусор — «не указано», а не догадка', () => {
    expect(scheduleKindOf('departures')).toBe('departures');
    expect(scheduleKindOf('any_day')).toBe('any_day');
    for (const v of [null, undefined, '', 'ANY_DAY', 'daily', 1, true]) expect(scheduleKindOf(v)).toBeNull();
  });

  it('окно «любого дня» — только у any_day с записанным и не прошедшим сезоном', () => {
    const w = anyDayWindow({ ...season('2027-07-15', '2027-10-15'), schedule_kind: 'any_day' }, TODAY);
    expect(w).toMatchObject({ from: '2027-07-15', to: '2027-10-15' });
    // Сезон идёт — окно с сегодняшнего дня.
    expect(anyDayWindow({ ...season('2026-11-01', '2027-03-01'), schedule_kind: 'any_day' }, TODAY)?.from).toBe(TODAY);
    // Сезон не записан — «любой день» без границ не обещается.
    expect(isAnyDayOpen({ ...season(null, null), schedule_kind: 'any_day' }, TODAY)).toBe(false);
    // Сезон прошёл.
    expect(isAnyDayOpen({ ...season('2026-07-15', '2026-10-15'), schedule_kind: 'any_day' }, TODAY)).toBe(false);
    // Не any_day — окна нет, даже при сезоне.
    expect(isAnyDayOpen({ ...season('2027-07-15', '2027-10-15'), schedule_kind: 'departures' }, TODAY)).toBe(false);
    expect(isAnyDayOpen({ ...season('2027-07-15', '2027-10-15'), schedule_kind: null }, TODAY)).toBe(false);
    // Многодневный тур должен закончиться в сезоне.
    const week = { ...season('2027-07-15', '2027-10-15'), duration_type: 'multi_day', multi_day_count: 7, schedule_kind: 'any_day' };
    expect(anyDayWindow(week, TODAY)?.to).toBe('2027-10-09');
  });

  it('фраза называет сезон и того, кто подтверждает место', () => {
    const w = anyDayWindow({ ...season('2027-07-15', '2027-10-15'), schedule_kind: 'any_day' }, TODAY)!;
    expect(anyDayPhrase(w)).toBe('любой день сезона, сезон 15 июля 2027 — 15 октября 2027 — место подтверждает оператор');
  });
});

describe('правило 1в: «Выезды первыми»', () => {
  const D = TODAY;

  it('группы: выезд с местами → любой день сезона → остальные', () => {
    expect(offerTier({ id: 1, nearestFreeDate: '2026-12-01' })).toBe(0);
    expect(offerTier({ id: 1, nearestFreeDate: null, anyDay: true })).toBe(1);
    // Строка календаря у тура «любой день» — исключение, а не выезд.
    expect(offerTier({ id: 1, nearestFreeDate: '2026-11-20', anyDay: true })).toBe(1);
    expect(offerTier({ id: 1, nearestFreeDate: null })).toBe(2);
    expect(offerTier({ id: 1, nearestFreeDate: null, anyDay: false })).toBe(2);
  });

  it('порядок туров: выезды по дате, затем любой день, затем остальные — при любом дне жребия', () => {
    const rows = [
      { id: 1, nearestFreeDate: null },
      { id: 2, nearestFreeDate: null, anyDay: true },
      { id: 3, nearestFreeDate: '2027-01-10' },
      { id: 4, nearestFreeDate: '2026-12-01' },
      { id: 5, nearestFreeDate: '2026-11-17', anyDay: true },
      { id: 6, nearestFreeDate: null },
    ];
    for (const day of ['2026-11-16', '2026-11-17', '2026-12-31', '2027-03-08']) {
      const ids = orderOffers(rows, { day }).map((r) => r.id);
      expect(ids.slice(0, 2)).toEqual([4, 3]);
      expect(new Set(ids.slice(2, 4))).toEqual(new Set([2, 5]));
      expect(new Set(ids.slice(4))).toEqual(new Set([1, 6]));
    }
  });

  it('без признака порядок прежний: anyDay не передан — тур как раньше', () => {
    const cmp = compareTourOffers(D);
    expect(cmp({ id: 1, nearestFreeDate: '2026-12-01' }, { id: 2, nearestFreeDate: null })).toBeLessThan(0);
    expect(cmp({ id: 2, nearestFreeDate: null }, { id: 1, nearestFreeDate: '2026-12-01' })).toBeGreaterThan(0);
  });

  it('компании: по лучшему туру — компания с выездом выше компании «любой день», та выше остальных', () => {
    const groups = groupOffersByCompany([
      { id: 1, nearestFreeDate: null, partnerId: 'c', partnerName: 'C' },
      { id: 2, nearestFreeDate: null, anyDay: true, partnerId: 'b', partnerName: 'B' },
      { id: 3, nearestFreeDate: null, partnerId: 'b', partnerName: 'B' },
      { id: 4, nearestFreeDate: '2027-02-01', partnerId: 'a', partnerName: 'A' },
    ], { day: D });
    expect(groups.map((g) => g.partnerId)).toEqual(['a', 'b', 'c']);
    expect(groups[1].tours.map((t) => t.id)).toEqual([2, 3]);
  });

  it('главная: тур «любой день сезона» встаёт после выездов', () => {
    const plates = orderPlates([
      { id: 'x', availability: 'on_request', imageUrl: '/a.jpg', partnerId: 'p1', nearestFreeDate: null },
      { id: 'y', availability: 'any_day', imageUrl: '/a.jpg', partnerId: 'p2', nearestFreeDate: null },
      { id: 'z', availability: 'dates', imageUrl: '/a.jpg', partnerId: 'p3', nearestFreeDate: '2026-12-01' },
    ], { day: D });
    expect(plates.map((p) => p.id)).toEqual(['z', 'y', 'x']);
  });

  it('фраза о датах: любой день сезона сильнее строки календаря; без признака — прежние слова', () => {
    const t = { ...season('2027-07-15', '2027-10-15'), nearestFreeDate: '2026-11-20', keepsSchedule: true };
    expect(offerDatesPhrase({ ...t, schedule_kind: 'any_day' }, TODAY, 'ok')).toMatch(/^любой день сезона, сезон 15 июля 2027/);
    expect(offerDatesPhrase(t, TODAY, 'ok')).toMatch(/^ближайшая дата со свободными местами/);
    // Отказ чтения дат важнее признака.
    expect(offerDatesPhrase({ ...t, schedule_kind: 'any_day' }, TODAY, 'failed')).toBe('даты не загрузились');
  });

  it('подписи витрин называют вторую группу словами и кончаются «Место в списке не продаётся.»', () => {
    for (const note of [OFFER_ORDER_NOTE.ru, OFFER_ORDER_NOTE_SHORT_RU, OFFER_ORDER_NOTE_GROUPED_RU, OFFER_ORDER_NOTE_AGENT, HOME_PLATES_ORDER_NOTE]) {
      expect(note).toMatch(/любой день сезона/);
      expect(note.endsWith('Место в списке не продаётся.')).toBe(true);
    }
    expect(OFFER_ORDER_NOTE.en).toMatch(/any day of the season/);
  });
});

describe('миграция 1455', () => {
  const sql = readFileSync(join(process.cwd(), 'migrations/1455_tour_schedule_kind.sql'), 'utf8');
  it('колонка без умолчания и без заполнения, CHECK на два значения или NULL', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS schedule_kind TEXT;/);
    expect(sql).not.toMatch(/schedule_kind\s+TEXT\s+(NOT NULL|DEFAULT)/i);
    expect(sql).not.toMatch(/UPDATE\s+operator_tours/i);
    expect(sql).toMatch(/CHECK \(schedule_kind IS NULL OR schedule_kind IN \('departures', 'any_day'\)\)/);
  });
});
