/**
 * «Я вернулся» в Ведаре не сообщает в МЧС — и экраны говорят это словами. Рендером.
 *
 * Контролей два, и для человека они легко сливаются в один:
 *  - контроль возвращения Ведара — закрывается кнопкой «Я вернулся»;
 *  - контроль группы в МЧС — его ведёт МЧС по заявке человека, и Ведар туда не
 *    сообщает (docs/safety/WATCH_MANIFEST.md, правило 4).
 * Рамка на экране после включения контроля называлась «Сообщите о возвращении»
 * и говорила только о кнопке. Подавший заявку в МЧС нажимал её и считал, что
 * сообщил всем, — а группу в МЧС продолжали ждать.
 *
 * Держит: строка стоит и там, где человеку выдают ссылку «Я вернулся», и на
 * экране «С возвращением», то есть в ту минуту, когда он считает дело сделанным.
 * То же — у второй кнопки «Я вернулся» (кабинет туриста) и на экране «Возврат
 * уже отмечен», куда человек приходит по сохранённой ссылке во второй раз.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const nav = vi.hoisted(() => ({ id: 'aaaaaaaa-1111-4111-8111-111111111111' as string | null }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
  useSearchParams: () => ({ get: (k: string) => (k === 'id' ? nav.id : null) }),
}));
// Панель трекера — свой экран со своими запросами; здесь проверяется кнопка возвращения.
vi.mock('@/components/hub/TrackerLinkPanel', () => ({ TrackerLinkPanel: () => null }));

import TripWatchReturnBox from '@/components/safety/TripWatchReturnBox';
import MchsConsultPhones from '@/components/safety/MchsConsultPhones';
import ReturnClient from '@/app/return/ReturnClient';
import SafetyClient from '@/app/hub/tourist/safety/_SafetyClient';
import { MCHS_AFTER_RETURN, MCHS_PHONES, MCHS_RETURN_NOT_VIA_VEDAR, MCHS_RETURN_PHONE_UNKNOWN } from '@/lib/safety/mchs-registration';
import { VERIFIED_REFERENCE } from '@/lib/safety/emergency-numbers';

const ROUTE = {
  id: 'aaaaaaaa-1111-4111-8111-111111111111', name: 'Авачинский перевал', leader: 'Тест',
  start_date: '2027-07-19', end_date: '2027-07-20', completed: false, mchs_informed_at: null,
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('слова о двух контролях', () => {
  it('фраза говорит прямо: в МЧС Ведар не сообщает, туда человек сообщает сам', () => {
    expect(MCHS_RETURN_NOT_VIA_VEDAR).toContain('В МЧС Ведар не сообщает');
    expect(MCHS_RETURN_NOT_VIA_VEDAR).toContain('сообщаете вы сами');
    // Номера и обещаний за МЧС в ней нет.
    expect(MCHS_RETURN_NOT_VIA_VEDAR).not.toMatch(/\d{2}-\d{2}-\d{2}|снимет|узнает/);
  });
});

describe('рамка на экране после включения контроля', () => {
  it('ссылка «Я вернулся» с номером записи, контрольное время и строка про МЧС', () => {
    const { container } = render(<TripWatchReturnBox registrationId="r-42" endDate="2027-07-20" expectedReturnTime="18:30" />);
    expect(screen.getByRole('link', { name: 'Страница «Я вернулся»' }).getAttribute('href')).toBe('/return?id=r-42');
    expect(container.textContent).toContain('Контрольное время: 2027-07-20 в 18:30.');
    expect(container.textContent).toContain('Кнопка закрывает только контроль Ведара.');
    expect(container.textContent).toContain(MCHS_RETURN_NOT_VIA_VEDAR);
    // И почему это важно — словами памятки: группу в МЧС продолжат ждать.
    expect(container.textContent).toContain(MCHS_AFTER_RETURN);
    // Заголовок не обещает «сообщить о возвращении» вообще: отметка — в Ведаре.
    expect(container.textContent).toContain('Отметьте возвращение в Ведаре');
    expect(container.textContent).not.toContain('Сообщите о возвращении');
  });

  it('время не названо — контрольное время 20:00; кто получит тревогу, сказано', () => {
    const { container } = render(<TripWatchReturnBox registrationId="r-42" endDate="2027-07-20" expectedReturnTime="" />);
    expect(container.textContent).toContain('Контрольное время: 2027-07-20 до 20:00.');
    expect(container.textContent).toContain('тревога уйдёт вашему экстренному контакту');
    expect(container.textContent).toContain('Напоминание вам самим не придёт');
    // Тревога уходит контакту и дежурному Ведара, не в МЧС.
    expect(container.textContent).not.toMatch(/тревог[аи] (уйдёт|уходит) в МЧС/);
  });
});

describe('телефоны на экране после включения контроля', () => {
  it('только справочная линия из реестра проверенных; звонок — по её же номеру', () => {
    const { container } = render(<MchsConsultPhones />);
    const links = [...container.querySelectorAll('a[href^="tel:"]')];
    expect(links.map((a) => a.textContent)).toEqual(VERIFIED_REFERENCE.map((n) => n.phone));
    expect(links.map((a) => a.getAttribute('href'))).toEqual(VERIFIED_REFERENCE.map((n) => `tel:${n.phone.replace(/[^\d+]/g, '')}`));
    for (const n of VERIFIED_REFERENCE) expect(container.textContent).toContain(`${n.phone} — ${n.name}`);
    // Дежурные номера — не для вопросов по заявке: здесь их нет.
    for (const p of MCHS_PHONES.filter((x) => x.kind === 'duty')) expect(container.textContent).not.toContain(p.phone);
    // Чего Ведар не знает, сказано: номер для сообщения о возвращении не сверен.
    expect(container.textContent).toContain(MCHS_RETURN_PHONE_UNKNOWN);
  });

  it('номера вне реестра на экране нет (до 10.11 стоял 41-03-95 «ПСО КГКУ ЦОД»)', () => {
    const { container } = render(<MchsConsultPhones />);
    expect(container.textContent).not.toMatch(/41-03-95|ПСО|30-10-82/);
    expect(container.innerHTML).not.toContain('74152410395');
  });
});

describe('ссылка «Я вернулся» копируется — или экран говорит, что нет', () => {
  it('буфера обмена нет — «не скопировалось» сказано словами, а не молчанием', () => {
    vi.stubGlobal('navigator', {});
    render(<TripWatchReturnBox registrationId="r-42" endDate="2027-07-20" expectedReturnTime="" />);
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Копировать' }));
    expect(screen.getByRole('status').textContent).toContain('Ссылка не скопировалась');
  });

  it('буфер отказал — тоже сказано; скопировалось — «Скопировано» и полный адрес в буфере', async () => {
    const writeText = vi.fn(async () => { throw new Error('denied'); });
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    render(<TripWatchReturnBox registrationId="r-42" endDate="2027-07-20" expectedReturnTime="" />);
    fireEvent.click(screen.getByRole('button', { name: 'Копировать' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('не скопировалась'));
    cleanup();

    const ok = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText: ok } });
    render(<TripWatchReturnBox registrationId="r-42" endDate="2027-07-20" expectedReturnTime="" />);
    fireEvent.click(screen.getByRole('button', { name: 'Копировать' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Скопировано' })).toBeTruthy());
    expect(ok).toHaveBeenCalledWith(`${window.location.origin}/return?id=r-42`);
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('экран «С возвращением»', () => {
  const calls: Array<{ url: string; method: string }> = [];
  beforeEach(() => {
    calls.length = 0;
    nav.id = ROUTE.id;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url: String(url), method });
      if (method === 'GET') return new Response(JSON.stringify({ success: true, route: ROUTE }), { status: 200 });
      return new Response(JSON.stringify({ success: true, message: 'Контроль возвращения закрыт.' }), { status: 200 });
    }));
  });

  it('после «Я вернулся» экран говорит, что в МЧС Ведар не сообщил', async () => {
    render(<ReturnClient />);
    const button = await screen.findByRole('button', { name: /Я вернулся/ });
    // До нажатия контроль не закрыт и строки «С возвращением» нет.
    expect(screen.queryByText('С возвращением!')).toBeNull();
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByText('С возвращением!')).toBeTruthy());
    expect(screen.getByText('Контроль возвращения закрыт.')).toBeTruthy();
    expect(screen.getByText(MCHS_RETURN_NOT_VIA_VEDAR)).toBeTruthy();
    expect(screen.getByText(MCHS_AFTER_RETURN)).toBeTruthy();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET /api/safety/return?registration_id=${ROUTE.id}`,
      'POST /api/safety/return',
    ]);
  });

  it('отметка о беде названа звонком в 112 — её не спутать с сообщением в МЧС о возвращении', async () => {
    // «Вернулись — сообщите в МЧС» (памятка) и кнопка «Я сообщил в МЧС» читались
    // как одно: вернувшийся жал её вместо «Я вернулся», контроль оставался
    // открытым, и после срока уходила ложная тревога.
    render(<ReturnClient />);
    await screen.findByRole('button', { name: /Я вернулся/ });
    expect(screen.getByRole('button', { name: 'Мы в беде, я уже позвонил в 112' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /сообщил в МЧС/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Мы в беде, я уже позвонил в 112' }));
    await waitFor(() => expect(screen.getByText(/Отмечено: в 112 уже позвонили/)).toBeTruthy());
    // Отметка о беде контроль не закрывает: экрана «С возвращением» нет.
    expect(screen.queryByText('С возвращением!')).toBeNull();
    expect(calls.at(-1)).toEqual({ url: '/api/safety/mchs-informed', method: 'POST' });
  });

  it('экран без номера записи: закрывается контроль Ведара, в МЧС отметка не уходит', () => {
    nav.id = null;
    const { container } = render(<ReturnClient />);
    expect(container.textContent).toContain('закрывает контроль возвращения Ведара');
    expect(container.textContent).toContain(MCHS_RETURN_NOT_VIA_VEDAR);
    expect(container.textContent).not.toContain('искать вас не нужно');
  });

  it('контроль уже закрыт — экран называет, что закрыто, и что в МЧС Ведар не сообщал', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true, route: { ...ROUTE, completed: true } }), { status: 200 })));
    const { container } = render(<ReturnClient />);
    await waitFor(() => expect(screen.getByText('Возврат уже отмечен')).toBeTruthy());
    expect(container.textContent).toContain('Контроль возвращения Ведара по маршруту «Авачинский перевал» уже закрыт.');
    expect(screen.getByText(MCHS_RETURN_NOT_VIA_VEDAR)).toBeTruthy();
    // Закрыто — отмечать нечего: кнопок возвращения и беды здесь нет.
    expect(screen.queryByRole('button', { name: /Я вернулся/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /112/ })).toBeNull();
  });

  it('отказ сервера — экрана «С возвращением» нет, отказ виден на форме', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') return new Response(JSON.stringify({ success: true, route: ROUTE }), { status: 200 });
      return new Response(JSON.stringify({ success: false, error: 'Номер руководителя не совпал' }), { status: 403 });
    }));
    render(<ReturnClient />);
    fireEvent.click(await screen.findByRole('button', { name: /Я вернулся/ }));
    await waitFor(() => expect(screen.getByText('Номер руководителя не совпал')).toBeTruthy());
    expect(screen.queryByText('С возвращением!')).toBeNull();
    expect(screen.queryByText(MCHS_RETURN_NOT_VIA_VEDAR)).toBeNull();
  });
});

describe('кабинет туриста: вторая кнопка «Я вернулся»', () => {
  const REG = {
    id: 'bbbbbbbb-2222-4222-8222-222222222222', route_name: 'Авачинский перевал', region: null,
    start_date: '2027-07-19', end_date: '2027-07-20', expected_return_at: null,
    checkin_confirmed_at: null, completed_at: null, group_size: 2, leader_phone: '+70000000000',
    emergency_contact_name: null, emergency_contact_phone: null, control_at: '2027-07-20T08:00:00.000Z',
  };
  const list = (data: unknown[]) => vi.fn(async () => new Response(JSON.stringify({ success: true, data }), { status: 200 }));

  it('под кнопкой открытого контроля сказано: в МЧС Ведар не сообщает', async () => {
    vi.stubGlobal('fetch', list([REG]));
    const { container } = render(<SafetyClient />);
    const button = await screen.findByRole('button', { name: /Я вернулся/ });
    const card = button.parentElement!;
    expect(card.textContent).toContain('Кнопка закрывает только контроль Ведара.');
    expect(card.textContent).toContain(MCHS_RETURN_NOT_VIA_VEDAR);
    // Строка стоит после кнопки, а не в шапке страницы: её читают там, где жмут.
    const note = [...card.querySelectorAll('p')].find((p) => p.textContent?.includes(MCHS_RETURN_NOT_VIA_VEDAR))!;
    expect(button.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.textContent).not.toMatch(/сообщим в МЧС|передадим в МЧС/);
  });

  it('открытых контролей нет — строки про кнопку нет: нажимать нечего', async () => {
    vi.stubGlobal('fetch', list([{ ...REG, completed_at: '2027-07-20T07:00:00.000Z' }]));
    const { container } = render(<SafetyClient />);
    await waitFor(() => expect(container.textContent).toContain('Открытых контролей нет'));
    expect(screen.queryByRole('button', { name: /Я вернулся/ })).toBeNull();
    expect(container.textContent).not.toContain('Кнопка закрывает только контроль Ведара.');
  });

  it('список не загрузился — «не знаем, есть ли открытый срок», а не «контролей нет»', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: false }), { status: 503 })));
    const { container } = render(<SafetyClient />);
    await waitFor(() => expect(container.textContent).toContain('Не удалось загрузить контроли возвращения'));
    expect(container.textContent).toContain('мы не знаем, есть ли у вас открытый срок');
    expect(container.textContent).not.toContain('Открытых контролей нет');
  });
});
