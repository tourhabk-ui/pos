/**
 * /llms.txt — машиночитаемая правда о платформе для других ИИ.
 *
 * Повод: сторонний ассистент (Алиса) описывал нас с ошибками — выдумывал
 * навигацию и переоценивал Кузьмича («передаёт заявку оператору»). Плюс в репо
 * лежал мёртвый public/llms.txt со СТАРЫМ доменом tourhab.ru и выдуманными
 * цифрами. Тест держит served-версию честной и полной.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: vi.fn().mockResolvedValue({
      rows: [
        { id: 'r1', title: 'Вулкан Горелый', location_type: 'volcano' },
        { id: 'r2', title: 'Паратунка', location_type: 'hot_spring' },
      ],
    }),
  },
}));

import { GET } from '@/app/llms.txt/route';
import { WRITE_TOOL_NAMES } from '@/lib/mcp/public-tools';

const COUNT_WORDS: Record<number, string> = { 4: 'четыре', 5: 'пять', 6: 'шесть', 7: 'семь', 8: 'восемь' };
import { NOTIFY_RESPONSE_RULES } from '@/lib/mcp/request-notify-schema';

async function body(): Promise<string> {
  const res = await GET();
  return res.text();
}

describe('/llms.txt — актуально и честно', () => {
  let text = '';
  beforeEach(async () => { text = await body(); });

  it('бренд Ведар и канонический домен vedarai.ru', () => {
    expect(text).toContain('Ведар');
    expect(text).toContain('vedarai.ru');
  });

  it('планировщик и готовые планы не обещают погоду (#3199, M9)', () => {
    // Готовые планы считаются минимум на 30 дней вперёд — прогноза у них не
    // бывает по построению; текст плана прогноза не несёт вовсе.
    const lines = text.split('\n').filter((l) => /\/planner\)|\/plans\)|^## Готовые планы поездок/.test(l));
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const l of lines) expect(l, l).not.toMatch(/погод/i);
  });

  it('НЕ содержит старый домен tourhab.ru', () => {
    expect(text).not.toMatch(/tourhab\.ru/);
  });

  it('навигация, которую сторонние ИИ раньше додумывали', () => {
    for (const path of ['/planner', '/operators', '/accommodations', '/gear', '/transfers', '/sos']) {
      expect(text, `нет ссылки ${path}`).toContain(path);
    }
  });

  it('Кузьмич описан честно: заявка в MAX и веб-чате с согласием, в Telegram — ссылка на форму, подтверждает человек (#2913)', () => {
    expect(text).toContain('Кузьмич');
    expect(text).not.toMatch(/не оформляет заявку за туриста/);
    expect(text).toMatch(/в MAX и веб-чате[^\n]*оформляет заявку сам/);
    expect(text).toMatch(/в Telegram[^\n]*ссылку на уже заполненную форму/);
    expect(text).toMatch(/заявка, не мгновенная бронь[^\n]*подтверждает человек/);
  });

  it('без выдуманных счётчиков — количество объектов из живой БД', () => {
    // Старый public/llms.txt врал «47 операторов / 120+ туров / 1000+ маршрутов».
    expect(text).not.toMatch(/1000\+ маршрут/);
    expect(text).not.toMatch(/120\+ (?:реальных )?тур/);
    // Реальное число объектов подставляется из результата запроса (тут мок = 2).
    expect(text).toContain('2+ объектах');
  });

  it('заявок столько, сколько пишущих инструментов; об изменении заявки сказано: notify_url, подпись, без жилья', () => {
    // Число — из реестра, а не из памяти: «пять» стояло здесь после шестой
    // заявки (create_trip_request) и сторож держал устаревшую цифру (07.11).
    const word = COUNT_WORDS[WRITE_TOOL_NAMES.size];
    expect(word, `нет слова для ${WRITE_TOOL_NAMES.size}`).toBeDefined();
    expect(text).toContain(`Заявки — те же ${word}`);
    expect(text).toContain(`запись — те же ${word}`);
    // Граница слова — явной кириллицей: `\b` без флага `u` знает только
    // латиницу, и «те же пять » не совпадало никогда (ревью PR #3130).
    for (const other of Object.values(COUNT_WORDS).filter((w) => w !== word)) {
      expect(text, other).not.toMatch(new RegExp(`те же ${other}(?![а-яё])`, 'i'));
    }
    expect(text).toMatch(/notify_url/);
    expect(text).toMatch(/Standard Webhooks/);
    expect(text).toMatch(/requested_date/);
    expect(text).toMatch(/у заявки на жильё\s+уведомлений нет/);
    // Правило ответа приёмника — тот же текст, что у инструмента и OpenAPI.
    expect(text).toContain(NOTIFY_RESPONSE_RULES);
    expect(text).not.toMatch(/ответ 410 отключает;/);
  });

  it('дата обновления — сегодняшняя: списки в файле собираются из базы', () => {
    expect(text).toContain(`Last-Updated: ${new Date().toISOString().slice(0, 10)}`);
  });
});

describe('/llms.txt — туры по правилу 1в (слово владельца 29.10)', () => {
  it('весь каталог без среза «40 по цене»; порядок правила; подпись с «Место в списке не продаётся.»', async () => {
    const { pool } = await import('@/lib/db-pool');
    const { nearestFreeDateSql } = await import('@/lib/tours/nearest-free-date');
    const { OFFER_ORDER_NOTE, orderOffersBy } = await import('@/lib/tours/offer-order');
    // Самый дорогой тур — единственный со свободной датой: по цене он был бы
    // последним (и за срезом 40), по правилу — первым.
    const tours = Array.from({ length: 45 }, (_, i) => ({
      id: String(100 + i), slug: null, title: `Тур ${i}`, base_price: String(1000 * (i + 1)),
      activity_type: null, operator_name: 'Оператор', operator_verified: null,
      nearest_free_date: i === 44 ? '2026-12-01' : null,
    }));
    const sqls: string[] = [];
    vi.mocked(pool.query).mockImplementation((async (sql: string) => {
      sqls.push(String(sql));
      return String(sql).includes('FROM operator_tours') ? { rows: tours } : { rows: [] };
    }) as never);

    const text = await body();
    const shown = [...text.matchAll(/\]\(https:\/\/vedarai\.ru\/catalog\/tours\/(\d+)\)/g)].map((m) => m[1]);
    expect(shown).toHaveLength(45);
    expect(shown[0]).toBe('144');
    expect(shown).toEqual(orderOffersBy(tours, (t) => ({ id: t.id, nearestFreeDate: t.nearest_free_date })).map((t) => t.id));
    expect(text).toContain(OFFER_ORDER_NOTE.ru);

    const tourSql = sqls.find((s) => s.includes('FROM operator_tours')) ?? '';
    expect(tourSql).toContain(nearestFreeDateSql('ot'));
    expect(tourSql.replace(nearestFreeDateSql('ot'), '')).not.toMatch(/\bLIMIT\b|\bORDER BY\b/);
  });
});
