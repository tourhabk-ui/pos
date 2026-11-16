/**
 * «Выйти» стирает черновик анкеты планера (слово владельца 16.11 «Сделай
 * правку», по ручному ревью PR 3425).
 *
 * В черновике подвижность, морская болезнь, возраст детей и номера рейсов.
 * Чужому вошедшему он не отдаётся (владелец в записи, planner-form-draft), а
 * «Выйти» его стирает, чтобы он не лежал на общем устройстве.
 *
 * Проверка — исполнением: настоящий AuthProvider, нажатие «Выйти» через
 * signOut(), что осталось в хранилище.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AuthProvider, useAuth } from '@/contexts/AuthContext';
import { resetSessionState } from '@/lib/auth/session-state';
import {
  FORM_DRAFT_KEY, EMPTY_FORM_DRAFT, clearFormDraft, parseFormDraft, serializeFormDraft,
} from '@/lib/planner/form-draft';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const USER = {
  id: 'u-1', email: 'test@example.com', name: 'Тест', role: 'tourist', roles: ['tourist'],
  preferences: {}, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};
const NOW = new Date();
const DRAFT = serializeFormDraft({
  ...EMPTY_FORM_DRAFT, places: ['volcano'], seasickness: true, mobilityLevel: 'wheelchair',
  childAges: [6], flightArrival: 'SU1730',
}, 'u-1', NOW);

function Probe() {
  const { user, isLoading, signOut } = useAuth();
  if (isLoading) return <div>loading</div>;
  return (
    <div>
      <span>{user ? `user:${user.name}` : 'guest'}</span>
      <button onClick={() => { signOut().catch(() => undefined); }}>Выйти</button>
    </div>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  resetSessionState();
  localStorage.setItem('user', JSON.stringify(USER));
  localStorage.setItem(FORM_DRAFT_KEY, DRAFT);
  localStorage.setItem('kept_key', 'остаётся');
});

async function signedIn() {
  render(<AuthProvider><Probe /></AuthProvider>);
  await waitFor(() => expect(screen.getByText('user:Тест')).toBeInTheDocument());
  // Черновик до выхода на месте и читается — иначе проверка ниже ничего не доказала бы.
  expect(parseFormDraft(localStorage.getItem(FORM_DRAFT_KEY), '2000-01-01', 'u-1', NOW)).not.toBeNull();
}

describe('«Выйти» стирает черновик анкеты планера', () => {
  it('после выхода черновика нет, чужие ключи хранилища не тронуты', async () => {
    fetchMock.mockImplementation(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: USER }) }));
    await signedIn();
    fireEvent.click(screen.getByText('Выйти'));
    await waitFor(() => expect(screen.getByText('guest')).toBeInTheDocument());
    expect(localStorage.getItem(FORM_DRAFT_KEY)).toBeNull();
    expect(localStorage.getItem('kept_key')).toBe('остаётся');
  });

  it('сервер выхода не ответил — черновик всё равно стёрт', async () => {
    fetchMock.mockImplementation((url: unknown) => (String(url).includes('/api/auth/signout')
      ? Promise.reject(new Error('сеть'))
      : Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: USER }) })));
    await signedIn();
    fireEvent.click(screen.getByText('Выйти'));
    await waitFor(() => expect(localStorage.getItem(FORM_DRAFT_KEY)).toBeNull());
  });

  it('отказ хранилища выход не роняет', () => {
    const spy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('запрещено'); });
    try {
      expect(() => clearFormDraft()).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});
