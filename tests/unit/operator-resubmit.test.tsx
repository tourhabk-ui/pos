/**
 * Отклонённый оператор видит причину отказа и подаёт заявку снова (слово
 * владельца 23.11: «как у гида»).
 *
 * До этого дня причина отказа приходила в ответе профиля и не показывалась
 * ни на одном экране оператора, а чек-лист готовности говорил «свяжитесь с
 * администратором платформы»: человек упирался в стену.
 *
 * Здесь — экран: блок отказа и сам профиль компании, рендером. Дверь на
 * сервере — tests/unit/operator-profile-patch.test.ts; чек-лист —
 * tests/unit/partner-readiness.test.tsx и pg-тест готовности.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('@/components/auth/Protected', () => ({ Protected: ({ children }: { children: React.ReactNode }) => children }));

import { ProfileReviewNotice } from '@/components/operator/ProfileReviewNotice';
import OperatorProfileClient from '@/app/hub/operator/profile/_ProfileClient';
import { RESUBMITTED_TEXT } from '@/lib/operator/profile-status';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('блок отказа по заявке', () => {
  const show = (over: Partial<React.ComponentProps<typeof ProfileReviewNotice>> = {}) => {
    const onResubmitted = vi.fn();
    render(<ProfileReviewNotice status="rejected" comment="Нет описания компании и телефона." viewer="owner" onResubmitted={onResubmitted} {...over} />);
    return { onResubmitted };
  };

  it('отклонена: причина администратора показана как есть, кнопка — «отправить снова»', () => {
    show();
    const box = screen.getByTestId('profile-review');
    expect(box.getAttribute('data-state')).toBe('rejected');
    expect(box.textContent).toContain('Заявка отклонена');
    expect(screen.getByTestId('profile-review-reason').textContent).toBe('Причина отказа: Нет описания компании и телефона.');
    expect(box.textContent).toContain('на проверку уйдёт сохранённая версия');
    expect(screen.getByRole('button', { name: 'Отправить на проверку снова' })).toBeTruthy();
  });

  it('причины нет — так и сказано, а не пустая строка', () => {
    for (const comment of [null, '', '   ']) {
      cleanup();
      show({ comment });
      expect(screen.getByTestId('profile-review-reason').textContent).toBe('Причина отказа не записана.');
    }
  });

  it('причина — текст администратора: разметка в ней не исполняется', () => {
    show({ comment: '<img src=x onerror="alert(1)"><b>жирно</b>' });
    const reason = screen.getByTestId('profile-review-reason');
    expect(reason.querySelector('img')).toBeNull();
    expect(reason.querySelector('b')).toBeNull();
    expect(reason.textContent).toContain('<img src=x onerror="alert(1)"><b>жирно</b>');
  });

  it.each(['none', 'pending', 'approved', null, 'archived'])('статус «%s»: блока отказа нет', (status) => {
    show({ status });
    expect(screen.queryByTestId('profile-review')).toBeNull();
  });

  it('менеджер компании причину видит, а подать не может — и это сказано', () => {
    show({ viewer: 'manager' });
    expect(screen.getByTestId('profile-review-reason').textContent).toContain('Нет описания компании и телефона.');
    expect(screen.queryByRole('button', { name: 'Отправить на проверку снова' })).toBeNull();
    expect(screen.getByTestId('profile-review').textContent).toContain('может владелец кабинета');
  });

  it('нажатие шлёт один флаг в дверь профиля; успех — слова сервера и перемена статуса у экрана', async () => {
    const fetchMock = vi.fn(async () => json({ success: true, message: RESUBMITTED_TEXT, profile_status: 'pending' }));
    vi.stubGlobal('fetch', fetchMock);
    const { onResubmitted } = show();
    fireEvent.click(screen.getByRole('button', { name: 'Отправить на проверку снова' }));
    await waitFor(() => expect(onResubmitted).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/hub/operator/profile');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({ submit_for_review: true });
    const box = screen.getByTestId('profile-review');
    expect(box.getAttribute('data-state')).toBe('resubmitted');
    expect(box.textContent).toBe(RESUBMITTED_TEXT);
    // Кнопки больше нет: вторая подача той же заявки не нужна.
    expect(screen.queryByRole('button', { name: 'Отправить на проверку снова' })).toBeNull();
  });

  it('отказ сервера показан его словами; статус у экрана не меняется, кнопка остаётся', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ success: false, error: 'Заявка уже на проверке — дождитесь решения администратора' }, 409)));
    const { onResubmitted } = show();
    fireEvent.click(screen.getByRole('button', { name: 'Отправить на проверку снова' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Заявка уже на проверке — дождитесь решения администратора');
    expect(onResubmitted).not.toHaveBeenCalled();
    expect(screen.getByTestId('profile-review').getAttribute('data-state')).toBe('rejected');
    expect(screen.getByRole('button', { name: 'Отправить на проверку снова' })).toBeTruthy();
  });

  it('сеть оборвалась или ответ не разобран — «не удалось», а не «отправлено»', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const first = show();
    fireEvent.click(screen.getByRole('button', { name: 'Отправить на проверку снова' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Не удалось отправить заявку. Проверьте соединение.');
    expect(first.onResubmitted).not.toHaveBeenCalled();

    cleanup();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>502</html>', { status: 502 })));
    const second = show();
    fireEvent.click(screen.getByRole('button', { name: 'Отправить на проверку снова' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Не удалось отправить заявку. Попробуйте позже.');
    expect(second.onResubmitted).not.toHaveBeenCalled();
  });
});

describe('профиль компании оператора', () => {
  const PROFILE = {
    id: 'p1', company_name: 'Тестовая компания', category: 'operator', description: 'Описание.', short_description: null,
    profile_status: 'rejected', profile_review_comment: 'Не указан телефон.', is_verified: false,
    contacts: { phone: null }, location: null, services: [], features: [], email: 'op@example.test', contact_name: 'Тест',
    viewer: 'owner', telegram_notifications: { status: 'connected', source: 'partner' },
  };
  const serve = (profile: Record<string, unknown>, patch: () => Response = () => json({ success: true, message: RESUBMITTED_TEXT, profile_status: 'pending' })) => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => (init?.method === 'PATCH' ? patch() : json({ success: true, data: profile })));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  it('отклонённый владелец: причина на экране, после подачи статус в шапке — «На проверке»', async () => {
    serve(PROFILE);
    render(<OperatorProfileClient />);
    const box = await screen.findByTestId('profile-review');
    expect(within(box).getByTestId('profile-review-reason').textContent).toBe('Причина отказа: Не указан телефон.');
    expect(screen.getByText('Отклонён')).toBeTruthy();
    fireEvent.click(within(box).getByRole('button', { name: 'Отправить на проверку снова' }));
    await waitFor(() => expect(screen.getByText('На проверке')).toBeTruthy());
    expect(screen.queryByText('Отклонён')).toBeNull();
    expect(screen.getByTestId('profile-review').textContent).toBe(RESUBMITTED_TEXT);
  });

  it('кто смотрит — не сказано: кнопки подачи нет', async () => {
    serve({ ...PROFILE, viewer: undefined });
    render(<OperatorProfileClient />);
    const box = await screen.findByTestId('profile-review');
    expect(within(box).queryByRole('button', { name: 'Отправить на проверку снова' })).toBeNull();
  });

  it.each(['pending', 'approved', 'none'])('статус «%s»: блока отказа на экране нет, даже если прошлая причина осталась в карточке', async (status) => {
    serve({ ...PROFILE, profile_status: status });
    render(<OperatorProfileClient />);
    await screen.findByText('Сохранить изменения');
    expect(screen.queryByTestId('profile-review')).toBeNull();
    expect(screen.queryByText(/Не указан телефон/)).toBeNull();
  });
});
