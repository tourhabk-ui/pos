/**
 * Документ гида (.docx) из MAX → поля своего тура (слово владельца 30.10:
 * «гид должен полностью управлять своей ролью из MAX»; гид правит тексты туров
 * в Word/Google-документах).
 *
 * Судится поведением, на настоящем .docx, собранном в памяти (tests/helpers/docx):
 *  - разбор файла: абзацы по порядку, пункты списка, сущности XML; не docx,
 *    битый, огромный и «zip-бомба» — отказ с причиной, а не пустой текст;
 *  - разделы по заголовкам документа гида → поля тура; слова гида не
 *    переписываются; не помещается в пределы сайта — поле не пишется и
 *    названо; подзаголовок не угадывается анонсом;
 *  - без кнопки не пишется ничего: файл заводит только черновик;
 *  - запись — той же функцией сайта (`writeTourPatch`), по полю или всё;
 *  - не гид со своими турами и не .docx — файл идёт прежним путём.
 * Путь записи на настоящей базе — tests/integration/chat-cabinet.pg.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { docx, zip, GUIDE_DOC } from '../helpers/docx';

const h = vi.hoisted(() => ({ query: vi.fn(), write: vi.fn() }));

vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: (sql: string, params?: unknown[]) => h.query(sql, params ?? []),
    connect: async () => ({ query: (sql: string, params?: unknown[]) => h.query(sql, params ?? []), release: () => undefined }),
  },
}));
vi.mock('@/lib/tours/tour-write', async (orig) => {
  const real = await orig<typeof import('@/lib/tours/tour-write')>();
  return { ...real, writeTourPatch: h.write };
});
vi.mock('@/lib/seo/indexnow', () => ({ pingTourChanged: vi.fn() }));

const { docxParagraphs, MAX_DOCX_BYTES, MAX_XML_BYTES } = await import('@/lib/docs/docx-text');
const { docSections } = await import('@/lib/guides/tour-edit/doc-sections');
const { captureGuideTourDoc } = await import('@/lib/guides/tour-edit/doc-flow');
const { saveDocDraft } = await import('@/lib/guides/tour-edit/doc-store');
const { parseCabinetPress, cabinetPayload, CABINET_PAYLOAD_MAX_BYTES } = await import('@/lib/chat-cabinet/payload');

const GUIDE = {
  partnerId: '12121212-1212-4121-8121-121212121212', partnerName: 'Гид', slug: 'g', category: 'guide',
  crmCategory: 'guide', userId: 'user-guide', sellsTours: true,
} as unknown as import('@/lib/kuzmich/operator-chat').PartnerChatContext;
const DRAFT = 'dddddddd-1111-4222-8333-444444444444';
const CHAT = 77;

const TOUR_ROW = {
  id: '77', title: 'Восхождение на вулкан Горелый', slug: 'gorely', is_active: true, is_published: true,
  base_price: '15000', price_unit: 'per_person', max_participants: 8, short_description: null, description: 'Старое.',
  program: null, included: null, not_included: null, what_to_bring: null, safety_notes: null, main_place_id: null,
};

interface Db { draft: Record<string, unknown> | null; writes: string[] }
const db: Db = { draft: null, writes: [] };

function fake(sql: string, params: unknown[]): { rows: unknown[]; rowCount: number } {
  const res = (rows: unknown[], rowCount = rows.length) => ({ rows, rowCount });
  if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql.trim())) return res([]);
  if (/^\s*(UPDATE|INSERT|DELETE)/.test(sql)) db.writes.push(sql.replace(/\s+/g, ' ').trim());
  if (/FROM operator_tours t/.test(sql)) return res([TOUR_ROW]);
  if (/INSERT INTO tour_doc_drafts/.test(sql)) {
    db.draft = {
      id: DRAFT, tour_id: params[3], candidate_ids: params[4], doc_values: JSON.parse(String(params[5])),
      live_values: params[6] === null ? null : JSON.parse(String(params[6])), saved_fields: [], status: 'pending', expired: false,
    };
    return res([{ id: DRAFT }]);
  }
  if (/FROM tour_doc_drafts/.test(sql)) return res(db.draft && params[3] === String(CHAT) ? [db.draft] : []);
  return res([], 1);
}

beforeEach(() => {
  h.query.mockReset().mockImplementation(async (sql: string, params: unknown[]) => fake(sql, params));
  h.write.mockReset().mockResolvedValue({ outcome: 'written', row: { title: TOUR_ROW.title } });
  db.draft = null;
  db.writes = [];
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('разбор .docx', () => {
  it('абзацы по порядку, пункты списка, сущности XML', () => {
    const r = docxParagraphs(docx(['«Тур»', { text: 'ботинки & шапка <тёплая>', list: true }, '  ']));
    expect(r).toEqual({ ok: true, paragraphs: [
      { text: '«Тур»', listItem: false, heading: false },
      { text: 'ботинки & шапка <тёплая>', listItem: true, heading: false },
    ] });
  });

  it('не docx, битый, огромный и «zip-бомба» — отказ с причиной, а не пустой текст', () => {
    expect(docxParagraphs(Buffer.from('это не zip'.repeat(10)))).toEqual({ ok: false, reason: 'not_docx' });
    expect(docxParagraphs(zip([{ name: 'other.xml', data: Buffer.from('<x/>'), method: 0 }]))).toEqual({ ok: false, reason: 'not_docx' });
    expect(docxParagraphs(Buffer.alloc(MAX_DOCX_BYTES + 1))).toEqual({ ok: false, reason: 'too_big' });
    const bomb = zip([{ name: 'word/document.xml', data: Buffer.from('<w:body/>'), method: 8, usize: MAX_XML_BYTES + 1 }]);
    expect(docxParagraphs(bomb)).toEqual({ ok: false, reason: 'too_big' });
    const broken = docx(['«Тур»']);
    broken.fill(0x41, 120, 180);
    expect(docxParagraphs(broken).ok).toBe(false);
  });
});

describe('разделы документа гида → поля тура', () => {
  const paragraphs = () => {
    const r = docxParagraphs(docx(GUIDE_DOC));
    if (!r.ok) throw new Error('образец не разобрался');
    return r.paragraphs;
  };

  it('название — из «ёлочек», подзаголовок не угадывается; слова гида — как написаны', () => {
    const s = docSections(paragraphs());
    expect(s.tourWords).toBe('Восхождение на вулкан Горелый');
    expect(s.skipped).toEqual(['Экскурсия на вулкан Горелый и лавовые пещеры']);
    expect(s.values.description).toBe('Вулкан Горелый (1829 м) — действующий вулкан на юге Камчатки.');
    expect(s.values.program).toEqual([
      { title: 'Дорога на перевал', text: 'Выезд в 7:00, дорога около 2,5 часов.' },
      { title: 'Восхождение', text: '2–3 часа по лавовым полям.' },
    ]);
    // Подпись группы «Одежда и обувь:» пунктом не стала.
    expect(s.values.what_to_bring).toEqual(['треккинговые ботинки;', 'ветрозащитная куртка & шапка <тёплая>;']);
    expect(s.values.included).toEqual(['Трансфер на внедорожнике.']);
    // «Сколько длится» — с заголовком раздела; «Важно знать» — как есть.
    expect(s.values.safety_notes).toEqual(['Сколько длится: Около 12 часов.', 'К активной воронке близко не подходить.']);
    expect(s.rejects).toEqual([]);
  });

  it('не помещается в пределы сайта — поле не пишется и названо, остальные — пишутся', () => {
    const s = docSections(docxParagraphsOk(['«Тур»', 'Важно знать', { text: 'х'.repeat(201), list: true }, 'Что взять с собой', { text: 'куртка', list: true }]));
    expect(s.rejects).toEqual([{ field: 'safety_notes', reject: { reason: 'item_too_long', index: 1, max: 200 } }]);
    expect(s.values).toEqual({ what_to_bring: ['куртка'] });
  });
});

function docxParagraphsOk(lines: Parameters<typeof docx>[0]) {
  const r = docxParagraphs(docx(lines));
  if (!r.ok) throw new Error('не разобрался');
  return r.paragraphs;
}

describe('файл в чате: без кнопки не пишется; запись — функцией сайта', () => {
  it('документ гида — предпросмотр по полям и кнопки; в тур не пишется ничего', async () => {
    const s = await captureGuideTourDoc({ channel: 'max', chatId: CHAT, partner: GUIDE, fileName: 'Горелый.docx', caption: '', bytes: docx(GUIDE_DOC) });
    expect(s?.text).toContain('Документ → тур «Восхождение на вулкан Горелый»');
    expect(s?.text).toContain('было: 7 знаков: «Старое.»');
    expect(s?.text).toContain('станет: 2 шага: Дорога на перевал; Восхождение');
    expect(s?.text).toContain('ветрозащитная куртка &amp; шапка &lt;тёплая&gt;');
    expect(s?.text).toContain('Подзаголовок «Экскурсия на вулкан Горелый и лавовые пещеры» — не записываю');
    const buttons = s?.rows.flat().map((b) => b.text) ?? [];
    expect(buttons).toEqual(expect.arrayContaining(['Сохранить всё (5)', 'Сохранить: Описание', 'Отмена']));
    expect(h.write).not.toHaveBeenCalled();
    expect(db.writes.filter((w) => /operator_tours/.test(w))).toEqual([]);
    expect(db.writes.some((w) => /^INSERT INTO tour_doc_drafts/.test(w))).toBe(true);
  });

  it('«Сохранить: поле» — writeTourPatch одним полем, владелец — карточка; «Сохранить всё» — остальные', async () => {
    await captureGuideTourDoc({ channel: 'max', chatId: CHAT, partner: GUIDE, fileName: 'g.docx', caption: '', bytes: docx(GUIDE_DOC) });
    const one = await saveDocDraft({ partnerId: GUIDE.partnerId, channel: 'max', chatId: CHAT, draftId: DRAFT }, 'what_to_bring');
    expect(one.kind).toBe('saved');
    expect(h.write).toHaveBeenCalledTimes(1);
    expect(h.write.mock.calls[0]![1]).toMatchObject({ tourId: '77', ownerId: GUIDE.partnerId, input: { what_to_bring: ['треккинговые ботинки;', 'ветрозащитная куртка & шапка <тёплая>;'] } });
    expect(Object.keys(h.write.mock.calls[0]![1].input)).toEqual(['what_to_bring']);
    db.draft = { ...db.draft, saved_fields: ['what_to_bring'] };
    const all = await saveDocDraft({ partnerId: GUIDE.partnerId, channel: 'max', chatId: CHAT, draftId: DRAFT }, 'all');
    expect(all.kind === 'saved' && all.remaining).toEqual([]);
    expect(Object.keys(h.write.mock.calls[1]![1].input).sort()).toEqual(['description', 'included', 'program', 'safety_notes']);
  });

  it('чужой чат — «не найден», ничего не пишется', async () => {
    await captureGuideTourDoc({ channel: 'max', chatId: CHAT, partner: GUIDE, fileName: 'g.docx', caption: '', bytes: docx(GUIDE_DOC) });
    expect((await saveDocDraft({ partnerId: GUIDE.partnerId, channel: 'max', chatId: CHAT + 1, draftId: DRAFT }, 'all')).kind).toBe('not_found');
    expect(h.write).not.toHaveBeenCalled();
  });

  it('не гид со своими турами и не .docx — прежним путём; файл не скачался — так и сказано', async () => {
    const bytes = docx(GUIDE_DOC);
    expect(await captureGuideTourDoc({ channel: 'max', chatId: CHAT, partner: { ...GUIDE, sellsTours: false }, fileName: 'g.docx', caption: '', bytes })).toBeNull();
    expect(await captureGuideTourDoc({ channel: 'max', chatId: CHAT, partner: { ...GUIDE, category: 'operator' }, fileName: 'g.docx', caption: '', bytes })).toBeNull();
    expect(await captureGuideTourDoc({ channel: 'max', chatId: CHAT, partner: GUIDE, fileName: 'g.pdf', caption: '', bytes })).toBeNull();
    const failed = await captureGuideTourDoc({ channel: 'max', chatId: CHAT, partner: GUIDE, fileName: 'g.docx', caption: '', bytes: null });
    expect(failed?.text).toMatch(/не скачался/);
    expect(db.writes).toEqual([]);
  });

  it('кнопки документа разбираются обратно и влезают в 64 байта', () => {
    for (const [p, want] of [
      [cabinetPayload.docSaveAll(DRAFT), { kind: 'doc_save', draftId: DRAFT, field: null }],
      [cabinetPayload.docSaveField(DRAFT, 5), { kind: 'doc_save', draftId: DRAFT, field: 5 }],
      [cabinetPayload.docCancel(DRAFT), { kind: 'doc_cancel', draftId: DRAFT }],
      [cabinetPayload.docTour(DRAFT, 7), { kind: 'doc_tour', draftId: DRAFT, index: 7 }],
    ] as const) {
      expect(parseCabinetPress(p)).toEqual(want);
      expect(Buffer.byteLength(p)).toBeLessThanOrEqual(CABINET_PAYLOAD_MAX_BYTES);
    }
    for (const bad of ['cb:q', `cb:q:f:${DRAFT}:6`, `cb:q:t:${DRAFT}:8`, 'cb:q:a:1']) expect(parseCabinetPress(bad), bad).toBeNull();
  });
});
