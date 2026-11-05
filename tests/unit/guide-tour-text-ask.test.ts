// @vitest-environment node
/**
 * «Дай текст тура» — текст из базы, без модели (05.11).
 *
 * Андрей Запорожец попросил в MAX «дай мне текст тура ID71 в формате word»,
 * и модель сочинила описание тура, у которого в базе описания нет. Сторож
 * держит: просьба перехватывается до модели; ответ — поля как записаны, в
 * форме фразы правки, которую можно прислать обратно; пустое названо пустым;
 * длинное поле не режется в строку для копирования.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: (sql: string, params?: unknown[]) => h.query(sql, params ?? []),
    connect: async () => ({ query: (sql: string, params?: unknown[]) => h.query(sql, params ?? []), release: () => undefined }),
  },
}));
vi.mock('@/lib/database', () => ({ query: (sql: string, params?: unknown[]) => h.query(sql, params ?? []) }));
vi.mock('@/lib/config', async (orig) => ({ ...(await orig<typeof import('@/lib/config')>()), getPublicBaseUrl: () => 'https://vedarai.ru' }));

import { parseTourTextAsk } from '@/lib/guides/tour-edit/text-ask';
import { parseTourEdit } from '@/lib/guides/tour-edit/parse';
import { captureGuideTourEdit } from '@/lib/guides/tour-edit/flow';

const GUIDE = { partnerId: 'g-1', partnerName: 'Андрей', category: 'guide', crmCategory: 'guide' as const, userId: 'u-1', sellsTours: true };

function row(over: Record<string, unknown>) {
  return {
    id: '71', title: 'Ганальские Востряки', slug: null, is_active: true, is_published: false,
    base_price: 15000, price_unit: 'per_person', max_participants: 4,
    short_description: null, description: null, program: null,
    included: null, not_included: null, what_to_bring: null, safety_notes: null, ...over,
  };
}

function db(rows: Array<Record<string, unknown>>) {
  h.query.mockImplementation(async (sql: string) =>
    /FROM operator_tours t\s+WHERE t\.operator_id/.test(sql) ? { rows } : { rows: [], rowCount: 0 });
}

const unhtml = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

beforeEach(() => vi.clearAllMocks());

describe('просьба «текст тура» разбирается без модели', () => {
  it.each([
    ['дай мне текст тура ID71 в формате word', { tourWords: null, tourId: '71' }],
    ['дай мне текст тура в формате word', { tourWords: null, tourId: null }],
    ['текст тура Горелый', { tourWords: 'Горелый', tourId: null }],
    ['Пришли текст тура «Вачкажец + озёрки» документом', { tourWords: 'Вачкажец + озёрки', tourId: null }],
    ['покажи текст тура 76', { tourWords: null, tourId: '76' }],
  ])('%s', (text, want) => expect(parseTourTextAsk(text)).toEqual(want));

  it.each(['Горелый: описание: текст тура про вулкан', 'новый тур: Горелый', 'как добавить фото в тур', 'текстовый тур'])(
    'не просьба: %s', (text) => expect(parseTourTextAsk(text)).toBeNull());
});

describe('ответ — поля тура из базы', () => {
  it('пустой тур — «не записано», ничего не сочинено', async () => {
    db([row({})]);
    const s = await captureGuideTourEdit({ channel: 'max', chatId: 1, partner: GUIDE, text: 'дай мне текст тура ID71 в формате word' });
    const t = unhtml(s!.text);
    expect(t).toContain('Текст тура «Ганальские Востряки» — как записан на Ведаре.');
    expect(t).toMatch(/Не записано: анонс, описание, программа, что включено, что не входит, что взять с собой, безопасность\./);
    expect(t).toContain('Файлом Word текст не выгружается');
  });

  it('строки ответа — фразы правки: прислав строку обратно, получаешь то же значение', async () => {
    const program = [{ title: 'Дорога', text: 'Выезд в 7:00' }, { title: 'Озёра', text: 'Купание' }];
    db([row({ id: '76', title: 'Вачкажец + озёрки', description: 'Поход к озёрам.\nВторой абзац.', program, what_to_bring: ['Ботинки', 'Куртка'], safety_notes: ['Медведи, держаться группы'] })]);
    const s = await captureGuideTourEdit({ channel: 'max', chatId: 1, partner: GUIDE, text: 'текст тура Вачкажец' });
    const codes = [...s!.text.matchAll(/<code>([\s\S]*?)<\/code>/g)].map((m) => unhtml(m[1]!));
    expect(codes).toHaveLength(4);
    const parsed = codes.map((c) => parseTourEdit(c));
    for (const p of parsed) expect(p && p.ok, JSON.stringify(p)).toBe(true);
    const byField = Object.fromEntries(parsed.map((p) => [p!.ok ? p!.edit.field : 'x', p!.ok ? p!.edit.value : null]));
    expect(byField.description).toBe('Поход к озёрам.\nВторой абзац.');
    expect(byField.program).toEqual(program);
    expect(byField.what_to_bring).toEqual(['Ботинки', 'Куртка']);
    expect(byField.safety_notes).toEqual(['Медведи, держаться группы']);
  });

  it('описание длиннее сообщения — не строкой для копирования, а началом и ссылкой на сайт', async () => {
    db([row({ description: 'Слово '.repeat(700) })]);
    const s = await captureGuideTourEdit({ channel: 'max', chatId: 1, partner: GUIDE, text: 'текст тура 71' });
    expect(s!.text).not.toMatch(/<code>[^<]*описание:/);
    expect(unhtml(s!.text)).toMatch(/Описание — 4200 знаков, целиком в сообщение не помещается\. Начало: «Слово/);
    expect(s!.text).toContain('https://vedarai.ru/hub/guide/own');
    expect(s!.text.length).toBeLessThan(4000);
  });

  it('номер чужого тура — «среди ваших нет» и список своих', async () => {
    db([row({}), row({ id: '76', title: 'Вачкажец + озёрки' })]);
    const s = await captureGuideTourEdit({ channel: 'max', chatId: 1, partner: GUIDE, text: 'текст тура ID999' });
    const t = unhtml(s!.text);
    expect(t).toContain('Тура №999 среди ваших нет.');
    expect(t).toContain('• Вачкажец + озёрки');
  });

  it('тур не назван — просьба назвать и список всех туров', async () => {
    db(Array.from({ length: 13 }, (_, i) => row({ id: String(70 + i), title: `Тур номер ${i + 1}` })));
    const s = await captureGuideTourEdit({ channel: 'max', chatId: 1, partner: GUIDE, text: 'дай текст тура' });
    const t = unhtml(s!.text);
    expect(t).toContain('Какой тур? Напишите «текст тура» и название');
    expect(t).toContain('• Тур номер 13');
  });
});

describe('название тура словами гида: связки не мешают (05.11)', () => {
  it('«Вачкажец и Озерки» — тур «Вачкажец + озёрки»', async () => {
    db([row({}), row({ id: '76', title: 'Вачкажец + озёрки', description: 'Поход к озёрам.' })]);
    const s = await captureGuideTourEdit({ channel: 'max', chatId: 1, partner: GUIDE, text: 'текст тура Вачкажец и Озерки' });
    expect(unhtml(s!.text)).toContain('Текст тура «Вачкажец + озёрки»');
  });
});
