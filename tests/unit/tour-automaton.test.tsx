/**
 * Автомат предлагает правку тура (слово владельца 23.11): «Автоматы (кроны
 * описаний и фото, импортёры) пишут в туры только через очередь проверки,
 * своих обходных путей у них нет».
 *
 * Здесь — правила пометок «кто предложил поле» вызовом, строка диффа и
 * сообщение владельцу рендером и вызовом. Дверь на схеме прода судит
 * tests/integration/tour-automaton.pg.test.ts.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import React from 'react';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  TOUR_AUTOMATA, automatonIncoming, automatonWords, cleanProposedBy, isTourAutomaton,
  nextProposedBy, proposedByWords, splitByAuthor,
} from '@/lib/tours/automaton';
import { tourEditChanges } from '@/lib/tours/moderation';
import { TourEditDiff } from '@/components/tours/TourEditDiff';
import { TourModerationStatus, type TourModerationView } from '@/components/tours/TourModerationStatus';
import { editDecisionText } from '@/lib/notifications/partner-edit-notify';
import { importedContent, sitePriceUnit } from '@/lib/services/operators/operator-tour-scraper';
import { bookingTotal } from '@/lib/tours/booking-total';

afterEach(cleanup);

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8');

describe('реестр автоматов', () => {
  it('имя автомата — только из реестра; унаследованные ключи объекта автоматами не считаются', () => {
    expect(isTourAutomaton('tour-describe')).toBe(true);
    for (const bad of ['constructor', 'toString', '__proto__', 'hasOwnProperty', '', 'tour-describe ', 'TOUR-DESCRIBE', null, undefined, 7, {}]) {
      expect(isTourAutomaton(bad), String(bad)).toBe(false);
    }
  });

  it('чем занят автомат — словами; незнакомое имя видно как записано', () => {
    expect(automatonWords('tour-describe')).toBe('сборка описания из данных тура');
    expect(automatonWords('старый-крон')).toBe('автомат «старый-крон»');
    for (const words of Object.values(TOUR_AUTOMATA)) expect(words.trim().length).toBeGreaterThan(5);
  });

  it('у каждого автомата реестра есть производитель: код, который идёт дверью под этим именем', () => {
    // Имя без производителя — провод в никуда (CLAUDE.md §4): заводится вместе с кодом.
    const sources: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(join(ROOT, dir))) {
        const rel = `${dir}/${name}`;
        if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
        else if (/\.(ts|tsx)$/.test(name)) sources.push(rel);
      }
    };
    walk('lib');
    walk('app');
    for (const name of Object.keys(TOUR_AUTOMATA)) {
      const users = sources.filter((rel) => rel !== 'lib/tours/automaton.ts' && read(rel).includes(`source: '${name}'`));
      expect(users.length, `автомат «${name}» никто не зовёт`).toBeGreaterThan(0);
    }
  });
});

describe('пометки «кто предложил поле»', () => {
  it('в пометки идут только колонки содержания с именем-строкой', () => {
    expect(cleanProposedBy({ description: 'tour-describe', title: '', base_price: 7, is_active: 'x', чужое: 'y', photos: '  ' }))
      .toEqual({ description: 'tour-describe' });
    for (const raw of [null, undefined, 'строка', 5, ['description']]) expect(cleanProposedBy(raw)).toEqual({});
  });

  it('автомат не перебивает поле владельца на проверке; своё и чужое автоматное — заменяет', () => {
    const pending = { description: 'текст владельца', base_price: 12000 };
    // Описание без пометки — слово владельца; цена помечена автоматом.
    const r = automatonIncoming({ description: 'собрано', base_price: 11000, title: 'Новое' }, pending, { base_price: 'tour-describe' });
    expect(r.keptOwner).toEqual(['description']);
    expect(r.incoming).toEqual({ base_price: 11000, title: 'Новое' });
    // Черновика нет — ложится всё.
    expect(automatonIncoming({ description: 'собрано' }, {}, {})).toEqual({ incoming: { description: 'собрано' }, keptOwner: [] });
  });

  it('поле прислал автомат — пометка его; владелец поменял — пометки нет; прислал то же — остаётся', () => {
    const marksBefore = { description: 'tour-describe' };
    const pendingPatch = { description: 'собрано' };
    // Автомат кладёт цену в черновик, где уже есть его описание.
    expect(nextProposedBy({
      patch: { description: 'собрано', base_price: 11000 }, pendingPatch, marksBefore,
      incoming: { base_price: 11000 }, source: 'tour-describe',
    })).toEqual({ description: 'tour-describe', base_price: 'tour-describe' });
    // Владелец прислал форму целиком: описание то же, цена своя.
    expect(nextProposedBy({
      patch: { description: 'собрано', base_price: 12000 }, pendingPatch, marksBefore,
      incoming: { description: 'собрано', base_price: 12000 }, source: null,
    })).toEqual({ description: 'tour-describe' });
    // Владелец переписал описание.
    expect(nextProposedBy({
      patch: { description: 'своими словами' }, pendingPatch, marksBefore,
      incoming: { description: 'своими словами' }, source: null,
    })).toEqual({});
    // Поле ушло из черновика (вернули к витрине) — пометка ушла с ним.
    expect(nextProposedBy({
      patch: { base_price: 12000 }, pendingPatch, marksBefore, incoming: { description: 'как на витрине' }, source: null,
    })).toEqual({});
    // Правка другого поля пометку не трогает.
    expect(nextProposedBy({
      patch: { description: 'собрано', title: 'Новое' }, pendingPatch, marksBefore, incoming: { title: 'Новое' }, source: null,
    })).toEqual({ description: 'tour-describe' });
  });

  it('число из формы и из базы — одно значение: пометка не теряется из-за записи', () => {
    // Автомат предложил цену, владелец сохранил форму с той же ценой строкой.
    expect(nextProposedBy({
      patch: { base_price: '11000.00' }, pendingPatch: { base_price: 11000 }, marksBefore: { base_price: 'tour-describe' },
      incoming: { base_price: '11000.00' }, source: null,
    })).toEqual({ base_price: 'tour-describe' });
  });

  it('пометки словами и деление полей по автору', () => {
    expect(proposedByWords({ description: 'tour-describe', title: 'старый-крон' }))
      .toEqual({ title: 'автомат «старый-крон»', description: 'сборка описания из данных тура' });
    expect(splitByAuthor(['description', 'base_price', 'photos'], { description: 'tour-describe' }))
      .toEqual({ automaton: ['description'], owner: ['base_price', 'photos'] });
  });
});

describe('строка диффа: чьё предложение', () => {
  it('поле автомата подписано, поле владельца — нет; у владельца и у администратора вёрстка одна', () => {
    const changes = tourEditChanges(
      { description: 'Коротко.', base_price: 10000 },
      { description: 'Собранное описание.', base_price: 12000 },
      { proposedBy: proposedByWords({ description: 'tour-describe' }) },
    );
    expect(changes.map((c) => [c.field, c.proposedBy ?? null])).toEqual([
      ['description', 'сборка описания из данных тура'], ['base_price', null],
    ]);
    render(<TourEditDiff changes={changes} />);
    const rows = screen.getAllByTestId('tour-edit-change');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByTestId('tour-edit-proposed-by').textContent)
      .toBe('Предложил автомат платформы: сборка описания из данных тура');
    expect(within(rows[1]).queryByTestId('tour-edit-proposed-by')).toBeNull();
  });

  it('без пометок дифф прежний: ни одной строки про автомат', () => {
    render(<TourEditDiff changes={tourEditChanges({ base_price: 10000 }, { base_price: 12000 })} />);
    expect(screen.queryByTestId('tour-edit-proposed-by')).toBeNull();
    expect(screen.queryByText(/автомат/i)).toBeNull();
  });
});

describe('статус тура у владельца: предложение платформы', () => {
  const noop = () => undefined;
  const view = (changes: NonNullable<TourModerationView['pending']>['changes'], wantsPublish = false): TourModerationView => ({
    state: 'pending', published: true, rejected: null,
    pending: { changes, wantsPublish, since: '2026-11-23T10:00:00.000Z' },
  });
  const auto = tourEditChanges({ description: 'Коротко.' }, { description: 'Собранное описание.' }, { proposedBy: proposedByWords({ description: 'tour-describe' }) });
  const own = tourEditChanges({ base_price: 10000 }, { base_price: 12000 });

  it('вся правка — предложение платформы: экран не говорит «отправлено» от имени владельца', () => {
    render(<TourModerationStatus moderation={view(auto)} busy={false} onAskPublish={noop} onUnpublish={noop} onWithdraw={noop} />);
    const box = screen.getByTestId('tour-moderation');
    expect(box.textContent).toContain('Платформа предложила правку');
    expect(box.textContent).toContain('Предложено ');
    expect(box.textContent).not.toContain('Отправлено ');
    expect(box.textContent).not.toContain('Правка на проверке');
    // Отказ такому предложению владельцу не показывается — и экран этого не обещает.
    expect(box.textContent).toContain('Отклонят — предложение исчезнет, тур не изменится.');
    expect(box.textContent).not.toContain('Решение появится здесь');
    expect(within(box).getByRole('button', { name: 'Убрать предложение' })).toBeTruthy();
    expect(within(box).getByTestId('tour-edit-proposed-by')).toBeTruthy();
  });

  it('в правке есть и поля владельца: экран прежний, с припиской о платформе', () => {
    render(<TourModerationStatus moderation={view([...auto, ...own])} busy={false} onAskPublish={noop} onUnpublish={noop} onWithdraw={noop} />);
    const box = screen.getByTestId('tour-moderation');
    expect(box.textContent).toContain('Правка на проверке');
    expect(box.textContent).toContain('Отправлено ');
    expect(box.textContent).toContain('Решение появится здесь');
    expect(box.textContent).toContain('Часть правок предложила платформа — они подписаны.');
    expect(within(box).getByRole('button', { name: 'Отозвать правку' })).toBeTruthy();
  });

  it('правка владельца: про платформу ни слова; просьба о публикации — «тур на проверке», даже с полем платформы', () => {
    const { unmount } = render(<TourModerationStatus moderation={view(own)} busy={false} onAskPublish={noop} onUnpublish={noop} onWithdraw={noop} />);
    expect(screen.getByTestId('tour-moderation').textContent).not.toMatch(/платформ/i);
    unmount();
    render(<TourModerationStatus moderation={view(auto, true)} busy={false} onAskPublish={noop} onUnpublish={noop} onWithdraw={noop} />);
    const box = screen.getByTestId('tour-moderation');
    expect(box.textContent).toContain('Тур на проверке');
    expect(box.textContent).not.toContain('Платформа предложила правку');
    // Публикацию просил владелец: «отправлено» и «решение появится здесь» — про него.
    expect(box.textContent).toContain('Отправлено ');
    expect(box.textContent).toContain('Решение появится здесь');
    expect(within(box).getByRole('button', { name: 'Отозвать с проверки' })).toBeTruthy();
  });
});

describe('сообщение владельцу о решении', () => {
  const base = { partnerId: 'p', subject: 'tour' as const, label: 'Вулкан <Горелый>', reason: null, fieldsWords: 'описание' };

  it('одобрено предложение платформы: владелец узнаёт, что тур изменён не им', () => {
    const text = editDecisionText({ ...base, outcome: 'approved', platformFieldsWords: 'описание', platformOnly: true });
    expect(text).toBe([
      '<b>Тур изменён по предложению платформы</b>',
      '«Вулкан &lt;Горелый&gt;»: платформа предложила правку (описание), администратор её одобрил — она на сайте.',
      'Изменить это можно в кабинете на сайте: правка уйдёт на проверку.',
    ].join('\n'));
  });

  it('смешанная правка: к обычному тексту добавлено, что предложила платформа', () => {
    const ok = editDecisionText({ ...base, outcome: 'approved', fieldsWords: 'описание, цена', platformFieldsWords: 'описание', platformOnly: false });
    expect(ok.split('\n')).toEqual([
      '<b>Правка тура одобрена</b>',
      '«Вулкан &lt;Горелый&gt;»: правка на сайте (описание, цена).',
      'Из этого предложила платформа: описание.',
    ]);
    const no = editDecisionText({ ...base, outcome: 'rejected', reason: 'Цена <не> сходится', fieldsWords: 'описание, цена', platformFieldsWords: 'описание', platformOnly: false });
    expect(no).toContain('Из этого предложила платформа: описание.');
    expect(no).toContain('Причина: Цена &lt;не&gt; сходится');
    // Слова о полях в разметку сообщения как есть не идут.
    expect(editDecisionText({ ...base, outcome: 'rejected', platformFieldsWords: 'описание <b>', platformOnly: false }))
      .toContain('Из этого предложила платформа: описание &lt;b&gt;.');
  });

  it('правка владельца: текст прежний, про платформу ни слова', () => {
    for (const outcome of ['approved', 'rejected'] as const) {
      expect(editDecisionText({ ...base, outcome })).not.toMatch(/платформ/i);
    }
    // Первая публикация тура с предложением платформы — решение о туре, с припиской.
    const first = editDecisionText({ ...base, outcome: 'approved', firstPublication: true, platformFieldsWords: 'описание', platformOnly: false });
    expect(first.split('\n')).toEqual([
      '<b>Тур одобрен</b>', '«Вулкан &lt;Горелый&gt;»: проверка пройдена, тур опубликован.', 'Из этого предложила платформа: описание.',
    ]);
  });
});

describe('импорт с сайта оператора: что он предлагает существующему туру', () => {
  const scraped = (over: Record<string, unknown> = {}) => ({
    title: 'Вулкан Горелый', category: 'volcano', price_from: 12000, price_unit: 'per_person', group_size_max: 8,
    price_note: 'Детям — скидка', includes: 'Гид', duration_hours: 9, departures: null,
    source_url: 'https://example.test/tour', description: 'Описание с сайта оператора.', ...over,
  }) as Parameters<typeof importedContent>[0];

  it('единица цены — словарём сайта: «за группу» — это «за тур», «не понял» — не единица', () => {
    expect(sitePriceUnit('per_person')).toBe('per_person');
    expect(sitePriceUnit('per_group')).toBe('per_tour');
    expect(sitePriceUnit('unknown')).toBeNull();
  });

  it('цена предлагается только с понятой единицей; ненайденное не очищает поле; вид активности не трогается', () => {
    expect(importedContent(scraped())).toEqual({
      base_price: 12000, price_unit: 'per_person', price_note: 'Детям — скидка',
      description: 'Описание с сайта оператора.', duration_hours: 9,
    });
    expect(importedContent(scraped({ price_unit: 'per_group' }))).toMatchObject({ base_price: 12000, price_unit: 'per_tour' });
    // Число без единицы — не цена: ни цены, ни единицы.
    const noUnit = importedContent(scraped({ price_unit: 'unknown' }));
    expect('base_price' in noUnit || 'price_unit' in noUnit).toBe(false);
    // Единица есть, цены на сайте нет — единицу одну не предлагаем.
    const noPrice = importedContent(scraped({ price_from: null }));
    expect('base_price' in noPrice || 'price_unit' in noPrice).toBe(false);
    expect(importedContent(scraped({ price_from: null, price_note: null, description: null, duration_hours: null }))).toEqual({});
    expect('activity_type' in importedContent(scraped())).toBe(false);
  });

  it('зачем словарь: цена за группу, записанная словом импорта, считалась бы за каждого участника', () => {
    // Расчёт брони незнакомую единицу читает как «за человека».
    const wrong = bookingTotal({ priceUnit: 'per_group', basePrice: 60000, participants: 6 });
    const right = bookingTotal({ priceUnit: sitePriceUnit('per_group'), basePrice: 60000, participants: 6 });
    expect(wrong).toBe(360000);
    expect(right).toBe(60000);
  });
});

describe('крон описаний: своей записи в тур нет', () => {
  const ROUTE = read('app/api/cron/tour-describe/route.ts');

  it('в роуте нет ни UPDATE, ни INSERT тура — только дверь', () => {
    expect(ROUTE, 'крон описаний снова пишет тур своим запросом').not.toMatch(/UPDATE\s+operator_tours/i);
    expect(ROUTE).not.toMatch(/INSERT\s+INTO\s+operator_tours/i);
    expect(ROUTE).not.toMatch(/writeTourPatch|saveTourChange/);
  });

  it('дверь описаний не пишет тур сама и не ходит дверью человека', () => {
    const DOOR = read('lib/tours/describe-door.ts');
    expect(DOOR).not.toMatch(/UPDATE\s+operator_tours|INSERT\s+INTO\s+operator_tours/i);
    expect(DOOR, 'автомат пошёл дверью человека: пометки не будет').not.toMatch(/saveTourChange|writeTourPatch/);
  });
});
