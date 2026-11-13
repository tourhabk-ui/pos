// @vitest-environment jsdom
/**
 * Блок о разрешении парка на карточке маршрута утверждает только то, что
 * подтверждает справочник (#3302, срез 6) — рендером.
 *
 * Перепись 13.11 (368 живых маршрутов): блок «Разрешение на посещение парка»
 * со словами «Нужны оба» стоял на 75 карточках, и у 52 справочник этого не
 * подтверждал. У 34 территория не записана вовсе — блок выводился из-за одной
 * регистрации в МЧС (SUP-маршрут у полуострова Завойко звал за разрешением
 * парка). У 16 территория названа, но её условий в базе нет — среди них
 * памятники природы в черте города. У 2 — федеральный заказник, где заявку
 * принимает Кроноцкий заповедник, а не краевое КГБУ.
 *
 * Решение владельца 19.09 «где нужна регистрация — там же и „Зелёная кнопка“»
 * остаётся: кнопка стоит на тех же карточках. Сторож держит СЛОВА: что блок
 * утверждает, а что говорит с условием (CLAUDE.md §4: рендер, не текст файла).
 */
import type React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import ParkPermitAction from '@/components/safety/ParkPermitAction';
import { FEDERAL_PERMIT_UNKNOWN_RU, GREEN_BUTTON, KRONOKI_REQUESTS, PARK_PERMIT_SOURCE } from '@/lib/safety/park-permit';
import { routePermitCase, routePermitLines, type ParkLookup, type ParkPermitRecord } from '@/lib/parks/route-permit';
import {
  permitCardCase, permitCardWording, webHref, ambiguousTerritoryRu,
  CONDITIONS_NOT_RECORDED_RU, CONDITIONS_UNREAD_RU, KGBU_IF_IN_PARK_RU, RECORDED_UNKNOWN_RU, TERRITORY_NOT_RECORDED_RU,
  type RoutePermitCardCase,
} from '@/lib/parks/route-permit-card';

const text = (el: HTMLElement) => (el.textContent ?? '').replace(/\s+/g, ' ').trim();
const hrefs = (el: HTMLElement) => [...el.querySelectorAll('a')].map((a) => a.getAttribute('href'));
/**
 * Текст и ссылки блока — снимком сразу после рендера: библиотека размонтирует
 * дерево после каждого теста, и поздний поиск по контейнеру видел бы пустоту.
 */
function shot(ui: React.ReactElement): { t: string; links: Array<string | null> } {
  const { container } = render(ui);
  return { t: text(container), links: hrefs(container) };
}

const record = (over: Partial<ParkPermitRecord> = {}): ParkPermitRecord => ({
  slug: 'park', displayName: 'Парк', permitUrl: null, email: null, officeAddress: null, officeHours: null,
  gosuslugiUrl: null, onlineUrl: null, ...over,
});
const KGBU: ParkLookup = { state: 'one', park: record({ slug: 'vilyuchinsky', displayName: 'Природный парк «Вилючинский»', permitUrl: PARK_PERMIT_SOURCE.url }) };

/** Случай карточки — тем же правилом, что считает сервер и ответ агенту. */
function caseOf(input: { title: string; parkName: string | null }, lookup: ParkLookup | null): RoutePermitCardCase {
  return permitCardCase(routePermitCase(input, lookup));
}

describe('парк подтверждён справочником — блок утверждает, как прежде', () => {
  const input = { title: 'Вилючинский водопад', parkName: 'Природный парк «Вилючинский»' };
  const { t, links } = shot(<ParkPermitAction {...input} permit={caseOf(input, KGBU)} />);

  it('заголовок, парк, «Зелёная кнопка» и «Нужны оба»', () => {
    expect(t).toContain('Разрешение на посещение парка');
    expect(t).toContain('Природный парк «Вилючинский»');
    expect(links).toContain(GREEN_BUTTON.androidUrl);
    expect(t).toContain('спасателям — сведения о группе. Нужны оба.');
  });
  it('условных слов нет: парк записан', () => {
    expect(t).not.toContain(KGBU_IF_IN_PARK_RU);
    expect(t).not.toContain(TERRITORY_NOT_RECORDED_RU);
    expect(t).not.toContain('В парке нужны оба');
  });
});

describe('территория у маршрута не записана — способы названы с условием', () => {
  const input = { title: 'SUP-маршрут Полуостров Завойко', parkName: null };
  const permit = caseOf(input, null);
  const { t, links } = shot(<ParkPermitAction {...input} permit={permit} />);

  it('случай — «территория не записана»', () => {
    expect(permit).toEqual({ kind: 'none' });
  });
  it('блок говорит, что территория не записана, и ставит условие «если маршрут идёт по парку»', () => {
    expect(t).toContain('Разрешение парка');
    expect(t).toContain(TERRITORY_NOT_RECORDED_RU);
    expect(t).toContain(KGBU_IF_IN_PARK_RU);
  });
  it('требования разрешения не утверждает: ни прежнего заголовка, ни безусловного «Нужны оба»', () => {
    expect(t).not.toContain('Разрешение на посещение парка');
    expect(t).toContain('спасателям — сведения о группе. В парке нужны оба.');
    expect(t).not.toMatch(/сведения о группе\. Нужны оба\./);
  });
  it('кнопка остаётся (решение владельца 19.09) вместе с остальными способами', () => {
    expect(links).toContain(GREEN_BUTTON.androidUrl);
    expect(t).toContain('Другие способы получить разрешение');
  });
});

describe('территория названа, условий её посещения в базе нет', () => {
  const input = { title: 'Сопка Никольская', parkName: 'памятник природы регионального значения «Сопка Никольская»' };
  const permit = caseOf(input, { state: 'none' });
  const { t } = shot(<ParkPermitAction {...input} permit={permit} />);

  it('названа территория и сказано «не записаны — не значит, что разрешение не нужно»', () => {
    expect(permit.kind).toBe('unrecorded');
    expect(t).toContain('памятник природы регионального значения «Сопка Никольская».');
    expect(t).toContain(CONDITIONS_NOT_RECORDED_RU);
  });
  it('способы КГБУ — с условием, а не утверждением', () => {
    expect(t).toContain(KGBU_IF_IN_PARK_RU);
    expect(t).not.toContain('Разрешение на посещение парка');
    expect(t).toContain('В парке нужны оба.');
  });
  it('те же слова о незаписанных условиях читает агент', () => {
    expect(routePermitLines(routePermitCase(input, { state: 'none' })).join('\n')).toContain(CONDITIONS_NOT_RECORDED_RU);
  });
  it('строка справочника без единого канала — тот же случай', () => {
    expect(caseOf(input, { state: 'one', park: record({ displayName: 'Сопка' }) }).kind).toBe('unrecorded');
  });
});

describe('справочник не прочитался — «не знаю», а не «условий нет»', () => {
  const input = { title: 'Тропа', parkName: 'Природный парк «Налычево»' };
  const permit = caseOf(input, { state: 'failed' });
  const { t } = shot(<ParkPermitAction {...input} permit={permit} />);

  it('сказано, что условия не прочитались, и это не «разрешение не нужно»', () => {
    expect(permit.kind).toBe('unread');
    expect(t).toContain(CONDITIONS_UNREAD_RU);
    expect(t).not.toContain(CONDITIONS_NOT_RECORDED_RU);
    expect(t).toContain(KGBU_IF_IN_PARK_RU);
  });
});

describe('у территории своя запись — её каналы, без «Зелёной кнопки»', () => {
  const input = { title: 'Остров Беринга', parkName: 'Командорские острова' };
  const park = record({
    slug: 'komandorskiy', displayName: 'Национальный парк «Командорские острова»',
    permitUrl: 'https://komandorsky.ru/visit', email: 'ohrana@example.org',
    officeAddress: 'с. Никольское, ул. Беринга, 18', officeHours: 'пн–пт 9:00–17:00',
  });
  const permit = caseOf(input, { state: 'one', park });
  const { t, links } = shot(<ParkPermitAction {...input} permit={permit} />);

  it('названа территория из справочника и её каналы', () => {
    expect(permit.kind).toBe('recorded');
    expect(t).toContain('Национальный парк «Командорские острова»');
    expect(links).toContain('https://komandorsky.ru/visit');
    expect(links).toContain('mailto:ohrana@example.org');
    expect(t).toContain('с. Никольское, ул. Беринга, 18 (пн–пт 9:00–17:00)');
  });
  it('требование разрешения не утверждается: справочник о нём не говорит', () => {
    expect(t).toContain(RECORDED_UNKNOWN_RU);
    expect(t).not.toContain('Нужны оба');
  });
  it('способов краевого КГБУ нет: ведомство другое', () => {
    expect(links).not.toContain(GREEN_BUTTON.androidUrl);
    expect(t).not.toContain(GREEN_BUTTON.name);
    expect(t).not.toContain('Другие способы получить разрешение');
  });
  it('ссылка согласования краевой сети чужому ведомству способов КГБУ не возвращает', () => {
    const withLink = shot(<ParkPermitAction {...input} parkApprovalUrl="https://example.org/approve" permit={permit} />);
    expect(withLink.links).not.toContain(GREEN_BUTTON.androidUrl);
    expect(withLink.t).toContain(RECORDED_UNKNOWN_RU);
  });
  it('адрес из справочника идёт в ссылку, только если это веб-адрес и почта', () => {
    const odd = caseOf(input, { state: 'one', park: record({ displayName: 'Парк', permitUrl: 'javascript:alert(1)', email: 'not an email', officeAddress: 'Офис' }) });
    const r = shot(<ParkPermitAction {...input} permit={odd} />);
    expect(r.links).toEqual([]);
    expect(r.t).toContain('Офис');
  });
});

describe('к названию территории подходят несколько записей', () => {
  const input = { title: 'Спорная тропа', parkName: 'Парк' };
  const permit = caseOf(input, { state: 'many', names: ['Парк А', 'Парк Б'] });
  const { t, links } = shot(<ParkPermitAction {...input} permit={permit} />);

  it('названы записи; способов и требования нет', () => {
    expect(permit.kind).toBe('ambiguous');
    expect(t).toContain(ambiguousTerritoryRu(['Парк А', 'Парк Б']));
    expect(links).toEqual([]);
    expect(t).not.toContain('Нужны оба');
  });
});

describe('парк в федеральном ведении — утверждение со своей оговоркой, как прежде', () => {
  const input = { title: 'Вулкан Горелый', parkName: 'Южно-Камчатский' };
  const { t, links } = shot(<ParkPermitAction {...input} permit={caseOf(input, null)} />);

  it('оговорка о ведении, «Зелёная кнопка» и «Нужны оба» — на месте; условных слов нет', () => {
    expect(t).toContain(FEDERAL_PERMIT_UNKNOWN_RU);
    expect(links).toContain(GREEN_BUTTON.androidUrl);
    expect(t).toContain('Нужны оба.');
    expect(t).not.toContain(KGBU_IF_IN_PARK_RU);
  });
});

describe('ссылка согласования маршрута — записанный факт: с ней блок утверждает', () => {
  it('пустая строка и чужая схема ссылкой не считаются: блок говорит с условием, ссылки нет', () => {
    const input = { title: 'Тропа', parkName: null };
    for (const bad of ['   ', 'javascript:alert(1)']) {
      const r = shot(<ParkPermitAction {...input} parkApprovalUrl={bad} permit={caseOf(input, null)} />);
      expect(r.t).toContain(KGBU_IF_IN_PARK_RU);
      expect(r.links.filter((h) => h === bad || (h ?? '').startsWith('javascript'))).toEqual([]);
      expect(r.t).not.toContain('Согласование маршрута');
    }
  });
  it('территория не записана, но согласование с дирекцией парка есть', () => {
    const input = { title: 'Тропа', parkName: null };
    const { t, links } = shot(
      <ParkPermitAction {...input} parkApprovalUrl="https://example.org/approve" permit={caseOf(input, null)} />,
    );
    expect(t).toContain('Разрешение на посещение парка');
    expect(t).toContain('Нужны оба.');
    expect(t).not.toContain(KGBU_IF_IN_PARK_RU);
    expect(links).toContain('https://example.org/approve');
  });
});

describe('заказник в обратном порядке слов — заявка в заповедник, а не КГБУ', () => {
  // Два маршрута переписи 13.11: «…заказник федерального значения „Южно-Камчатский“».
  const input = { title: 'Тропа к озеру', parkName: 'государственный природный заказник федерального значения «Южно-Камчатский»' };
  const { links } = shot(<ParkPermitAction {...input} permit={caseOf(input, null)} />);

  it('страница заявок заповедника; магазинов приложения КГБУ нет', () => {
    expect(caseOf(input, null).kind).toBe('kronoki');
    expect(links).toContain(KRONOKI_REQUESTS.url);
    expect(links).not.toContain(GREEN_BUTTON.androidUrl);
  });
  it('природный парк с тем же именем заказником не становится', () => {
    expect(caseOf({ title: 'Тропа', parkName: 'Природный парк «Южно-Камчатский»' }, null).kind).toBe('federal');
  });
});

describe('случай не передан — прежний вид (страница регистрации, старая офлайн-копия)', () => {
  it('без случая блок утверждает, как до среза', () => {
    const { t } = shot(<ParkPermitAction title="Тропа" parkName={null} />);
    expect(t).toContain('Разрешение на посещение парка');
    expect(t).toContain('Нужны оба.');
  });
});

describe('правило слов', () => {
  const none: RoutePermitCardCase = { kind: 'none' };
  it('парк КГБУ, федеральный парк и ссылка согласования — утверждение; иначе незаписанное — с условием', () => {
    expect(permitCardWording(none, { hasApprovalUrl: false })).toBe('conditional');
    expect(permitCardWording(none, { hasApprovalUrl: true })).toBe('asserted');
    expect(permitCardWording({ kind: 'kgbu' }, { hasApprovalUrl: false })).toBe('asserted');
    expect(permitCardWording({ kind: 'federal' }, { hasApprovalUrl: false })).toBe('asserted');
    expect(permitCardWording({ kind: 'unread', territory: 'X' }, { hasApprovalUrl: false })).toBe('conditional');
    expect(permitCardWording(null, { hasApprovalUrl: false })).toBe('asserted');
  });
  it('ссылкой считается только веб-адрес: пробелы и чужая схема — нет', () => {
    expect(webHref(' https://example.org/a ')).toBe('https://example.org/a');
    expect(webHref('   ')).toBeNull();
    expect(webHref('javascript:alert(1)')).toBeNull();
    expect(webHref(null)).toBeNull();
  });
  it('случай переживает JSON: карточка получает его ответом API и хранит офлайн', () => {
    const cases: RoutePermitCardCase[] = [
      { kind: 'none' }, { kind: 'kgbu' }, { kind: 'unrecorded', territory: 'Т' },
      { kind: 'ambiguous', territory: 'Т', names: ['А', 'Б'] }, { kind: 'recorded', park: record({ email: 'a@b.ru' }) },
    ];
    for (const c of cases) expect(JSON.parse(JSON.stringify(c))).toEqual(c);
    // У случаев по названию в форме карточки нет регулярных выражений — только род.
    expect(caseOf({ title: 'Курильское озеро', parkName: null }, null)).toEqual({ kind: 'kronoki' });
    expect(caseOf({ title: 'Вулкан Горелый', parkName: 'Южно-Камчатский' }, null)).toEqual({ kind: 'federal' });
  });
});
