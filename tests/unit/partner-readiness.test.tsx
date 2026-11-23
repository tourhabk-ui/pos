/**
 * Чек-лист готовности партнёра (план готовности 23.11, этап 3c).
 *
 * Один модуль на все кабинеты: правило — lib/partners/readiness, карточка —
 * components/hub/PartnerReadinessCard. Судится поведение, а не текст файла:
 *   - правило: пункты по роли, четыре состояния, «готов» только при закрытых
 *     обязательных пунктах, «не смог проверить» не равно «готов»;
 *   - слова: ни выплат, ни сроков, ни тарифов, ни текста оферты;
 *   - карточка: что видит человек в каждом исходе чтения;
 *   - шесть кабинетов: карточка отрисована на главной каждой роли.
 *
 * Чтение из базы на настоящем PostgreSQL —
 * tests/integration/partner-readiness.pg.test.ts.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import {
  buildReadiness, isReadinessCategory,
  type CardFacts, type ContentFacts, type ItemKey, type PartnerReadiness, type ReadinessCategory, type ReadinessFacts,
} from '@/lib/partners/readiness';
import { REQUEST_RECEIVING_CATEGORIES } from '@/lib/partners/categories';
import { LEGAL_PENDING, OFFER_VERSION } from '@/lib/legal/offer';
import { PartnerReadinessCard } from '@/components/hub/PartnerReadinessCard';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/hub',
  useSearchParams: () => new URLSearchParams(),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const CARD_OK: CardFacts = { profileStatus: 'approved', onboardingCompleted: true, onStorefront: true, isTest: false };
const CARD_NEW: CardFacts = { profileStatus: 'none', onboardingCompleted: false, onStorefront: false, isTest: false };
const CONTENT_OK: ContentFacts = { total: 2, live: 1, pending: 0 };
const CONTENT_NONE: ContentFacts = { total: 0, live: 0, pending: 0 };

/** Оферта принята в действующей редакции — как у всякого, кто регистрировался с отметкой. */
const OFFER_OK = { version: OFFER_VERSION, current: true, acceptedAt: '2026-11-23T02:00:00.000Z' };
const OFFER_OLD = { version: '2025-01-01', current: false, acceptedAt: '2025-02-01T00:00:00.000Z' };

function facts(category: ReadinessCategory, over: Partial<ReadinessFacts> = {}): ReadinessFacts {
  return {
    category, viewer: 'owner', card: CARD_OK, channel: 'connected', content: CONTENT_OK, canEditRental: false,
    offer: OFFER_OK, ...over,
  };
}
const item = (r: PartnerReadiness, key: ItemKey) => r.items.find((i) => i.key === key);
const CATEGORIES = [...REQUEST_RECEIVING_CATEGORIES];

describe('правило готовности', () => {
  it('чек-лист есть у тех, кому приходят заявки; агенту — нет', () => {
    for (const c of CATEGORIES) expect(isReadinessCategory(c), c).toBe(true);
    expect(isReadinessCategory('agent')).toBe(false);
    expect(isReadinessCategory('restaurant')).toBe(false);
    expect(isReadinessCategory(undefined)).toBe(false);
  });

  it.each(CATEGORIES)('%s: всё закрыто — готов', (category) => {
    const r = buildReadiness(facts(category));
    expect(r.verdict).toBe('ready');
    expect(r.headline).toBe('Готовы принимать заявки');
    expect(r.urgent).toBe(false);
  });

  it.each(CATEGORIES)('%s: новый партнёр — не готов, и названо, сколько шагов за ним', (category) => {
    const r = buildReadiness(facts(category, { card: CARD_NEW, channel: 'not_connected', content: CONTENT_NONE }));
    expect(r.verdict).toBe('not_ready');
    const todo = r.items.filter((i) => i.required && i.state === 'todo').length;
    // У проката вне пилота прайс заводит администратор: шаг за партнёром один — канал.
    expect(todo).toBeGreaterThanOrEqual(1);
    expect(r.headline).toBe(`До приёма заявок осталось шагов: ${todo}`);
    expect(item(r, 'storefront')?.state).toBe('waiting');
  });

  it('пункт «профиль» есть только у ролей, где есть такая дверь', () => {
    for (const c of ['operator', 'guide', 'stay', 'gear'] as const) {
      expect(item(buildReadiness(facts(c)), 'profile'), c).toBeDefined();
    }
    for (const c of ['transfer', 'cars'] as const) {
      expect(item(buildReadiness(facts(c)), 'profile'), c).toBeUndefined();
    }
  });

  it.each(CATEGORIES)('%s: «не смог проверить» обязательный пункт не закрывает', (category) => {
    for (const over of [{ card: null }, { channel: 'unknown' as const }, { content: null }]) {
      const r = buildReadiness(facts(category, over));
      // Гиду свои туры не обязательны: непрочитанные туры его готовность не меняют.
      const optional = category === 'guide' && 'content' in over;
      expect(r.verdict, JSON.stringify(over)).toBe(optional ? 'ready' : 'unknown');
      if (!optional) expect(r.headline).toBe('Готовность проверить не удалось');
    }
  });

  it('известный невыполненный шаг сильнее неизвестного', () => {
    const r = buildReadiness(facts('operator', { card: null, channel: 'not_connected' }));
    expect(r.verdict).toBe('not_ready');
  });

  it('на витрине без канала — тревога: заявки оставляют, а партнёр о них не узнаёт', () => {
    for (const category of CATEGORIES) {
      const r = buildReadiness(facts(category, { channel: 'not_connected' }));
      expect(r.verdict, category).toBe('not_ready');
      expect(r.urgent, category).toBe(true);
      expect(r.headline).toBe('Заявки до вас не доходят: не подключён ни MAX, ни Telegram');
    }
    // Не на витрине — обычный шаг, не тревога.
    const calm = buildReadiness(facts('operator', { card: { ...CARD_OK, onStorefront: false }, channel: 'not_connected' }));
    expect(calm.urgent).toBe(false);
  });

  it('шаги партнёра выполнены, витрина за администратором — так и сказано', () => {
    const r = buildReadiness(facts('stay', { card: { ...CARD_OK, onStorefront: false } }));
    expect(r.verdict).toBe('not_ready');
    expect(r.headline).toBe('Ваши шаги выполнены. Заявки пойдут, когда карточка выйдет на витрину');
    expect(item(r, 'storefront')?.detail).toBe('На витрину карточку ставит администратор платформы.');
  });

  it('витрина без канала: сказано, что администратор поставить карточку не может', () => {
    const r = buildReadiness(facts('gear', { card: { ...CARD_OK, onStorefront: false }, channel: 'not_connected' }));
    expect(item(r, 'storefront')?.detail).toContain('Без подключённого MAX или Telegram');
  });

  it('тестовый профиль готовым не бывает', () => {
    const r = buildReadiness(facts('operator', { card: { ...CARD_OK, onStorefront: false, isTest: true } }));
    expect(r.verdict).toBe('not_ready');
    expect(item(r, 'storefront')?.detail).toContain('тестовый профиль');
  });

  describe('профиль и заявка на проверку', () => {
    const status = (category: 'operator' | 'guide', profileStatus: string, viewer: 'owner' | 'manager' = 'owner') =>
      item(buildReadiness(facts(category, { viewer, card: { ...CARD_OK, profileStatus, onStorefront: false } })), 'profile');

    it('оператор: не подана — шаг за ним; подана и одобрена — готово', () => {
      expect(status('operator', 'none')).toMatchObject({ state: 'todo', href: '/hub/operator/onboarding' });
      expect(status('operator', 'pending')?.state).toBe('done');
      expect(status('operator', 'approved')?.state).toBe('done');
    });

    it('менеджеру компании шаг владельца не предлагается', () => {
      const p = status('operator', 'none', 'manager');
      expect(p?.state).toBe('todo');
      expect(p?.href).toBeUndefined();
      expect(p?.detail).toBe('Заявку на проверку отправляет владелец кабинета.');
    });

    it('оператор отклонён: повторной отправки из кабинета нет — её не обещают', () => {
      const p = status('operator', 'rejected');
      expect(p?.state).toBe('waiting');
      expect(p?.href).toBeUndefined();
      expect(p?.detail).toContain('свяжитесь с администратором');
    });

    it('гид отклонён: исправить и отправить снова можно — дверь есть', () => {
      expect(status('guide', 'rejected')).toMatchObject({ state: 'todo', href: '/hub/guide/profile' });
      expect(status('guide', 'none')).toMatchObject({ state: 'todo', href: '/hub/guide/profile' });
    });

    it('статус вне списка — «неизвестен», а не «готово»', () => {
      expect(status('operator', 'archived')?.state).toBe('unknown');
    });

    it('жильё и снаряжение: настройка кабинета', () => {
      const of = (category: 'stay' | 'gear', done: boolean) =>
        item(buildReadiness(facts(category, { card: { ...CARD_OK, onboardingCompleted: done } })), 'profile');
      expect(of('stay', false)).toMatchObject({ state: 'todo', href: '/hub/stay/onboarding' });
      expect(of('gear', false)).toMatchObject({ state: 'todo', href: '/hub/gear/onboarding' });
      expect(of('stay', true)?.state).toBe('done');
    });
  });

  describe('содержимое по роли', () => {
    const content = (category: ReadinessCategory, c: ContentFacts, canEditRental = false) =>
      item(buildReadiness(facts(category, { content: c, canEditRental })), 'content');

    it('оператор: черновик считается; числа названы как есть', () => {
      expect(content('operator', { total: 1, live: 0, pending: 0 })).toMatchObject({
        state: 'done', detail: 'Туров в кабинете: 1, на сайте: 0.',
      });
      expect(content('operator', CONTENT_NONE)).toMatchObject({ state: 'todo', href: '/hub/operator/tours/new' });
    });

    it('гиду свои туры не обязательны', () => {
      const none = content('guide', CONTENT_NONE);
      expect(none).toMatchObject({ state: 'todo', required: false });
      expect(buildReadiness(facts('guide', { content: CONTENT_NONE })).verdict).toBe('ready');
    });

    it('жильё и снаряжение: объект заведён; сколько на проверке — сказано', () => {
      expect(content('stay', { total: 2, live: 1, pending: 1 })?.detail).toBe('Объектов: 2, на сайте: 1, на проверке: 1.');
      expect(content('stay', CONTENT_NONE)).toMatchObject({ state: 'todo', href: '/hub/stay/accommodations/new' });
      expect(content('gear', CONTENT_NONE)).toMatchObject({ state: 'todo', href: '/hub/gear/inventory' });
    });

    it('перевозчик: живая строка — готово; новая строка на проверке — ждём; пусто — шаг за ним', () => {
      expect(content('transfer', { total: 1, live: 1, pending: 0 })?.state).toBe('done');
      expect(content('transfer', { total: 1, live: 0, pending: 1 })?.state).toBe('waiting');
      expect(content('transfer', CONTENT_NONE)).toMatchObject({ state: 'todo', href: '/hub/carrier' });
    });

    it('прокат: вне пилота прайс заводит администратор — кнопки нет; в пилоте шаг за партнёром', () => {
      const outside = content('cars', CONTENT_NONE, false);
      expect(outside?.state).toBe('waiting');
      expect(outside?.href).toBeUndefined();
      expect(content('cars', CONTENT_NONE, true)).toMatchObject({ state: 'todo', href: '/hub/carrier/rental' });
      expect(content('cars', { total: 1, live: 1, pending: 0 }, false)?.state).toBe('done');
    });
  });

  describe('оферта и слова', () => {
    const everything = (): PartnerReadiness[] => {
      const out: PartnerReadiness[] = [];
      const cards: Array<CardFacts | null> = [
        null, CARD_OK, CARD_NEW,
        { ...CARD_OK, profileStatus: 'pending', onStorefront: false },
        { ...CARD_OK, profileStatus: 'rejected', onStorefront: false },
        { ...CARD_OK, onStorefront: false, isTest: true },
      ];
      const contents: Array<ContentFacts | null> = [null, CONTENT_OK, CONTENT_NONE, { total: 1, live: 0, pending: 1 }];
      for (const category of CATEGORIES) for (const card of cards) for (const content of contents) {
        for (const channel of ['connected', 'not_connected', 'unknown'] as const) {
          for (const viewer of ['owner', 'manager'] as const) {
            for (const offer of [null, OFFER_OK, OFFER_OLD, 'unknown'] as const) {
              out.push(buildReadiness({ category, viewer, card, channel, content, canEditRental: false, offer }));
            }
          }
        }
      }
      return out;
    };

    it('оферта: принята — «готово» с редакцией и датой; не принята — шаг владельца, заявкам не мешает', () => {
      const offer = (over: Partial<ReadinessFacts>) => item(buildReadiness(facts('operator', over)), 'offer');
      expect(offer({ offer: OFFER_OK })).toEqual({
        key: 'offer', title: 'Оферта для партнёров', required: false, href: '/legal/offer', state: 'done',
        // 02:00 UTC — это 14:00 того же дня по Камчатке.
        detail: 'Принята редакция от 5 октября 2026 г., отметка от 23.11.2026.',
      });
      // Карточка заведена до отметки: акцепта в журнале нет.
      const none = offer({ offer: null });
      expect(none).toMatchObject({ state: 'todo', required: false, action: 'accept_offer', href: '/legal/offer' });
      expect(none?.detail).toBe('Отметки о принятии оферты нет: карточка заведена до того, как отметка появилась. '
        + 'Заявкам это не мешает. Прочитайте оферту и примите её здесь.');
      // Прежняя редакция — тоже шаг, и сказано, какая действует.
      expect(offer({ offer: OFFER_OLD })?.detail).toContain('Вы принимали прежнюю редакцию оферты. Действует редакция от 5 октября 2026 г.');
      expect(offer({ offer: OFFER_OLD })).toMatchObject({ state: 'todo', action: 'accept_offer' });
      // Менеджер команды оферту за компанию не принимает: кнопки нет.
      const manager = offer({ offer: null, viewer: 'manager' });
      expect(manager).toMatchObject({ state: 'waiting', required: false });
      expect(manager?.action).toBeUndefined();
      expect(manager?.detail).toContain('Принять оферту может владелец кабинета.');
      // Журнал не прочитан — «не проверено», а не «не принята».
      expect(offer({ offer: 'unknown' })).toMatchObject({ state: 'unknown', required: false });
      expect(offer({ offer: 'unknown' })?.action).toBeUndefined();
    });

    it('оферта готовность не держит: вердикт и заголовок от неё не зависят', () => {
      for (const category of CATEGORIES) {
        const verdicts = ([null, OFFER_OK, OFFER_OLD, 'unknown'] as const).map((offer) => {
          const r = buildReadiness(facts(category, { offer }));
          return `${r.verdict}|${r.headline}|${r.urgent}`;
        });
        expect(new Set(verdicts).size, category).toBe(1);
        expect(verdicts[0]).toBe('ready|Готовы принимать заявки|false');
      }
      for (const r of everything()) expect(item(r, 'offer')?.required).toBe(false);
    });

    it('самозанятые и соглашение по данным — только пометка ожидания, без условий', () => {
      // Гиду (роль, где самозанятые встречаются чаще) сказано прямо, что вопрос не решён.
      for (const offer of [null, OFFER_OK, OFFER_OLD] as const) {
        expect(item(buildReadiness(facts('guide', { offer })), 'offer')?.detail).toContain(LEGAL_PENDING.selfEmployed);
        expect(item(buildReadiness(facts('operator', { offer })), 'offer')?.detail).not.toContain('самозанят');
      }
      for (const r of everything()) {
        const dpa = item(r, 'data_agreement');
        expect(dpa).toEqual({
          key: 'data_agreement', title: 'Соглашение об обработке данных туристов', required: false, state: 'waiting',
          detail: LEGAL_PENDING.dataAgreement,
        });
      }
      for (const text of Object.values(LEGAL_PENDING)) {
        expect(text).toContain('ждёт решения владельца платформы и юриста');
        expect(text).not.toMatch(/обязу|вправе|должен|штраф|ответственн|срок|рубл|процент/i);
      }
    });

    it('ни в одном исходе нет обещаний: выплат, сроков, тарифов, комиссии', () => {
      const banned = /выплат|комисси|бесплатн|тариф|месяц|рубл|₽|процент|%|гарант|договор|самозанят/i;
      for (const r of everything()) {
        // Самозанятые названы в одном месте — в пометке «ждёт решения» (тест выше);
        // сверх неё этого слова в чек-листе быть не должно.
        const text = [r.headline, ...r.items.flatMap((i) => [i.title, i.detail])].join(' ')
          .split(LEGAL_PENDING.selfEmployed).join('');
        expect(text).not.toMatch(banned);
      }
    });

    it('ссылка есть только там, где шаг за партнёром, и у оферты', () => {
      for (const r of everything()) {
        for (const i of r.items) {
          if (i.href && i.key !== 'offer') expect(i.state, `${r.category}/${i.key}`).toBe('todo');
        }
      }
    });
  });
});

// ─── Карточка ─────────────────────────────────────────────────────────────────

function stubReadiness(reply: { status?: number; body?: unknown; fail?: boolean }, extra: Record<string, unknown> = {}) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(String(url));
    if (String(url) === '/api/hub/partner/readiness') {
      if (reply.fail) throw new Error('сеть');
      return new Response(JSON.stringify(reply.body ?? null), { status: reply.status ?? 200 });
    }
    return new Response(JSON.stringify(extra[String(url)] ?? { success: true, data: {} }), { status: 200 });
  }));
  return calls;
}
const okBody = (data: PartnerReadiness | null) => ({ success: true, data });

describe('карточка готовности', () => {
  it('не готов: заголовок, каждый пункт со словом состояния, ссылка у шага партнёра', async () => {
    const data = buildReadiness(facts('operator', { card: CARD_NEW, channel: 'not_connected', content: CONTENT_NONE }));
    stubReadiness({ body: okBody(data) });
    render(<PartnerReadinessCard />);
    expect(await screen.findByRole('heading', { name: 'До приёма заявок осталось шагов: 3' })).toBeTruthy();
    const rows = screen.getAllByRole('listitem');
    expect(rows.map((r) => r.getAttribute('data-key'))).toEqual(['profile', 'channel', 'content', 'storefront', 'offer', 'data_agreement']);
    const profile = rows[0];
    expect(within(profile).getByText('За вами')).toBeTruthy();
    expect(within(profile).getByRole('link', { name: /Перейти/ }).getAttribute('href')).toBe('/hub/operator/onboarding');
    const storefront = rows[3];
    expect(within(storefront).getByText('Ждёт не вас')).toBeTruthy();
    expect(within(storefront).queryByRole('link')).toBeNull();
    const offer = rows[4];
    expect(within(offer).getByText('не обязательно')).toBeTruthy();
    expect(within(offer).getByRole('link', { name: /Читать/ }).getAttribute('href')).toBe('/legal/offer');
    // Соглашение по данным — пометка ожидания: ни ссылки, ни кнопки, ни галочки.
    const dpa = rows[5];
    expect(within(dpa).getByText('Ждёт не вас')).toBeTruthy();
    expect(within(dpa).queryByRole('link')).toBeNull();
    expect(within(dpa).queryByRole('checkbox')).toBeNull();
    expect(within(dpa).queryByRole('button')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('оферта не принята: отметка и кнопка в чек-листе; без отметки кнопка не нажимается; принял — чек-лист перечитан', async () => {
    const notAccepted = buildReadiness(facts('operator', { offer: null }));
    const posts: unknown[] = [];
    let reads = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      if (String(url) === '/api/hub/partner/offer') {
        posts.push({ method: init?.method, body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ success: true, data: { version: OFFER_VERSION } }));
      }
      reads += 1;
      return new Response(JSON.stringify(okBody(reads === 1 ? notAccepted : buildReadiness(facts('operator')))));
    }));
    render(<PartnerReadinessCard />);
    const box = within(await screen.findByTestId('accept-offer'));
    const button = box.getByRole('button', { name: 'Принять оферту' });
    expect(button).toHaveProperty('disabled', true);
    expect(box.getByText('Чтобы принять, поставьте отметку.')).toBeTruthy();
    // Ссылка на саму оферту — в подписи отметки.
    expect(box.getByRole('link', { name: 'оферты для партнёров' }).getAttribute('href')).toBe('/legal/offer');
    fireEvent.click(box.getByRole('checkbox'));
    expect(button).toHaveProperty('disabled', false);
    fireEvent.click(button);
    await waitFor(() => expect(posts).toEqual([{ method: 'POST', body: { offer_accepted: true } }]));
    // Чек-лист перечитан: пункт стал «готово», кнопки больше нет.
    await waitFor(() => expect(screen.queryByTestId('accept-offer')).toBeNull());
    expect(reads).toBe(2);
    expect(screen.getByText(/Принята редакция от 5 октября 2026 г\./)).toBeTruthy();
  });

  it('оферта не принята: отказ сервера показан словами, отметка не сброшена', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url) === '/api/hub/partner/offer') {
        return new Response(JSON.stringify({ success: false, error: 'Принять оферту может владелец кабинета' }), { status: 403 });
      }
      return new Response(JSON.stringify(okBody(buildReadiness(facts('operator', { offer: null })))));
    }));
    render(<PartnerReadinessCard />);
    const box = within(await screen.findByTestId('accept-offer'));
    fireEvent.click(box.getByRole('checkbox'));
    fireEvent.click(box.getByRole('button', { name: 'Принять оферту' }));
    expect((await box.findByRole('alert')).textContent).toBe('Принять оферту может владелец кабинета');
    expect(box.getByRole('checkbox')).toHaveProperty('checked', true);
  });

  it('готов: сказано прямо, пункты свёрнуты, но не спрятаны', async () => {
    stubReadiness({ body: okBody(buildReadiness(facts('stay'))) });
    const view = render(<PartnerReadinessCard />);
    expect(await screen.findByRole('heading', { name: 'Готовы принимать заявки' })).toBeTruthy();
    const details = view.container.querySelector('details');
    expect(details).not.toBeNull();
    expect(details?.hasAttribute('open')).toBe(false);
    expect(within(details as HTMLElement).getAllByRole('listitem').length).toBeGreaterThanOrEqual(4);
    expect(view.container.querySelector('section')?.getAttribute('data-verdict')).toBe('ready');
  });

  it('на витрине без канала — тревога, а не строка в списке', async () => {
    stubReadiness({ body: okBody(buildReadiness(facts('transfer', { channel: 'not_connected' }))) });
    render(<PartnerReadinessCard />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Заявки до вас не доходят: не подключён ни MAX, ни Telegram');
  });

  it('не проверено — так и сказано, «готов» не показан', async () => {
    stubReadiness({ body: okBody(buildReadiness(facts('gear', { content: null }))) });
    render(<PartnerReadinessCard />);
    expect(await screen.findByRole('heading', { name: 'Готовность проверить не удалось' })).toBeTruthy();
    expect(screen.getByText('Не проверено')).toBeTruthy();
    expect(screen.queryByText('Готовы принимать заявки')).toBeNull();
  });

  it('роли без чек-листа (агент) карточка не рисуется', async () => {
    const calls = stubReadiness({ body: okBody(null) });
    const view = render(<PartnerReadinessCard />);
    // Пока ответа нет, стоит заглушка загрузки; после — не остаётся ничего.
    expect(view.container.childElementCount).toBe(1);
    await waitFor(() => expect(calls).toContain('/api/hub/partner/readiness'));
    await waitFor(() => expect(view.container.childElementCount).toBe(0));
  });

  it('вход не партнёра (403) — карточки нет, и о сбое не сказано', async () => {
    stubReadiness({ status: 403, body: { success: false, error: 'Раздел доступен партнёрам платформы' } });
    const view = render(<PartnerReadinessCard />);
    await waitFor(() => expect(view.container.childElementCount).toBe(0));
    expect(screen.queryByText(/не загрузился/)).toBeNull();
  });

  it.each([
    ['сервер ответил 503', { status: 503, body: { success: false } }],
    ['сеть не ответила', { fail: true }],
    ['ответ не той формы', { body: { success: true, data: { verdict: 'ready' } } }],
    ['неизвестный итог', { body: { success: true, data: { verdict: 'maybe', headline: 'x', items: [] } } }],
  ])('не загрузился (%s) — сказано строкой, «готов» не показан', async (_name, reply) => {
    stubReadiness(reply);
    render(<PartnerReadinessCard />);
    expect(await screen.findByText(/Чек-лист готовности к заявкам не загрузился/)).toBeTruthy();
    expect(screen.queryByText('Готовы принимать заявки')).toBeNull();
  });
});

// ─── Шесть кабинетов ──────────────────────────────────────────────────────────

const DASH = {
  moneyHidden: true,
  metrics: {
    totalTours: 0, activeTours: 0, totalBookings: 0, pendingBookings: 0,
    confirmedBookings: 0, completedBookings: 0, cancelledBookings: 0,
    totalRevenue: null, monthlyRevenue: null, paidRevenue: null, paidRevenueMonth: null,
    averageRating: null, totalReviews: 0, newLeadsToday: 0, newLeadsWeek: 0, unprocessedLeads: 0,
  },
  recentBookings: [], topTours: [], revenueChart: [], bookingsChart: [], upcomingTours: [],
};
const ONBOARDED = { success: true, data: { partner: { id: 'p1', name: 'Тест', description: null, contact: null, onboarding_completed: true } } };

const CABINETS: Array<{ name: string; category: ReadinessCategory; load: () => Promise<{ default: React.ComponentType }>; extra: Record<string, unknown> }> = [
  {
    name: 'оператор', category: 'operator',
    load: () => import('@/app/hub/operator/_OperatorDashboardClient'),
    extra: { '/api/operator/dashboard?period=30': { success: true, data: DASH } },
  },
  {
    name: 'гид', category: 'guide',
    load: () => import('@/app/hub/guide/_GuideDashboardClient'),
    extra: { '/api/partners/profile': ONBOARDED },
  },
  {
    name: 'жильё', category: 'stay',
    load: () => import('@/app/hub/stay/_StayDashboardClient'),
    extra: {
      '/api/partners/profile': ONBOARDED,
      '/api/stay/stats': {
        success: true,
        data: {
          accommodations: { total: 0, active: 0 },
          bookings: { total: 0, pending: 0, confirmed: 0, completed: 0, cancelled: 0, noShow: 0, upcomingCheckins: 0 },
          bookingSums: { atCheckIn: 0, completed: 0 },
        },
      },
    },
  },
  {
    name: 'снаряжение', category: 'gear',
    load: () => import('@/app/hub/gear/_GearDashboardClient'),
    extra: { '/api/partners/profile': ONBOARDED },
  },
  {
    name: 'перевозчик', category: 'transfer',
    load: () => import('@/app/hub/carrier/_CarrierClient'),
    extra: {},
  },
  {
    name: 'прокат автомобилей', category: 'cars',
    load: () => import('@/app/hub/carrier/rental/_RentalClient'),
    extra: {
      '/api/hub/carrier/rental': {
        success: true,
        data: { partnerName: 'Тест', canWrite: false, cars: [], requests: [], olderRequests: false, edits: [] },
      },
    },
  },
];

describe('чек-лист виден на главной кабинета каждой роли', () => {
  it.each(CABINETS)('$name', async ({ category, load, extra }) => {
    const data = buildReadiness(facts(category, { card: CARD_NEW, channel: 'not_connected', content: CONTENT_NONE }));
    const calls = stubReadiness({ body: okBody(data) }, extra);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { default: Cabinet } = await load();
    render(<Cabinet />);
    expect(await screen.findByText('Готовность к заявкам', undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByRole('heading', { name: data.headline })).toBeTruthy();
    expect(calls.filter((u) => u === '/api/hub/partner/readiness')).toHaveLength(1);
    errors.mockRestore();
  });

  it('у оператора один чек-лист: прежней панели «Первые шаги» нет', async () => {
    const data = buildReadiness(facts('operator', { card: CARD_NEW, channel: 'not_connected', content: CONTENT_NONE }));
    stubReadiness({ body: okBody(data) }, { '/api/operator/dashboard?period=30': { success: true, data: DASH } });
    const { default: Cabinet } = await import('@/app/hub/operator/_OperatorDashboardClient');
    render(<Cabinet />);
    await screen.findByText('Готовность к заявкам');
    await waitFor(() => expect(screen.queryByText('Загрузка данных...')).toBeNull());
    expect(screen.queryByText('Первые шаги')).toBeNull();
    expect(screen.queryByText('Добавить даты проведения')).toBeNull();
  });
});
