// @vitest-environment jsdom
/**
 * Сайт партнёра на его домене (fishingkam.ru, слово владельца 22.10) —
 * рендером, на данных той же формы, что отдаёт lib/partner-sites/load.
 *
 * Что держит сторож:
 *  - это витрина партнёра: его имя в шапке и в H1, без кнопки «Оплатить»
 *    (приём оплаты выключен 05.10) и без чужих туров;
 *  - туры — из базы: сроки, цена с единицей, группа, что входит и не входит;
 *    у каждого — заявка и ссылка на карточку тура на Ведаре АБСОЛЮТНАЯ
 *    (на домене партнёра относительный /catalog открыл бы Ведар под чужим
 *    адресом);
 *  - нет данных — нет блока (§4.0): без туров нет ни блока, ни пункта меню;
 *  - контакты без ссылки «на наш сайт» самого себя; реквизиты ООО на месте;
 *  - заявка с формы уходит с источником partner_site, и канал лида — сайт
 *    партнёра, а не спрос Ведара.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, within, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { PartnerSitePage, tourPriceText } from '@/components/partner-site/PartnerSitePage';
import type { PartnerSiteData } from '@/lib/partner-sites/load';
import type { PartnerSiteTourRow } from '@/lib/types/db-rows';
import { normalizeLeadChannel } from '@/lib/leads/channel';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const tour = (over: Partial<PartnerSiteTourRow>): PartnerSiteTourRow => ({
  id: '6', slug: 'osennyaya-rybalka', title: 'Осенняя рыбалка на кижуча', short_description: 'Кижуч, микижа, хариус.',
  base_price: '28000', price_unit: 'per_day_per_person', duration_type: 'day', multi_day_count: null,
  season_start: '25.08.2026', season_end: '30.10.2026', photos: ['/images/fishingkam/a.jpg'], tour_image: null,
  included: ['Размещение на базе', 'Сопровождение гида'], not_included: ['Трансфер до базы и обратно — отдельно, от 7 000 ₽'],
  min_participants: 5, max_participants: 10,
  ...over,
});

function data(over: Partial<PartnerSiteData['profile']> = {}, tours: PartnerSiteTourRow[] = [tour({})]): PartnerSiteData {
  return {
    profile: {
      id: '0aaa4f05-b479-418b-9d54-2b909783dfd7', slug: 'kamchatskaya-rybalka', name: 'Камчатская рыбалка', category: 'operator',
      description: 'Рыболовные туры на реке Камчатке.', short_description: 'Рыбалка на реке Камчатке круглый год.',
      hero_image: '/images/fishingkam/hero.jpg', logo_image: null,
      gallery: ['/images/fishingkam/1.jpg', '/images/fishingkam/2.jpg'],
      services: null,
      features: [{ icon: 'Home', title: 'База: двухэтажный корпус 400 м²', desc: 'Кухня и столовая на первом этаже.' }],
      faq: [{ q: 'Можно ли забрать пойманную рыбу?', a: 'Да, в рамках разрешённого объёма.' }],
      season_info: [{ season: 'Лето', months: 'Июнь — Июль', fish: 'Чавыча' }],
      reviews_data: null,
      contacts: {
        phone: '+79147822222', admin_name: 'Анатолий', phone_hours: 'Пн–Пт 09:00–19:00 по Камчатке',
        telegram_channel: 'https://t.me/KamFishing_41', website: 'https://fishingkam.ru',
      },
      location: null,
      legal_info: { companyName: 'ООО «Камчатская рыбалка»', inn: '4100050147', ogrn: '1244100000869' } as unknown as string,
      contact: null, rating: '0', review_count: '0', is_verified: false,
      registry_status: null, registry_number: null, registry_checked_at: null, created_at: '2026-07-01',
      ...over,
    },
    tours,
  };
}

function show(d: PartnerSiteData = data()) {
  return render(<PartnerSitePage data={d} host="fishingkam.ru" vedarBase="https://vedarai.ru" />);
}

describe('сайт партнёра — его витрина', () => {
  it('имя партнёра в шапке и в H1; оплаты нет', () => {
    show();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Камчатская рыбалка');
    expect(within(screen.getByRole('banner')).getByText('Камчатская рыбалка')).toBeTruthy();
    expect(screen.queryByText(/Оплатить/)).toBeNull();
    expect(screen.getByRole('link', { name: /Позвонить: \+7 914 782-22-22/ }).getAttribute('href')).toBe('tel:+79147822222');
  });

  it('группа тура не ограничена (1342) — «группа не ограничена», а не «5–10 чел.»', () => {
    show(data({}, [tour({ group_size_unlimited: true })]));
    const c = within(screen.getByRole('article', { name: 'Осенняя рыбалка на кижуча' }));
    expect(c.getByText('группа не ограничена')).toBeTruthy();
    expect(c.queryByText('группа 5–10 чел.')).toBeNull();
  });

  it('тур — из базы: сроки, цена с единицей, группа, состав; ссылка на Ведар абсолютная', () => {
    show();
    const card = screen.getByRole('article', { name: 'Осенняя рыбалка на кижуча' });
    const c = within(card);
    expect(c.getByText(/25\.08\.2026 — 30\.10\.2026/)).toBeTruthy();
    // Пробелы разрядов — неразрывные: сравнение по видимому тексту.
    const price = tourPriceText({ base_price: '28000', price_unit: 'per_day_per_person' }).replace(/\s/g, ' ');
    expect(price).toMatch(/^28 000 ₽ \S/);
    expect(c.getByText((_, el) => el?.tagName === 'P' && (el.textContent ?? '').replace(/\s/g, ' ') === price)).toBeTruthy();
    expect(c.getByText('группа 5–10 чел.')).toBeTruthy();
    expect(c.getByText('+ Размещение на базе')).toBeTruthy();
    expect(c.getByText('— Трансфер до базы и обратно — отдельно, от 7 000 ₽')).toBeTruthy();
    expect(c.getByRole('link', { name: /Свободные даты на Ведаре/ }).getAttribute('href'))
      .toBe('https://vedarai.ru/catalog/tours/osennyaya-rybalka');
    expect(c.getByRole('link', { name: 'Оставить заявку' }).getAttribute('href')).toBe('#zayavka');
  });

  it('цены нет — «по запросу», а не ноль', () => {
    show(data({}, [tour({ base_price: null })]));
    expect(screen.getByText('Цена по запросу')).toBeTruthy();
  });

  it('нет туров — нет ни блока, ни пункта меню', () => {
    show(data({}, []));
    expect(screen.queryByRole('heading', { name: 'Туры и цены' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Туры и цены' })).toBeNull();
  });

  it('база, календарь рыбы и частые вопросы — из профиля партнёра', () => {
    show();
    expect(screen.getByRole('heading', { name: 'База: двухэтажный корпус 400 м²' })).toBeTruthy();
    expect(screen.getByText('Июнь — Июль')).toBeTruthy();
    expect(screen.getByText('Чавыча')).toBeTruthy();
    expect(screen.getByText('Можно ли забрать пойманную рыбу?')).toBeTruthy();
  });

  it('контакты без ссылки на самого себя; реквизиты ООО; подвал — политика Ведара', () => {
    show();
    const contacts = within(screen.getByRole('region', { name: 'Контакты' }));
    expect(contacts.getByText('Пн–Пт 09:00–19:00 по Камчатке')).toBeTruthy();
    expect(contacts.getByRole('link', { name: 'Telegram-канал' }).getAttribute('href')).toBe('https://t.me/KamFishing_41');
    expect(contacts.queryByRole('link', { name: 'Сайт оператора' })).toBeNull();
    expect(screen.getByText(/ООО «Камчатская рыбалка»/)).toBeTruthy();
    expect(screen.getByText(/4100050147/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Политика обработки персональных данных' }).getAttribute('href'))
      .toBe('https://vedarai.ru/legal/privacy');
  });

  it('заявка уходит партнёру с источником partner_site; канал — сайт партнёра, не Ведар', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    show();
    const form = within(screen.getByRole('region', { name: 'Оставить заявку' }));
    fireEvent.change(form.getByLabelText('Имя'), { target: { value: 'Анна' } });
    fireEvent.change(form.getByLabelText('Телефон'), { target: { value: '+79990000000' } });
    fireEvent.click(form.getByRole('checkbox'));
    fireEvent.click(form.getByRole('button', { name: /Отправить оператору/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body) as Record<string, unknown>;
    expect(body.partner_slug).toBe('kamchatskaya-rybalka');
    expect(body.source_data).toEqual({ source: 'partner_site', partner_slug: 'kamchatskaya-rybalka' });
    expect(normalizeLeadChannel({ source_url: 'https://fishingkam.ru/', source_data: body.source_data as Record<string, unknown> }))
      .toBe('widget');
  });
});
