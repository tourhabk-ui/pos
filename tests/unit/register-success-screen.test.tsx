/**
 * Экран после «Включить контроль» на /register — рендером всей страницы.
 *
 * Рамка со ссылкой «Я вернулся» и телефоны вынесены в свои компоненты, и
 * tests/unit/return-not-to-mchs.test.tsx судит их по отдельности. Но человек
 * получает ссылку не от компонента, а от страницы: исчезни рамка с экрана
 * успеха — те проверки останутся зелёными, а включивший контроль уйдёт на
 * маршрут без ссылки, и после срока тревога уйдёт контакту и дежурному.
 *
 * Держит: форма, открытая ссылкой с карточки маршрута (`registerFormHref`),
 * проходится до конца; экран успеха показывается ровно тогда, когда запись
 * контроля есть, — со ссылкой на /return с её номером, какой бы ни был исход
 * листа; отказ записи экрана успеха не показывает.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const m = vi.hoisted(() => ({ submit: vi.fn(), push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: m.push, back: vi.fn() }) }));
vi.mock('@/lib/safety/register-submit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/safety/register-submit')>()),
  submitTripWatchForm: (...a: unknown[]) => m.submit(...a),
}));

import RegisterRoutePage from '@/app/register/page';
import { registerFormHref } from '@/lib/safety/register-submit';
import { MCHS_RETURN_NOT_VIA_VEDAR } from '@/lib/safety/mchs-registration';
import { VERIFIED_REFERENCE } from '@/lib/safety/emergency-numbers';

const ID = 'cccccccc-3333-4333-8333-333333333333';

beforeEach(() => {
  m.submit.mockReset();
  // Профиль туриста, поиск маршрутов — не предмет проверки: аноним, пустые ответы.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));
  // Вход — той же ссылкой, что стоит на карточке маршрута, плюс даты плана.
  window.history.pushState({}, '', `${registerFormHref('Авачинский перевал')}&start=2027-07-19&end=2027-07-20`);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); window.history.pushState({}, '', '/'); });

/** Четыре шага формы руками человека; возвращает кнопку отправки. */
async function fillForm(): Promise<HTMLElement> {
  render(<RegisterRoutePage />);
  // Шаг 1 предзаполнен ссылкой: название и даты вводить не нужно.
  await waitFor(() => expect((screen.getByPlaceholderText('Авачинский перевал') as HTMLInputElement).value).toBe('Авачинский перевал'));
  fireEvent.click(screen.getByRole('button', { name: 'Далее' }));
  fireEvent.click(screen.getByRole('button', { name: 'Далее' }));
  const [leaderName, contactName] = screen.getAllByPlaceholderText('ФИО *');
  const [leaderPhone, contactPhone] = screen.getAllByPlaceholderText('Телефон *');
  fireEvent.change(leaderName!, { target: { value: 'Тест' } });
  fireEvent.change(leaderPhone!, { target: { value: '+70000000000' } });
  fireEvent.change(contactName!, { target: { value: 'Тест Контакт' } });
  fireEvent.change(contactPhone!, { target: { value: '+70000000001' } });
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Далее' }));
  fireEvent.click(screen.getByRole('checkbox'));
  return screen.getByRole('button', { name: /Включить контроль/ });
}

describe('экран после включения контроля', () => {
  it('запись есть, лист не дошёл — ссылка «Я вернулся» с номером записи всё равно на экране', async () => {
    m.submit.mockResolvedValue({ ok: true, registrationId: ID, sheet: null });
    const submit = await fillForm();
    expect(screen.queryByText('Контроль возвращения включён')).toBeNull();
    fireEvent.click(submit);

    await waitFor(() => expect(screen.getByText('Контроль возвращения включён')).toBeTruthy());
    expect(screen.getByRole('link', { name: 'Страница «Я вернулся»' }).getAttribute('href')).toBe(`/return?id=${ID}`);
    expect(document.body.textContent).toContain('Контрольное время: 2027-07-20 до 20:00.');
    expect(document.body.textContent).toContain(MCHS_RETURN_NOT_VIA_VEDAR);
    // Про лист — правда: не скачался, «скачан» экран не говорит.
    expect(document.body.textContent).toContain('Лист с данными группы не скачался');
    expect(document.body.textContent).not.toContain('отдан на скачивание');
    // Экран не выдаёт контроль Ведара за регистрацию в МЧС.
    expect(document.body.textContent).toContain('Это не регистрация в МЧС');
    // Телефоны — только справочная линия из реестра проверенных.
    const tels = [...document.querySelectorAll('a[href^="tel:"]')].map((a) => a.textContent);
    expect(tels).toEqual(VERIFIED_REFERENCE.map((n) => n.phone));

    // Ушло один раз и ровно то, что ввёл человек.
    expect(m.submit).toHaveBeenCalledTimes(1);
    expect(m.submit.mock.calls[0]![0]).toMatchObject({
      route_name: 'Авачинский перевал', start_date: '2027-07-19', end_date: '2027-07-20',
      leader_name: 'Тест', leader_phone: '+70000000000',
      emergency_contact_name: 'Тест Контакт', emergency_contact_phone: '+70000000001',
      emergency_contact_consent: true, accepted_disclaimer: true,
    });
  });

  it('лист дошёл — «отдан на скачивание», ссылка та же', async () => {
    const createObjectURL = vi.fn(() => 'blob:sheet');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    m.submit.mockResolvedValue({ ok: true, registrationId: ID, sheet: new Blob(['%PDF'], { type: 'application/pdf' }) });
    fireEvent.click(await fillForm());

    await waitFor(() => expect(screen.getByText('Контроль возвращения включён')).toBeTruthy());
    expect(click).toHaveBeenCalledTimes(1);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain('Лист с данными группы отдан на скачивание — это не бланк МЧС');
    expect(document.body.textContent).not.toContain('Лист с данными группы не скачался');
    expect(screen.getByRole('link', { name: 'Страница «Я вернулся»' }).getAttribute('href')).toBe(`/return?id=${ID}`);
  });

  it('запись не создана — экрана успеха и ссылки нет, отказ виден на форме', async () => {
    m.submit.mockResolvedValue({ ok: false, error: 'Контроль возвращения не включён. Отправьте ещё раз.' });
    fireEvent.click(await fillForm());

    await waitFor(() => expect(screen.getByText('Контроль возвращения не включён. Отправьте ещё раз.')).toBeTruthy());
    expect(screen.queryByText('Контроль возвращения включён')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Страница «Я вернулся»' })).toBeNull();
    // Форма осталась — человек может отправить ещё раз, не набирая всё заново.
    expect(screen.getByRole('button', { name: /Включить контроль/ })).toBeTruthy();
  });
});
