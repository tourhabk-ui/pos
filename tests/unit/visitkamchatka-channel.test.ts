/**
 * Еженедельная сводка Минтура из Telegram-канала турпортала края
 * (t.me/visitkamchatka41) — карт-бланш владельца 29.10.
 *
 * Повод: владелец переслал сводку 29.10 («закрыты туристские маршруты
 * природных парков „Ключевской“, „Налычево“, „Южно-Камчатский“ и
 * „Быстринский“», три дороги), а в ленте прода (проба 1018,
 * /api/public/safety-status) не было ни одного из этих закрытий. Живого
 * источника у сводки не было: kamgov.ru — 403 раннеру с 26.09, kamtoday снят
 * 20.10, «RSS» турпортала в NEWS_FEED_SOURCES стоял optional и отвечал HTML
 * (проба 1016: сайт на Bitrix, RSS нет). Канал турпортала публикует сводку
 * слово в слово (пробы 1017–1018, посты 4920 и 4936).
 *
 * Тексты ниже — ЖИВЫЕ посты 29.10 и 21.10 (из разметки превью канала; две
 * строки, обрезанные в пробе, дописаны по той же сводке на сайте портала).
 *
 * Сторож держит поведение, не литерал: разбор превью → события; заголовок
 * без «оперативная» узнаётся; парки и дороги доезжают; срок недельный; два
 * парка в двух пунктах не схлопываются; живость — по свежей сводке; поле
 * раннера и его приём на сервере; турпортал с прода больше не тянется.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const queryMock = vi.fn();
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => queryMock(...a) }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => queryMock(...a) } }));
vi.mock('@/lib/safety/ledger', () => ({
  appendSafetyEvent: vi.fn().mockResolvedValue({ id: 1 }),
  hashPayload: (v: unknown) => JSON.stringify(v),
}));

import {
  classifyChannelPost, ingestVisitkamchatkaChannelHtml, splitSummaryPost, summaryPostsOf, isFreshSummary,
  VISITKAMCHATKA_CHANNEL, FRESH_SUMMARY_HOURS,
} from '@/lib/services/safety/visitkamchatka-channel';
import {
  isMinturBulletin, ingestNewsFeeds, NEWS_FEED_PREFIXES, VISITKAMCHATKA_PREFIX, detectRoadRestriction,
} from '@/lib/services/safety/seismic-parser';
import { detectParkClosure } from '@/lib/safety/park-closure';
import { alertOrigin } from '@/lib/safety/alert-origin';
import { SAFETY_SOURCE_EXPECTATIONS } from '@/lib/services/safety/source-health';

const POST_2910 = `Еженедельная сводка о доступности туристических объектов

❗️Закрыты туристские маршруты природных парков «Ключевской», «Налычево», «Южно-Камчатский» и «Быстринский».

🛑 В связи со сменой сезона и возможным ухудшением погодных условий туристическим организациям рекомендовано не выводить группы на маршруты.
Будьте внимательны при планировании поездок в следующих направлениях:

➖ Автодорога «Палана – аэропорт»: зафиксирован подмыв у моста через р. Палана, ведутся восстановительные работы.
➖ Проезд к Авачинскому перевалу: после дождей произошел размыв дороги, образовался овраг – передвижение осложнено и небезопасно.
➖ Ограничение движения для всех видов транспорта действует на дороге Усть-Большерецк – Октябрьский (участок 115–128 км). Разрешен проезд: дорожной технике, автомобилям с продуктами, лекарствами, топливом, транспорту для аварийно-восстановительных работ, служебным автомобилям, транспорту, задействованному в ликвидации ЧС.
Просим жителей и гостей Камчатки учитывать погодные условия при планировании поездок и не подвергать себя и других опасности.
🔗 Подробная информация о состоянии природных парков, маршрутов и ограничениях – на странице Минтуризма Камчатского края.`;

const POST_2110 = `Еженедельная сводка о доступности туристических объектов

Камчатка под влиянием циклона: выход на туристические маршруты не рекомендован.

До 23 октября на полуострове ожидаются сильные осадки в виде дождя и снега, штормовой ветер с порывами до 33–38 м/с в отдельных районах. Непогода может привести к ухудшению дорожной обстановки, падению деревьев, сходу грунта в горах и другим опасным ситуациям.

🛑 В связи с ухудшением погодных условий туристическим организациям рекомендовано не выводить группы на маршруты.
❗️Все маршруты природного парка «Налычево» закрыты до 24 октября включительно. Также временно закрыты маршруты природных парков «Южно-Камчатский» и «Быстринский». Просим жителей и гостей Камчатки учитывать погодные условия при планировании поездок и не подвергать себя и других опасности.
Природный парк «Ключевской» – маршруты закрыты на зимний сезон.
Не рекомендуется посещение вулканов Безымянный, Ключевской, Шивелуч, Крашенинникова, и Мутновский.
Транспортная доступность:
Проезд «п. Термальный – Вилючинский перевал» осуществляется строго по пропускам. График работы КПП: 07:00–08:00, 13:00–14:00, 19:00–20:00.
Проезд к Авачинскому перевалу: после дождей произошел размыв дороги, образовался овраг – передвижение осложнено и небезопасно.`;

const POST_FESTIVAL = 'Региональная турвыставка-2026 откроется 16 октября. Приглашаем гостей и жителей края.';

function tgPost(id: number, datetime: string, text: string): string {
  const html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br/>');
  return `<div class="tgme_widget_message_wrap"><div class="tgme_widget_message" data-post="${VISITKAMCHATKA_CHANNEL}/${id}">`
    + `<div class="tgme_widget_message_text js-message_text" dir="auto">${html}</div>`
    + `<a class="tgme_widget_message_date" href="https://t.me/${VISITKAMCHATKA_CHANNEL}/${id}"><time datetime="${datetime}"></time></a>`
    + '</div></div>';
}

const PREVIEW = `<html><body>${tgPost(4890, '2026-10-14T03:00:00+00:00', POST_FESTIVAL)}${tgPost(4920, '2026-10-21T22:45:00+00:00', POST_2110)}${tgPost(4936, '2026-10-29T02:05:00+00:00', POST_2910)}</body></html>`;

const post2910 = { id: `t.me/${VISITKAMCHATKA_CHANNEL}/4936`, url: `https://t.me/${VISITKAMCHATKA_CHANNEL}/4936`, text: POST_2910, datetime: '2026-10-29T02:05:00+00:00', photos: [] };
const post2110 = { ...post2910, id: `t.me/${VISITKAMCHATKA_CHANNEL}/4920`, url: `https://t.me/${VISITKAMCHATKA_CHANNEL}/4920`, text: POST_2110, datetime: '2026-10-21T22:45:00+00:00' };

describe('сводка узнаётся по заголовку поста', () => {
  it('«Еженедельная сводка о доступности туристических объектов» — сводка Минтура и без слова «оперативная»', () => {
    expect(isMinturBulletin('Еженедельная сводка о доступности туристических объектов')).toBe(true);
    expect(isMinturBulletin('Еженедельная оперативная сводка о доступности туристических объектов')).toBe(true);
    expect(isMinturBulletin('Оперативная сводка доступности туристических объектов от 13 августа')).toBe(true);
    expect(isMinturBulletin('Еженедельная сводка погоды по краю')).toBe(false);
  });

  it('первая строка поста — заголовок, остальное — пункты; у новости заголовка нет', () => {
    const s = splitSummaryPost(post2910);
    expect(s.title).toBe('Еженедельная сводка о доступности туристических объектов');
    expect(s.body.startsWith('❗️Закрыты туристские маршруты')).toBe(true);
    expect(s.id).toBe('tg/4936');
    const n = splitSummaryPost({ ...post2910, text: POST_FESTIVAL });
    expect(n.title).toBe('');
    expect(n.body).toBe(POST_FESTIVAL);
  });

  it('из превью канала сводки — две, новость сводкой не считается', () => {
    const s = summaryPostsOf(PREVIEW);
    expect(s.map((p) => p.url)).toEqual([
      `https://t.me/${VISITKAMCHATKA_CHANNEL}/4920`, `https://t.me/${VISITKAMCHATKA_CHANNEL}/4936`,
    ]);
  });
});

describe('сводка 29.10 — то, что переслал владелец, доезжает до ленты', () => {
  const events = classifyChannelPost(post2910);

  it('закрытие маршрутов четырёх парков — одно событие park_closure со всеми четырьмя парками', () => {
    const parks = events.filter((e) => e.alert_type === 'park_closure');
    expect(parks).toHaveLength(1);
    expect([...(parks[0].affected_parks ?? [])].sort()).toEqual(['bystrinskiy', 'klyuchevskoy', 'nalychevo', 'yuzhno-kamchatsky']);
    expect(parks[0].severity).toBe(2);
    expect(parks[0].affected_zones).toEqual([]);
  });

  it('срок закрытия без названной даты — до следующего выпуска (168 ч), не 48', () => {
    const park = events.find((e) => e.alert_type === 'park_closure')!;
    expect(park.expires_hours).toBe(168);
  });

  it('все три дороги сводки — road_closure: Палана — аэропорт, Авачинский перевал, Усть-Большерецк — Октябрьский', () => {
    const roads = events.filter((e) => e.alert_type === 'road_closure');
    const text = roads.map((e) => `${e.title} ${e.description}`).join('\n');
    expect(text).toMatch(/Палана/);
    expect(text).toMatch(/Авачинскому перевалу/);
    expect(text).toMatch(/Усть-Большерецк/);
    expect(roads).toHaveLength(3);
    // Повреждение дороги — жёлтый уровень, как пропускной режим; неделя жизни.
    for (const r of roads) {
      expect(r.severity).toBe(1);
      expect(r.expires_hours).toBe(168);
    }
    expect(roads.find((e) => /Усть-Большерецк/.test(`${e.title} ${e.description}`))?.affected_zones).toContain('western');
    expect(roads.find((e) => /Авачинскому/.test(`${e.title} ${e.description}`))?.affected_zones).toContain('avachinsky');
  });

  it('происхождение событий — турпортал: external_id с его префиксом и правило в alert-origin', () => {
    for (const e of events) {
      expect(e.source_id.startsWith(`${VISITKAMCHATKA_PREFIX}/`)).toBe(true);
      expect(e.source_url).toBe(post2910.url);
      expect(alertOrigin(e.source_id)?.key).toBe('visitkamchatka');
    }
    expect(NEWS_FEED_PREFIXES).toContain(VISITKAMCHATKA_PREFIX);
  });

  it('новость канала (выставка) событий не даёт', () => {
    expect(classifyChannelPost({ ...post2910, text: POST_FESTIVAL })).toEqual([]);
  });
});

describe('сводка 21.10 — два пункта о разных парках не схлопываются', () => {
  const events = classifyChannelPost(post2110);
  const parks = events.filter((e) => e.alert_type === 'park_closure');

  it('«Налычево закрыто до 24 октября включительно» (с Южно-Камчатским и Быстринским) — срок по названной дате', () => {
    const nal = parks.find((e) => e.affected_parks?.includes('nalychevo'))!;
    expect(nal).toBeTruthy();
    expect([...(nal.affected_parks ?? [])].sort()).toEqual(['bystrinskiy', 'nalychevo', 'yuzhno-kamchatsky']);
    // Пост от 21.10 22:45 UTC; конец 24.10 по Камчатке — 24.10 12:00 UTC: 62 часа.
    expect(nal.expires_hours).toBe(62);
  });

  it('«Ключевской — маршруты закрыты на зимний сезон» — отдельное закрытие парка, не дорога', () => {
    const kl = parks.find((e) => e.affected_parks?.includes('klyuchevskoy'))!;
    expect(kl).toBeTruthy();
    expect(kl.affected_parks).toEqual(['klyuchevskoy']);
    expect(kl.expires_hours).toBe(168);
    expect(events.some((e) => e.alert_type === 'road_closure' && /Ключевской/.test(e.title))).toBe(false);
  });

  it('пять вулканов «не рекомендуется посещение» — по событию на каждый', () => {
    const names = events.filter((e) => e.alert_type === 'volcanic_eruption').map((e) => e.volcano_name).sort();
    expect(names).toEqual(['Безымянный', 'Ключевской', 'Крашенинникова', 'Мутновский', 'Шивелуч']);
  });
});

describe('правила, на которых держится разбор', () => {
  it('detectParkClosure: «маршруты закрыты на зимний сезон» — закрытие (граница слова по кириллице)', () => {
    expect(detectParkClosure('Природный парк «Ключевской» – маршруты закрыты на зимний сезон.')).toEqual({ parks: ['klyuchevskoy'] });
    expect(detectParkClosure('Маршруты природного парка «Налычево» открыты, закрытых нет.')).toBeNull();
  });

  it('detectRoadRestriction: размыв и подмыв — жёлтый; починенное — не ограничение', () => {
    expect(detectRoadRestriction('Проезд к Авачинскому перевалу: после дождей произошел размыв дороги, образовался овраг – передвижение осложнено и небезопасно.')).toEqual({ severity: 1 });
    expect(detectRoadRestriction('Автодорога «Палана – аэропорт»: зафиксирован подмыв у моста через р. Палана, ведутся восстановительные работы.')).toEqual({ severity: 1 });
    expect(detectRoadRestriction('Размыв дороги к перевалу устранён, движение восстановлено.')).toBeNull();
    expect(detectRoadRestriction('На фестивале показали, как размывают дорожки у моста в парке аттракционов.')).toBeNull();
  });
});

describe('приём страницы раннера: три исхода и живость по свежей сводке', () => {
  beforeEach(() => {
    queryMock.mockReset();
    // saveEvent: дедуп-проверки — пусто, вставка — удалась.
    queryMock.mockImplementation((sql: string) =>
      Promise.resolve(/^\s*(UPDATE external_alerts|SELECT 1 FROM external_alerts)/.test(sql)
        ? { rows: [], rowCount: 0 }
        : { rows: [{ id: 1 }], rowCount: 1 }));
  });

  it('страница без постов — ошибка, не «тихо»', async () => {
    const r = await ingestVisitkamchatkaChannelHtml('<html><body>Please open Telegram</body></html>');
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/visitkamchatka41/);
    expect(r.rawItems).toBe(0);
    expect(r.postsParsed).toBe(0);
  });

  it('свежая сводка — rawItems считает только её, события вставлены', async () => {
    const r = await ingestVisitkamchatkaChannelHtml(PREVIEW, new Date('2026-10-30T00:00:00Z'));
    expect(r.postsParsed).toBe(3);
    expect(r.summaries.map((s) => s.fresh)).toEqual([true, true]);
    expect(r.rawItems).toBe(2);
    expect(r.events.some((e) => e.alert_type === 'park_closure' && e.affected_parks?.length === 4)).toBe(true);
    expect(r.inserted).toBe(r.events.length);
    expect(r.errors).toEqual([]);
  });

  it('сводки старше окна свежести — rawItems 0: тишина считается от последнего выпуска, а не от перечитанных постов', async () => {
    const later = new Date(new Date('2026-10-29T02:05:00Z').getTime() + (FRESH_SUMMARY_HOURS + 1) * 3_600_000);
    const r = await ingestVisitkamchatkaChannelHtml(PREVIEW, later);
    expect(r.rawItems).toBe(0);
    expect(r.summaries.every((s) => !s.fresh)).toBe(true);
    expect(isFreshSummary(splitSummaryPost(post2910), later)).toBe(false);
  });

  it('здоровье источника: запись есть, живость по raw_items, порог три недели', () => {
    const exp = SAFETY_SOURCE_EXPECTATIONS.find((e) => e.key === 'visitkamchatka');
    expect(exp).toBeTruthy();
    expect(exp?.aliveBy).toBe('raw_items');
    expect(exp?.maxSilenceHours).toBe(24 * 21);
    expect(exp?.deadHint).toMatch(/visitkamchatka41/);
  });
});

describe('раннер и сервер', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

  it('воркфлоу читает канал турпортала и отдаёт страницу полем visitkamchatka_html', () => {
    const wf = read('.github/workflows/cron-safety-ingest.yml');
    expect(wf).toMatch(/"https:\/\/t\.me\/s\/visitkamchatka41" > \/tmp\/visitkamchatka\.html/);
    expect(wf).toMatch(/--rawfile visitkamchatka_html \/tmp\/visitkamchatka\.html/);
    expect(wf).toMatch(/\{visitkamchatka_html: \$visitkamchatka_html\}/);
  });

  it('приём: поле в схеме, разбор каналом, здоровье — только когда раннер принёс страницу', () => {
    const route = read('app/api/cron/safety-ingest/route.ts');
    expect(route).toMatch(/visitkamchatka_html: z\.string\(\)\.max\(2_000_000\)\.optional\(\)/);
    expect(route).toMatch(/ingestVisitkamchatkaChannelHtml\(parsed\.data\.visitkamchatka_html\)/);
    expect(route).toMatch(/parsed\.data\.visitkamchatka_html\s*\?\s*\[entryFor\('visitkamchatka'/);
  });

  it('турпортал с прода больше не тянется: у него нет RSS, и «optional» молчал по построению', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, text: () => Promise.resolve('') });
    vi.stubGlobal('fetch', fetchMock);
    try {
      await ingestNewsFeeds(['kamgov']);
      const urls = fetchMock.mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.includes('visitkamchatka.ru'))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
