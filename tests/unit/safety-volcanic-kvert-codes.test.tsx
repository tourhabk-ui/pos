/**
 * tests/unit/safety-volcanic-kvert-codes.test.tsx
 *
 * Полевой скриншот владельца 14.09: на /safety секция «Вулканическая
 * активность» говорила «Активных вулканических предупреждений нет», пока
 * виджет «Пульс вулканов» на той же странице показывал Шивелуч оранжевым
 * с пеплом до 12 км.
 *
 * Причина — GET /api/safety/volcanic с 06.09 отдаёт ДВА потока одним
 * ответом: events (новости МЧС/СМИ, «что случилось») и statuses.elevated
 * (коды KVERT, «что сейчас»; getVolcanoStatuses, добавлено ради ровно
 * такого же расхождения на вкладке «Вулканы» на главной — см. шапку
 * lib/services/safety/volcano-status.ts). Экран /safety читал только
 * events: тот же класс дефекта вернулся на другой поверхности, потому что
 * почин 06.09 не дошёл до всех потребителей роута.
 *
 * Проверено рендером, не чтением текста компонента: фикстура задаёт
 * events: [] и statuses.elevated с одним оранжевым вулканом — секция
 * обязана показать код и не иметь права сказать «предупреждений нет».
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';

import SafetyClient from '@/app/safety/_SafetyClient';

// EmergencyAction (SOS в шапке, всегда на экране) зовёт useRouter — без мока
// рендер падает вне App Router контекста.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

const KVERT_ELEVATED = {
  name: 'Шивелуч',
  color: 'orange',
  summary: 'Высокая активность',
  ash_height_m: 12000,
  observed_at: new Date().toISOString(),
  source_url: null,
};

function mockFetch(volcanicResponse: unknown) {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url.includes('/api/safety/volcanic')) {
      return Promise.resolve({ ok: true, json: async () => volcanicResponse });
    }
    if (url.includes('/api/public/danger-summary')) {
      return Promise.resolve({ ok: true, json: async () => ({ ok: true, zones: [] }) });
    }
    if (url.includes('/api/safety/seismic')) {
      return Promise.resolve({ ok: true, json: async () => ({ events: [] }) });
    }
    if (url.includes('/api/safety/weather')) {
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }
    return Promise.resolve({ ok: true, json: async () => ({}) });
  }));
}

async function openVolcanicSection() {
  const btn = await screen.findByRole('button', { name: /Вулканическая активность/ });
  fireEvent.click(btn);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('/safety — секция «Вулканическая активность» читает коды KVERT', () => {
  it('оранжевый код KVERT без новостей МЧС — не «предупреждений нет»', async () => {
    mockFetch({ events: [], statuses: { elevated: [KVERT_ELEVATED], total: 40, green: 39, updated_at: new Date().toISOString() } });
    render(<SafetyClient live={null} />);
    await openVolcanicSection();

    await waitFor(() => expect(screen.getByText('Шивелуч')).toBeTruthy());
    expect(screen.getByText(/Оранжевый/)).toBeTruthy();
    expect(screen.queryByText('Активных вулканических предупреждений нет.')).toBeNull();
  });

  it('оба потока пусты — честное «предупреждений нет»', async () => {
    mockFetch({ events: [], statuses: { elevated: [], total: 40, green: 40, updated_at: new Date().toISOString() } });
    render(<SafetyClient live={null} />);
    await openVolcanicSection();

    await waitFor(() => expect(screen.getByText('Активных вулканических предупреждений нет.')).toBeTruthy());
  });

  it('счётчик в бейдже учитывает оба потока, не только новости', async () => {
    mockFetch({
      events: [{ id: 'e1', title: 'Сход обвала', description: null, severity: 2, affected_zones: [], created_at: new Date().toISOString(), active: true }],
      statuses: { elevated: [KVERT_ELEVATED], total: 40, green: 39, updated_at: new Date().toISOString() },
    });
    render(<SafetyClient live={null} />);
    // Бейдж «2» — одна новость + один код KVERT, до раскрытия секции.
    await waitFor(() => expect(screen.getByText('2')).toBeTruthy());
  });
});
