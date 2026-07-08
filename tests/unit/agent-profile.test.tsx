/**
 * tests/unit/agent-profile.test.tsx
 *
 * Страница «Профиль» агента: рендерит общий PartnerProfileEditor,
 * грузит профиль из GET /api/partners/profile в поля.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import React from 'react';

import AgentProfileClient from '@/app/hub/agent/profile/_AgentProfileClient';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ success: true, data: { partner: {
      name: 'Турагентство Восток', description: 'Работаем с 2010', contact: { phone: '+7 41' },
    } } }),
  }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('AgentProfileClient', () => {
  it('рендерит заголовок и грузит профиль в редактор', async () => {
    render(<AgentProfileClient />);
    expect(screen.getByText('Профиль агентства')).toBeTruthy();
    await waitFor(() => expect((screen.getByLabelText(/Имя/) as HTMLInputElement).value).toBe('Турагентство Восток'));
    expect((screen.getByLabelText(/Телефон/) as HTMLInputElement).value).toBe('+7 41');
  });
});
