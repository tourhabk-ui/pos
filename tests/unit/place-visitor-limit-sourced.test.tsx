/**
 * «Лимит посещения» на карточке места — только природоохранный лимит с
 * источником (15.10, §0 «честность»).
 *
 * Карточка печатала «Лимит посещения: 50 человек в сутки», а блок «Бережное
 * посещение» — «Рекомендуемый размер группы — не более 50 человек в сутки».
 * Число бралось из `location_safety_profile.capacity_per_day`: DEFAULT 50 у
 * всех мест, у которых никто ничего не выставлял, и шаблон 070 у остальных.
 * Миграция 1017 сама называет его заглушкой и заводит настоящий лимит —
 * `places.visitor_limit_per_day` с обязательным источником.
 *
 * Судится рендером блоков и связкой загрузчика карточки.
 */
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import PlaceFacts from '@/components/places/PlaceFacts';
import PlaceLNT from '@/components/places/PlaceLNT';
import type { PlaceSafety } from '@/components/places/types';

afterEach(cleanup);

const safety = (over: Partial<PlaceSafety> = {}): PlaceSafety => ({
  difficultyLevel: null, altitudeM: null, altitudeDiffM: null, distanceKm: null, terrainType: null,
  nearestMedicalKm: null, emergencyAccess: null,
  phoneRangerMches: null, satCommunicatorRequired: null, rulesRequired: null, weatherThreshold: null,
  hazardTypes: [], capacityPerDay: null, optimalGroupSize: null, openFromDate: null, openToDate: null,
  requiredGear: [], connectivity: null, registrationRequired: false, medicalInfo: null,
  ...over,
} as PlaceSafety);

describe('факты места', () => {
  it('лимита с источником нет — строки «Лимит посещения» нет', () => {
    render(<PlaceFacts locationType="lake" zone={null} safety={safety()} />);
    expect(screen.queryByText('Лимит посещения')).toBeNull();
  });

  it('лимит с источником — число и чья это норма', () => {
    render(<PlaceFacts locationType="lake" zone={null} safety={safety({ capacityPerDay: 120, capacityPerDaySource: 'приказ дирекции парка № 7' })} />);
    const row = screen.getByText('Лимит посещения').parentElement?.textContent ?? '';
    expect(row).toContain('120 человек в сутки');
    expect(row).toContain('приказ дирекции парка № 7');
  });
});

describe('бережное посещение', () => {
  const open = () => fireEvent.click(screen.getByRole('button'));

  it('без лимита — ни числа, ни «размера группы»', () => {
    render(<PlaceLNT capacityPerDay={null} ecoZone={null} />);
    open();
    expect(document.body.textContent).not.toMatch(/человек в сутки|размер группы/i);
  });

  it('лимит места называется лимитом места, а не размером группы', () => {
    render(<PlaceLNT capacityPerDay={120} capacitySource="приказ дирекции парка № 7" ecoZone={null} />);
    open();
    const text = document.body.textContent ?? '';
    expect(text).toContain('Лимит посещения места — 120 человек в сутки: приказ дирекции парка № 7');
    expect(text).not.toMatch(/размер группы/i);
  });
});

describe('загрузчик карточки', () => {
  // Подставная база: главная строка места — с заглушкой профиля 50 и без
  // лимита с источником; остальные чтения карточки — пусто.
  const row = (over: Record<string, unknown> = {}) => ({
    place_pk: 'test-place-0001', ark_id: '22222222-2222-2222-2222-222222222222', name: 'Озеро Тестовое',
    lat: 53, lng: 158, location_type: 'lake', photo_count: 0,
    capacity_per_day: 50, optimal_group_size: 8, profile_source: 'unknown',
    visitor_limit_per_day: null, visitor_limit_source: null,
    ...over,
  });
  const load = async (main: Record<string, unknown>) => {
    vi.resetModules();
    vi.doMock('@/lib/database', () => ({
      query: async (sql: string) => ({ rows: /FROM places p\s+LEFT JOIN place_description_drafts/.test(sql) ? [main] : [] }),
    }));
    vi.doMock('@/lib/db-pool', () => ({ pool: { query: async () => ({ rows: [] }) } }));
    const { loadPlaceDetail } = await import('@/lib/places/place-detail');
    const r = await loadPlaceDetail('test-place-0001', { countView: false });
    return (r.body.data as { safety: PlaceSafety }).safety;
  };

  it('заглушка профиля 50 лимитом не становится', async () => {
    const s = await load(row());
    expect(s.capacityPerDay).toBeNull();
  });

  it('лимит с источником — число и источник', async () => {
    const s = await load(row({ visitor_limit_per_day: 120, visitor_limit_source: 'приказ дирекции парка № 7' }));
    expect(s.capacityPerDay).toBe(120);
    expect(s.capacityPerDaySource).toBe('приказ дирекции парка № 7');
  });
});
