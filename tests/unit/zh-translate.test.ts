/**
 * Крон машинного перевода /api/cron/zh-translate — вызовом с подменённой
 * моделью и базой (аудит 15.10, CN-pages; Китай, шаг 7, вариант «в»).
 *
 * Что держится:
 *   - под CRON_SECRET; сухой прогон по умолчанию — модель не зовётся, база не
 *     пишется, ответ называет свежее, устаревшее и отсутствующее;
 *   - устаревание — по хэшу исходника: перевод старого текста переводится
 *     заново, свежий пропускается;
 *   - отказ модели — «не переведено» с причиной, без записи; пустая строка
 *     как перевод не пишется; партия без единого перевода — 502;
 *   - перевод сверяется с исходником: новое или пропавшее число, пропавшая
 *     латиница, русский текст вместо китайского — не перевод; одно число в
 *     разных записях (словом в исходнике, китайской цифрой в переводе) — то
 *     же число (ZH-NUMERALS); месяц словом — его номер, число с множителем
 *     («6 миллионов» — 600万) — его величина (ZH-MONTHS);
 *   - в модель уходит текст после redactPII: телефона оператора там нет;
 *   - партия ограничена (limit ≤ 10).
 * Что берутся только живые туры — на настоящем PostgreSQL
 * (tests/integration/china-quick.pg.test.ts): мок ответил бы на любой SQL.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const poolQuery = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => poolQuery(...a) } }));
const quality = vi.fn();
const fast = vi.fn();
vi.mock('@/lib/ai/providers', () => ({
  callAIQualityOrNull: (...a: unknown[]) => quality(...a),
  callAIFastOrNull: (...a: unknown[]) => fast(...a),
}));

import { GET, zhQueueDefaultSeed } from '@/app/api/cron/zh-translate/route';
import {
  checkSegment, decodeStored, encodeStored, normalizeSource, readField, sourceHash,
} from '@/lib/zh/fields';
import type { ZhTourSourceRow } from '@/lib/zh/content';

const TOUR: ZhTourSourceRow = {
  id: '51', slug: 'dolina-geyzerov', title: 'Долина гейзеров', short_description: null,
  description: 'Вылет в 9:00, звоните +7 914 123-45-67.', program: null,
  included: ['Обед', 'Трансфер'], not_included: null, what_to_bring: null,
  base_price: '105000', price_unit: 'per_person', duration_hours: '8', max_participants: 20,
  season_start: null, season_end: null, safety_notes: ['Не отходить от группы'],
  operator_name: 'Тест', operator_slug: null, operator_public: null,
};

let tourRows: ZhTourSourceRow[] = [];
let stored: Array<{ entity_id: string; field: string; text: string; source_hash: string; translated_at: string; reviewed_at: null }> = [];
let writes: unknown[][] = [];

beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret';
  tourRows = [TOUR];
  stored = [];
  writes = [];
  poolQuery.mockReset();
  poolQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    const s = String(sql);
    if (s.includes('INSERT INTO content_translations')) { writes.push(params ?? []); return { rows: [] }; }
    if (s.includes('FROM content_translations')) return { rows: stored };
    if (s.includes('ot.short_description')) return { rows: tourRows };
    return { rows: [] };
  });
  quality.mockReset();
  fast.mockReset();
  // Подменённая модель: «переводит» каждый сегмент, сохраняя числа и латиницу.
  quality.mockImplementation(async (messages: Array<{ content: string }>) => {
    const { segments } = JSON.parse(messages[1].content) as { segments: string[] };
    return JSON.stringify({ segments: segments.map((s) => `译文 ${(s.match(/[0-9:]+|\[[^\]]*\]/g) ?? []).join(' ')}`.trim()) });
  });
  fast.mockImplementation(async (messages: Array<{ content: string }>) => {
    const { segments } = JSON.parse(messages[1].content) as { segments: string[] };
    return JSON.stringify({ segments: segments.map((s) => `обратно: ${s}`) });
  });
});

const call = (qs = '', secret: string | null = 'test-secret') => GET(new NextRequest(
  `http://localhost/api/cron/zh-translate${qs}`,
  { headers: secret ? { authorization: `Bearer ${secret}` } : {} },
));

function storedFor(field: string, kind: 'text' | 'list', raw: unknown, text: string) {
  return { entity_id: '51', field, text, source_hash: sourceHash(kind, normalizeSource(kind, raw)!), translated_at: '2026-10-15T00:00:00Z', reviewed_at: null };
}

describe('доступ и режим', () => {
  it('без секрета — 401, база и модель не тронуты', async () => {
    const res = await call('', null);
    expect(res.status).toBe(401);
    expect(poolQuery).not.toHaveBeenCalled();
    expect(quality).not.toHaveBeenCalled();
  });

  it('сухой прогон по умолчанию: счёт полей, модель не зовётся, записи нет', async () => {
    stored = [storedFor('title', 'text', TOUR.title, '间歇泉谷')];
    const res = await call('?kind=tour');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe('dry');
    // title, description, included — три непустых поля; title свежий.
    expect(body.fields_total).toBe(3);
    expect(body.skipped_fresh).toBe(1);
    expect(body.pending).toBe(2);
    expect(body.pending_sample.map((p: { field: string }) => p.field).sort()).toEqual(['description', 'included']);
    expect(quality).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it('партия больше 10 — отказ параметров, а не тихое урезание', async () => {
    const res = await call('?apply=1&limit=50');
    expect(res.status).toBe(400);
    expect(quality).not.toHaveBeenCalled();
  });
});

describe('перевод и запись', () => {
  it('переводит отсутствующее, пишет хэш нынешнего исходника и обратный перевод; свежее пропускает', async () => {
    stored = [storedFor('title', 'text', TOUR.title, '间歇泉谷')];
    const res = await call('?kind=tour&apply=1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.translated.map((t: { field: string }) => t.field).sort()).toEqual(['description', 'included']);
    expect(body.not_translated).toEqual([]);
    expect(body.skipped_fresh).toBe(1);
    expect(body.pending_left).toBe(0);
    const inc = writes.find((w) => w[2] === 'included') as unknown[];
    expect(inc.slice(0, 5)).toEqual(['tour', '51', 'included', 'zh-CN', sourceHash('list', ['Обед', 'Трансфер'])]);
    expect(JSON.parse(inc[5] as string)).toEqual(['译文', '译文']);
    expect(JSON.parse(inc[6] as string)).toEqual(['обратно: 译文', 'обратно: 译文']);
    expect(inc[7]).toBe('ai-quality');
  });

  it('исходник правили после перевода — перевод устарел по хэшу и переводится заново', async () => {
    stored = [
      storedFor('title', 'text', 'Прежнее название', '旧名称'),
      storedFor('description', 'text', TOUR.description, '已翻译'),
      storedFor('included', 'list', TOUR.included, JSON.stringify(['午餐', '接送'])),
    ];
    const dry = await (await call('?kind=tour')).json();
    expect(dry.pending).toBe(1);
    expect(dry.pending_stale).toBe(1);
    expect(dry.pending_sample).toEqual([{ entity_type: 'tour', entity_id: '51', field: 'title', state: 'stale' }]);
    const res = await call('?kind=tour&apply=1');
    expect((await res.json()).translated).toEqual([{ entity_type: 'tour', entity_id: '51', field: 'title' }]);
    expect(writes[0][4]).toBe(sourceHash('text', 'Долина гейзеров'));
  });

  it('перевод с верным хэшем, но испорченной формы — не свежий: крон переводит заново, причина в логе', async () => {
    stored = [
      storedFor('title', 'text', TOUR.title, '间歇泉谷'),
      storedFor('description', 'text', TOUR.description, '已翻译'),
      // Список из одного пункта при двух в исходнике — страница его не покажет.
      storedFor('included', 'list', TOUR.included, JSON.stringify(['午餐'])),
    ];
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const dry = await (await call('?kind=tour')).json();
    expect(dry.skipped_fresh).toBe(2);
    expect(dry.pending_sample).toEqual([{ entity_type: 'tour', entity_id: '51', field: 'included', state: 'stale' }]);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('перевод в базе не читается'), 'included');
    err.mockRestore();
  });

  it('отказ модели — «не переведено» с причиной, записи нет, партия без переводов — 502', async () => {
    quality.mockResolvedValue(null);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await call('?kind=tour&apply=1');
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.translated).toEqual([]);
    expect(body.not_translated).toHaveLength(3);
    for (const n of body.not_translated) expect(n.reason).toMatch(/модель не ответила/);
    expect(writes).toEqual([]);
    err.mockRestore();
  });

  it('пустая строка от модели — не перевод: не пишется', async () => {
    tourRows = [{ ...TOUR, description: null, included: null }];
    quality.mockResolvedValue(JSON.stringify({ segments: [''] }));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await call('?kind=tour&apply=1');
    expect(res.status).toBe(502);
    expect((await res.json()).not_translated[0].reason).toMatch(/пустую строку/);
    expect(writes).toEqual([]);
    err.mockRestore();
  });

  // Прогоны 3, 5 и 6 трижды отвергли одно поле строкой «не JSON» без
  // подробностей — по ней нельзя было отличить мусор от лишнего сегмента.
  it('ответ не той формы — причина называет, чем именно, и начало ответа', async () => {
    tourRows = [{ ...TOUR, title: 'Долина гейзеров', description: null, included: null }];
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const reasonFor = async (answer: string) => {
      quality.mockResolvedValue(answer);
      const body = await (await call('?kind=tour&apply=1')).json();
      return String(body.not_translated[0].reason);
    };
    expect(await reasonFor(JSON.stringify({ segments: ['间歇泉谷', '多余'] })))
      .toMatch(/не JSON из 1 сегментов: сегментов 2 вместо 1; начало ответа: «\{"segments":\["间歇泉谷"/);
    expect(await reasonFor('间歇泉谷')).toMatch(/в ответе нет JSON-объекта; начало ответа: «间歇泉谷»/);
    expect(await reasonFor('{"segments": ["间歇泉谷"')).toMatch(/в ответе нет JSON-объекта/);
    expect(await reasonFor('{"segments": ["间歇泉谷",]}')).toMatch(/JSON не разобран/);
    expect(await reasonFor('{"translation": "间歇泉谷"}')).toMatch(/нет массива segments/);
    expect(await reasonFor('{"segments": [1]}')).toMatch(/в segments не только строки/);
    // Длинный ответ режется до 100 знаков и одной строкой.
    const long = await reasonFor(`мусор\n${'谷'.repeat(300)}`);
    expect(long).toMatch(/начало ответа: «мусор 谷+»$/);
    expect(long.split('начало ответа: «')[1].length).toBeLessThanOrEqual(101);
    expect(writes).toEqual([]);
    err.mockRestore();
  });

  // Прогон 7 (16.10): тур 11 short_description в прогонах 3, 5, 6 и 7 модель
  // отдавала с лишней скобкой — {"segments":["…"]]} — при верном переводе.
  it('массив, закрытый дважды, чинится; другие поломки JSON — нет', async () => {
    const SRC = '7 дней рыбалки: все виды рыб, выезды с базы.';
    tourRows = [{ ...TOUR, title: 'Долина гейзеров', short_description: SRC, description: null, included: null }];
    let broken = '{"segments":["7天钓鱼：各种鱼类，从基地出发。"]]}';
    quality.mockImplementation(async (messages: Array<{ content: string }>) => {
      const { segments } = JSON.parse(messages[1].content) as { segments: string[] };
      return segments[0] === SRC ? broken : JSON.stringify({ segments: ['间歇泉谷'] });
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fieldsOf = (list: Array<{ field: string }>) => list.map((x) => x.field).sort();

    const ok = await (await call('?kind=tour&apply=1')).json();
    expect(fieldsOf(ok.translated)).toEqual(['short_description', 'title']);
    const written = writes.find((w) => w.includes('short_description'));
    expect(written).toBeDefined();
    expect(written?.some((v) => v === '7天钓鱼：各种鱼类，从基地出发。')).toBe(true);

    // Скобка лишняя дважды — это уже не та поломка: отказ с ошибкой разбора.
    writes = [];
    broken = '{"segments":["7天钓鱼：各种鱼类，从基地出发。"]]]}';
    const twice = await (await call('?kind=tour&apply=1')).json();
    expect(twice.not_translated.find((x: { field: string }) => x.field === 'short_description')?.reason)
      .toMatch(/JSON не разобран/);
    // Починка не отменяет сверку: исправленный ответ с лишним числом отвергнут.
    broken = '{"segments":["8天钓鱼：各种鱼类，从基地出发。"]]}';
    const wrong = await (await call('?kind=tour&apply=1')).json();
    expect(wrong.not_translated.find((x: { field: string }) => x.field === 'short_description')?.reason)
      .toMatch(/нет чисел исходника: 7/);
    err.mockRestore();
  });

  it('модель дописала число — перевод отвергнут с причиной', async () => {
    tourRows = [{ ...TOUR, title: 'Долина гейзеров', description: null, included: null }];
    quality.mockResolvedValue(JSON.stringify({ segments: ['间歇泉谷 3天'] }));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const body = await (await call('?kind=tour&apply=1')).json();
    expect(body.not_translated[0].reason).toMatch(/появились числа.*3/);
    expect(writes).toEqual([]);
    err.mockRestore();
  });

  it('в модель уходит текст после redactPII: телефона оператора нет', async () => {
    await call('?kind=tour&apply=1');
    const sent = quality.mock.calls.map((c) => (c[0] as Array<{ content: string }>)[1].content).join('\n');
    expect(sent).not.toContain('914');
    expect(sent).toContain('[телефон]');
    // Правила безопасности, цена и прочие факты в модель не уходят вовсе.
    expect(sent).not.toContain('Не отходить от группы');
    expect(sent).not.toContain('105000');
  });

  it('отказ базы — 500 с SQLSTATE, а не «всё переведено»', async () => {
    poolQuery.mockRejectedValue(Object.assign(new Error('relation does not exist'), { code: '42P01' }));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await call('?apply=1');
    expect(res.status).toBe(500);
    expect((await res.json()).sqlstate).toBe('42P01');
    expect(quality).not.toHaveBeenCalled();
    err.mockRestore();
  });
});

// Ревью волны 6: очередь по id держала бы поле, которое модель стабильно не
// переводит, первым в каждой партии — и за ним стояла бы вся очередь.
describe('очередь: непереводимое поле не держит остальные', () => {
  const MARKER: Record<string, string> = { title: 'Долина гейзеров', description: 'Вылет', included: 'Обед' };

  it('skip берёт поля за непереведёнными, порядок задан seed', async () => {
    const order = ((await (await call('?kind=tour&seed=s1')).json()).pending_sample as Array<{ field: string }>).map((p) => p.field);
    expect(order).toHaveLength(3);
    const real = quality.getMockImplementation()!;
    quality.mockImplementation(async (messages: Array<{ content: string }>) => (
      messages[1].content.includes(MARKER[order[0]]) ? null : real(messages)
    ));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const first = await call('?kind=tour&apply=1&limit=1&seed=s1');
    expect(first.status).toBe(502);
    expect((await first.json()).not_translated.map((n: { field: string }) => n.field)).toEqual([order[0]]);
    const next = await call('?kind=tour&apply=1&limit=1&seed=s1&skip=1');
    expect(next.status).toBe(200);
    const body = await next.json();
    expect(body.skip).toBe(1);
    expect(body.translated.map((t: { field: string }) => t.field)).toEqual([order[1]]);
    err.mockRestore();
  });

  it('другой seed — другой порядок; без seed — сегодняшняя дата по Камчатке', async () => {
    const firsts = new Set<string>();
    for (const seed of ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8']) {
      const body = await (await call(`?kind=tour&seed=${seed}`)).json();
      expect(body.order_seed).toBe(seed);
      firsts.add(body.pending_sample[0].field);
    }
    expect(firsts.size).toBeGreaterThan(1);
    expect((await (await call('?kind=tour')).json()).order_seed).toBe(zhQueueDefaultSeed());
    // 13:00 UTC 15.10 — уже 16.10 на Камчатке (UTC+12).
    expect(zhQueueDefaultSeed(new Date('2026-10-15T13:00:00Z'))).toBe('2026-10-16');
    expect(zhQueueDefaultSeed(new Date('2026-10-15T11:00:00Z'))).toBe('2026-10-15');
  });

  it('skip за концом очереди — пустая партия без отказа; кривой seed — 400', async () => {
    const body = await (await call('?kind=tour&apply=1&skip=3')).json();
    expect(body.attempted).toBe(0);
    expect(body.ok).toBe(true);
    expect(quality).not.toHaveBeenCalled();
    expect((await call('?seed=../../x')).status).toBe(400);
  });
});

describe('сверка перевода с исходником', () => {
  it('числа, латиница, иероглифы', () => {
    expect(checkSegment('Вылет в 9:00, 3 часа', '9:00起飞，3小时')).toBeNull();
    expect(checkSegment('Цена 105 000 ₽', '价格105,000卢布')).toBeNull();
    expect(checkSegment('Вылет в 9:00', '起飞')).toMatch(/нет чисел исходника: 9, 00/);
    expect(checkSegment('Полёт на Ми-8', '乘坐米-8直升机')).toBeNull();
    expect(checkSegment('Сап-борд SUP', '桨板')).toMatch(/латинские слова: sup/);
    expect(checkSegment('Долина гейзеров', 'Долина гейзеров')).toMatch(/нет иероглифов/);
    expect(checkSegment('Долина', '  ')).toMatch(/пустую строку/);
  });

  // Аудит 15.10, ZH-NUMERALS: прогон 4 отверг все поля партии — числа
  // исходника стояли словами, а модель писала цифрой, и наоборот. Фразы
  // придуманы той же формы, что исходники туров; с прода не взяты.
  it('одно число в разных записях: слово исходника — цифра перевода, цифра исходника — китайская цифра', () => {
    expect(checkSegment('Тур на два дня', '两天的行程')).toBeNull();
    expect(checkSegment('Тур на два дня', '2天的行程')).toBeNull();
    expect(checkSegment('Первый день — подъём', '第1天：登山')).toBeNull();
    expect(checkSegment('Четырёхчасовой облёт трёх вулканов', '4小时飞越3座火山')).toBeNull();
    expect(checkSegment('Десятичасовая морская прогулка', '10小时的海上游览')).toBeNull();
    expect(checkSegment('Двадцать пять километров по тундре', '在苔原上走25公里')).toBeNull();
    expect(checkSegment('6 часов на маршруте', '路线上六个小时')).toBeNull();
    expect(checkSegment('105 км по дороге', '沿路一百零五公里')).toBeNull();
    expect(checkSegment('3–4 часа пешком', '步行三四个小时')).toBeNull();
    expect(checkSegment('Скидка 50%', '优惠百分之五十')).toBeNull();
  });

  it('другое число — не перевод, в какой бы записи оно ни стояло', () => {
    // Пропало 6, появилось 8.
    expect(checkSegment('6 часов на маршруте', '路线上8个小时')).toMatch(/нет чисел исходника: 6/);
    expect(checkSegment('6 часов на маршруте', '路线上八个小时')).toMatch(/нет чисел исходника: 6/);
    // Чисел в исходнике нет ни цифрой, ни словом — выдуманное число.
    expect(checkSegment('Долина гейзеров', '间歇泉谷3天')).toMatch(/появились числа.*3/);
    // Слово «два» не разрешает иное число: 23 — не «два-три».
    expect(checkSegment('Два-три дня', '23天')).toMatch(/появились числа.*23/);
    // «Полтора» — не целое, и 1.5 им не оправдывается.
    expect(checkSegment('Полтора часа', '1.5小时')).toMatch(/появились числа.*1, 5/);
    // Корень меры обязателен: «семинар» — не 7, «стоянка» — не 100.
    expect(checkSegment('Семинар у стоянки', '停车场旁的研讨会7')).toMatch(/появились числа.*7/);
  });

  // ZH-MONTHS: прогон 5 (16.10) отверг 12 полей, из них 11 — месяцы и
  // миллионы. Исходники ниже — фразы живых туров и места с прода (ответ
  // get_tour_details, миграция 1252), переводы — той формы, что модель пишет.
  it('месяц словом — его номер в переводе: 12月至3月', () => {
    expect(checkSegment(
      'По словам оператора, снегоходные туры проходят с декабря по март. Продолжительность 5–6 часов.',
      '据运营商介绍，雪地摩托之旅于12月至3月进行。时长5-6小时。',
    )).toBeNull();
    expect(checkSegment('Зимняя рыбалка: ноябрь — январь', '冬季钓鱼：11月至1月')).toBeNull();
    expect(checkSegment('Осенняя рыбалка (октябрь-ноябрь)', '秋季钓鱼（10月-11月）')).toBeNull();
    expect(checkSegment('Оператор рекомендует сезон июнь — сентябрь', '运营商推荐6月至9月')).toBeNull();
    expect(checkSegment('В мае и августе', '在5月和8月')).toBeNull();
    // Другой месяц — не перевод.
    expect(checkSegment('Туры проходят с июня по октябрь', '游览于6月至11月进行')).toMatch(/появились числа.*11/);
    // Месяц не оправдывает число, которого нет ни месяцем, ни цифрой.
    expect(checkSegment('Туры проходят в июле', '游览于8月进行')).toMatch(/появились числа.*8/);
  });

  it('число с множителем сравнивается величиной: 6 миллионов — 600万', () => {
    expect(checkSegment(
      'ежегодно в него заходит от 1,5 до 6 миллионов нерки; кальдера диаметром около 7 километров',
      '每年有150万至600万条红鲑洄游；火山口直径约7公里',
    )).toBeNull();
    expect(checkSegment(
      'называет 1,5–3,5 миллиона производителей, а в 1990 году в озеро зашло до 6 миллионов',
      '称有150万至350万条亲鱼，而1990年多达六百万条',
    )).toBeNull();
    expect(checkSegment('Цена от 50 тыс. рублей', '价格5万卢布起')).toBeNull();
    expect(checkSegment('Цена от 50 тыс. рублей', '价格50000卢布起')).toBeNull();
    expect(checkSegment('Шесть миллионов рыб', '600万条鱼')).toBeNull();
    expect(checkSegment('11 000 рублей', '一万一千卢布')).toBeNull();
    // 万 умножает свою секцию, 亿 — всё накопленное: 三亿六千万 — 360 000 000.
    expect(checkSegment('360 миллионов лет', '三亿六千万年')).toBeNull();
    // Другая величина — не перевод, в какой бы записи она ни стояла.
    expect(checkSegment('До 6 миллионов нерки', '多达800万条红鲑')).toMatch(/нет чисел исходника: 6/);
    expect(checkSegment('До 6 миллионов нерки', '多达六千万条红鲑')).toMatch(/нет чисел исходника: 6/);
    // Один конец диапазона не сошёлся — диапазон не вычеркнут, и его цифр в переводе нет.
    expect(checkSegment('От 1,5 до 6 миллионов', '150万至700万')).toMatch(/нет чисел исходника: 1, 5, 6/);
    expect(checkSegment('Цена 7000 ₽', '价格0.8万卢布')).toMatch(/нет чисел исходника: 7000/);
    // Величины в исходнике нет — 万 её не оправдывает.
    expect(checkSegment('Много нерки', '600万条红鲑')).toMatch(/другая величина: 6000000/);
    // Та же цифра, другой множитель: 50万 — 500 000, а не 50 тысяч.
    expect(checkSegment('Цена от 50 тыс. рублей', '价格50万卢布起')).toMatch(/другая величина: 500000/);
    // 千万 при цифре — десять миллионов: 5千万 — 50 000 000, 6千万 — не 6 миллионов.
    expect(checkSegment('До 50 миллионов', '多达5千万')).toBeNull();
    expect(checkSegment('До 6 миллионов', '多达6千万')).toMatch(/другая величина: 60000000/);
    // Разговорная запись: 一千五 — 1500, а не 1005.
    expect(checkSegment('1500 рублей', '一千五卢布')).toBeNull();
  });

  // Ревью ZH-MONTHS (16.10): ослабление не должно пропускать неверное.
  // Каждый случай ниже правка в первой редакции принимала.
  it('месяц оправдывает только месяц перевода, а не день и не часы', () => {
    expect(checkSegment('Заезд 12 июня', '12月6日入住')).toMatch(/появились числа.*6/);
    expect(checkSegment('Заезд 12 июня', '6月12日入住')).toBeNull();
    expect(checkSegment('Экскурсия длится четыре часа. Работаем с мая по октябрь.', '游览持续5小时。5月至10月营业。'))
      .toMatch(/появились числа.*5/);
    expect(checkSegment('Сезон в июле', '7月，7天')).toMatch(/появились числа.*7/);
    expect(checkSegment('Сезон: октябрь-ноябрь', '季节：10-11月')).toBeNull();
    // Оба конца диапазона месяцев судятся: 10-12月 — не «октябрь-ноябрь».
    expect(checkSegment('Сезон: октябрь-ноябрь', '季节：10-12月')).toMatch(/появились числа.*12/);
  });

  it('сошедшееся число с множителем вычёркивается на своём месте, а не прощает свои цифры везде', () => {
    // 5万 за «50 тыс.» не оправдывает 5天 вместо «трёх дней».
    expect(checkSegment('Стоимость 50 тыс. рублей, тур на три дня', '费用5万卢布，5天行程')).toMatch(/появились числа.*5/);
    // 600万 за «6 миллионов» не прикрывает потерю «6 часов».
    expect(checkSegment(
      'В Курильское озеро ежегодно заходит от 1,5 до 6 миллионов нерки. На озере 6 часов.',
      '每年有150万至600万条红鲑洄游至库里尔湖。在湖边停留1小时。',
    )).toMatch(/нет чисел исходника: 6/);
    expect(checkSegment(
      'В Курильское озеро ежегодно заходит от 1,5 до 6 миллионов нерки. На озере 6 часов.',
      '每年有150万至600万条红鲑洄游至库里尔湖。在湖边停留6小时。',
    )).toBeNull();
  });

  it('множитель без числа перед ним — не величина', () => {
    // 千岛 — Курильские острова, а не 1000.
    expect(checkSegment('До Курильских островов 1000 км', '前往千岛群岛')).toMatch(/нет чисел исходника: 1000/);
    // «2 тысячи» — 2000, а не ещё и 1000; «тысячи птиц» — не 1000.
    expect(checkSegment('Стоимость 2 тысячи рублей, тур на 2 дня', '费用1000卢布，2天行程')).toMatch(/нет чисел исходника|появились числа.*1000/);
    expect(checkSegment('На скалах гнездятся тысячи птиц', '悬崖上有1000只鸟筑巢')).toMatch(/появились числа.*1000/);
    // 百万 при арабской цифре — часть 3百万, а не отдельный миллион: потерю «1 000 000» он не прикрывает.
    expect(checkSegment('Бюджет 1 000 000 рублей и ещё 3 миллиона', '预算3百万卢布')).toMatch(/нет чисел исходника: 1000000/);
  });

  it('длинный ряд цифр разбирается за линейное время', () => {
    const digits = '7'.repeat(50_000);
    const started = performance.now();
    // Без множителя после ряда: поиск величины не находит её ни с какого начала.
    checkSegment(`${digits} дней`, `${digits}天`);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('千 перед мерой — «кило-», 十分钟 — десять минут', () => {
    expect(checkSegment('Пять километров', '五千米')).toBeNull();
    // 3千米 — три километра, а не 3000: цену в 3000 рублей он не сохраняет.
    expect(checkSegment('Скидка 3000 рублей', '折扣3千米')).toMatch(/нет чисел исходника: 3000/);
    expect(checkSegment('Перелёт в кальдеру Узон (10 минут)', '飞往乌宗火山口（十分钟）')).toBeNull();
    expect(checkSegment('30 минут', '三十分钟')).toBeNull();
    // Идиомы без цифры перед ними — не числа: 千万 «ни в коем случае», 万一 «на случай».
    expect(checkSegment('5 медведей: ни в коем случае не подходить', '千万不要靠近熊')).toMatch(/нет чисел исходника: 5/);
    expect(checkSegment('1 раз на случай дождя', '万一下雨')).toMatch(/нет чисел исходника: 1/);
  });

  it('китайская цифра внутри обычного слова — не число', () => {
    // 一 в 一起 «вместе» не делает лишним арабское 5; китайские цифры вообще
    // не судятся как «лишние» — 唯一 «единственный» не выдуманная единица…
    expect(checkSegment('5 дней в пути', '一起5天')).toBeNull();
    expect(checkSegment('Единственный маршрут на 5 дней', '唯一的5天路线')).toBeNull();
    // …и не сохраняет потерянную единицу; 十分 «очень» — не 10.
    expect(checkSegment('1 час', '一起两个小时')).toMatch(/нет чисел исходника: 1/);
    expect(checkSegment('10 км пешком', '步行十分美丽')).toMatch(/нет чисел исходника: 10/);
    // 三文鱼 — лосось, а не 3.
    expect(checkSegment('3 дня рыбалки', '钓三文鱼')).toMatch(/нет чисел исходника: 3/);
  });

  it('хранение: список чужой длины — не перевод этого поля', () => {
    const src = ['Обед', 'Трансфер'];
    expect(decodeStored('list', encodeStored('list', ['午餐', '接送']), src)).toEqual(['午餐', '接送']);
    expect(decodeStored('list', JSON.stringify(['午餐']), src)).toBeNull();
    expect(decodeStored('list', 'не json', src)).toBeNull();
  });

  it('вид поля: none / fresh / stale / missing / unknown', () => {
    const rows = new Map([['title', { field: 'title', text: '间歇泉谷', source_hash: sourceHash('text', 'Долина гейзеров'), translated_at: null, reviewed_at: null }]]);
    expect(readField('text', '  ', rows, 'title').state).toBe('none');
    expect(readField('text', 'Долина гейзеров', rows, 'title').state).toBe('fresh');
    expect(readField('text', 'Долина гейзеров!', rows, 'title').state).toBe('stale');
    expect(readField('text', 'Долина', new Map(), 'title').state).toBe('missing');
    expect(readField('text', 'Долина', null, 'title').state).toBe('unknown');
  });
});
