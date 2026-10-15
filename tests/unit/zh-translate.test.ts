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
 *     латиница, русский текст вместо китайского — не перевод;
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

import { GET } from '@/app/api/cron/zh-translate/route';
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
