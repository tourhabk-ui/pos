/**
 * Разрешение на карточке места — своя дверь, а не общая «Зелёная кнопка».
 *
 * 14.10, Кроноцкий заповедник (миграция 1240): карточка на строку
 * «регистрация обязательна» вешала «Разрешение парка → Зелёная кнопка» любому
 * месту. Кнопка — приложение сети природных парков «Вулканы Камчатки»; у
 * заповедника свой порядок — заявка с kronoki.ru на почту заповедника.
 * Записанная страница разрешения места (`eco_permit_url`) теперь важнее.
 *
 * Судит рендер: что видит человек — подпись строки, текст и адрес ссылки.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('@/components/shared/EmergencyAction', () => ({ EmergencyAction: () => null }));

import PlaceSafety from '@/components/places/PlaceSafety';
import { ownPermitOf } from '@/lib/places/own-permit';
import type { PlaceSafety as SafetyData } from '@/components/places/types';

afterEach(cleanup);

const SAFETY: SafetyData = {
  source: 'manual',
  difficultyLevel: null, altitudeM: null, altitudeDiffM: null, distanceKm: null,
  terrainType: null, roadType: null, roadAccessibility: null, nearestMedicalKm: null,
  emergencyAccess: null, phoneRangerMches: null, satCommunicatorRequired: null,
  rulesRequired: null, weatherThreshold: null, hazardTypes: ['bears', 'thermal'],
  capacityPerDay: null, optimalGroupSize: null, openFromDate: null, openToDate: null,
  requiredGear: [], connectivity: null, registrationRequired: true, medicalInfo: null,
};

describe('ownPermitOf — своя страница разрешения из эко-данных', () => {
  it('заповедник с https-адресом: подпись заповедника и хост без www', () => {
    expect(ownPermitOf({ zone: 'federal_reserve', permitUrl: 'https://kronoki.ru/ru/visit/requests/' })).toEqual({
      label: 'Разрешение заповедника',
      href: 'https://kronoki.ru/ru/visit/requests/',
      host: 'kronoki.ru',
    });
    expect(ownPermitOf({ zone: 'natural_park', permitUrl: 'https://www.example.org/p' })?.label).toBe('Разрешение парка');
    expect(ownPermitOf({ zone: 'zakaznik', permitUrl: 'https://example.org/z' })?.label).toBe('Разрешение заказника');
  });

  it('адреса нет, он не https или битый — своей двери нет', () => {
    expect(ownPermitOf(null)).toBeNull();
    expect(ownPermitOf({ zone: 'federal_reserve', permitUrl: null })).toBeNull();
    expect(ownPermitOf({ zone: 'federal_reserve', permitUrl: 'http://kronoki.ru/' })).toBeNull();
    expect(ownPermitOf({ zone: 'federal_reserve', permitUrl: 'не адрес' })).toBeNull();
  });
});

describe('строка разрешения в блоке безопасности', () => {
  it('у заповедника со своей страницей — заявка на kronoki.ru, «Зелёной кнопки» нет', () => {
    const own = ownPermitOf({ zone: 'federal_reserve', permitUrl: 'https://kronoki.ru/ru/visit/requests/' });
    render(<PlaceSafety safety={SAFETY} placeId="x" ownPermit={own} />);
    expect(screen.getByText('Разрешение заповедника')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'заявка на kronoki.ru' });
    expect(link.getAttribute('href')).toBe('https://kronoki.ru/ru/visit/requests/');
    expect(screen.queryByText(/Зелёная кнопка/)).toBeNull();
    // МЧС остаётся — это вторая обязанность, а не та же.
    expect(screen.getByRole('link', { name: 'МЧС обязательна' })).toBeTruthy();
  });

  it('без своей страницы — прежнее: «Разрешение парка» и «Зелёная кнопка»', () => {
    render(<PlaceSafety safety={SAFETY} placeId="x" />);
    expect(screen.getByText('Разрешение парка')).toBeTruthy();
    expect(screen.getByText(/Зелёная кнопка/)).toBeTruthy();
  });
});
