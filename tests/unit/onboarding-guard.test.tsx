/**
 * tests/unit/onboarding-guard.test.tsx
 *
 * useOnboardingGuard — гейт, распространяемый на кабинеты guide/agent:
 * незавершённый профиль уводит в визард (router.replace), завершённый →
 * ready; 403/ошибка не блокируют кабинет (ready=true).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import React from 'react';

const replaceMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
}));

import { useOnboardingGuard } from '@/components/hub/usePartnerOnboarding';

function Harness({ path }: { path: string }) {
  const ready = useOnboardingGuard(path);
  return <div>{ready ? 'ready' : 'wait'}</div>;
}

function mockProfile(ok: boolean, partner: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok,
    json: async () => ({ success: ok, data: { partner } }),
  }));
}

beforeEach(() => {
  replaceMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('useOnboardingGuard (guide/agent)', () => {
  it('незавершённый профиль → редирект в визард, кабинет не готов', async () => {
    mockProfile(true, { id: 'p1', name: 'Гид', description: null, onboarding_completed: false });
    render(<Harness path="/hub/guide/onboarding" />);
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/hub/guide/onboarding'));
    expect(screen.queryByText('ready')).toBeNull();
  });

  it('завершённый профиль → ready, без редиректа', async () => {
    mockProfile(true, { id: 'p1', name: 'Гид', description: 'опыт', onboarding_completed: true });
    render(<Harness path="/hub/guide/onboarding" />);
    await waitFor(() => expect(screen.getByText('ready')).toBeTruthy());
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('403/не-партнёр (не ok) → ready, кабинет не блокируется', async () => {
    mockProfile(false, null);
    render(<Harness path="/hub/agent/onboarding" />);
    await waitFor(() => expect(screen.getByText('ready')).toBeTruthy());
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('сетевая ошибка → ready (fail-open)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    render(<Harness path="/hub/agent/onboarding" />);
    await waitFor(() => expect(screen.getByText('ready')).toBeTruthy());
    expect(replaceMock).not.toHaveBeenCalled();
  });
});
