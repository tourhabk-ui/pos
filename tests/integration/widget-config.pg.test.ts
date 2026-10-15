/**
 * Настройки виджетов партнёра на настоящем PostgreSQL — находка аудита 15.10
 * WID-config (карт-бланш владельца 15.10).
 *
 * Что было на проде:
 *   - кнопка формы заявки «Местечка» подписана «Чат» (заготовка DEFAULT
 *     колонки из 142), а над полями формы — приветствие чата «…спрашивайте»;
 *   - PATCH админки заменял widget_config целиком: смена цвета стирала
 *     приветствие, подпись и отступ, поставленные миграциями;
 *   - заявки с формы виджета ложились в канал 'other'.
 *
 * Мок ответил бы на любой SQL, поэтому здесь — схема baseline прода плюс
 * всех миграций, и судится то, что видно только на базе:
 *   - цепочка 1216 → 1260 → 1280 даёт «Местечку» подпись «Заявка на тур» и
 *     вступление формы; lead.js и /api/widget/partner читают ЭТУ строку;
 *   - 1280 не перетирает подпись и вступление, выбранные самим партнёром,
 *     а новым партнёрам заготовку больше не пишет;
 *   - PATCH сливает конфиг: присланный ключ меняется, остальные живут;
 *   - 1281 переводит в 'widget' только заявки формы виджета в 'other'/NULL:
 *     форма страницы оператора (согласие тоже 'widget'), псевдолид чата и
 *     канал, распознанный иначе, не трогаются; второй прогон — ноль строк.
 *
 * Своя база `widget_config_test`. Запуск ТРЕБУЕТ базы:
 * KERNEL_PG_TEST_URL=postgresql://user:pass@host/db. Без неё файл честно
 * пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { createTestDatabase } from '../helpers/pg-schema';

vi.mock('@/lib/auth/middleware', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/middleware')>()),
  requireAdmin: vi.fn(async () => ({ userId: 'admin-test', role: 'admin' })),
}));

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[widget-config.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'widget_config_test';
const MIG_1280 = readFileSync(join(process.cwd(), 'migrations/1280_mestechko_widget_button_and_form_intro.sql'), 'utf-8');
const MIG_1281 = readFileSync(join(process.cwd(), 'migrations/1281_leads_widget_form_channel.sql'), 'utf-8');

/** Заготовка колонки из 142 — то, что лежит у партнёров, заведённых до 1280. */
const LEGACY_142 = { greeting: 'Привет!', accentColor: '#D44A0C', buttonText: 'Чат', position: 'right' };

withPg('настройки виджета партнёра на настоящем PostgreSQL (WID-config)', () => {
  let pool: import('pg').Pool;

  beforeAll(async () => {
    const { Pool } = await import('pg');
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    pool = new Pool({ connectionString: dbUrl, max: 4 });
    // Роуты читают пул приложения — ему нужен тот же адрес.
    process.env.DATABASE_URL = dbUrl;
    process.env.DATABASE_SSL = 'false';
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    const { pool: appPool } = await import('@/lib/db-pool');
    await (appPool as unknown as { end?: () => Promise<void> }).end?.();
  });

  const cfg = async (slug: string) =>
    (await pool.query<{ widget_config: Record<string, unknown> | null }>(
      `SELECT widget_config FROM partners WHERE slug = $1`, [slug],
    )).rows[0]?.widget_config ?? null;

  async function leadJsButton(slug: string): Promise<{ status: number; text: string | null; accent: string | null }> {
    const { GET } = await import('@/app/api/widget/lead.js/route');
    const res = await GET(new NextRequest(`https://vedarai.ru/api/widget/lead.js?partner=${slug}`));
    const js = await res.text();
    // Значение подписи — из выданного скрипта, то есть из строки базы через
    // настоящий роут; исполнение скрипта в DOM судит юнит-сторож.
    const text = js.match(/var BTN_TEXT = '([^']*)'/)?.[1] ?? null;
    const accent = js.match(/var ACCENT = '([^']*)'/)?.[1] ?? null;
    return { status: res.status, text, accent };
  }

  it('цепочка миграций: у «Местечка» кнопка «Заявка на тур», своё вступление формы, приветствие чата цело', async () => {
    const c = await cfg('mestechko');
    expect(c).not.toBeNull();
    expect(c!.buttonText).toBe('Заявка на тур');
    expect(String(c!.formIntro)).toContain('«Местечко Камчатка» свяжется с вами');
    expect(String(c!.formIntro)).not.toMatch(/сегодня|в течение|минут|час/);
    expect(String(c!.greeting)).toContain('Я Кузьмич');

    const btn = await leadJsButton('mestechko');
    expect(btn.status).toBe(200);
    expect(btn.text).toBe('Заявка на тур');
    expect(btn.accent).toBe('#C2410A');
  });

  it('/api/widget/partner/mestechko отдаёт форме вступление, а не приветствие чата', async () => {
    const { GET } = await import('@/app/api/widget/partner/[partnerId]/route');
    const res = await GET(new NextRequest('https://vedarai.ru/api/widget/partner/mestechko'),
      { params: Promise.resolve({ partnerId: 'mestechko' }) });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { formIntro: string; greeting: string; accentColor: string } };
    expect(body.data.formIntro).toContain('«Местечко Камчатка» свяжется с вами');
    expect(body.data.formIntro).not.toBe(body.data.greeting);
    expect(body.data.accentColor).toBe('#C2410A');
  });

  it('1280 не перетирает выбор партнёра и повтор ничего не меняет', async () => {
    await pool.query(
      `UPDATE partners SET widget_config = widget_config || '{"buttonText":"Записаться","formIntro":"Пишите — ответим."}'::jsonb
        WHERE slug = 'mestechko'`,
    );
    const before = await cfg('mestechko');
    await pool.query(MIG_1280);
    await pool.query(MIG_1280);
    const after = await cfg('mestechko');
    expect(after).toEqual(before);
    expect(after!.buttonText).toBe('Записаться');
    expect(after!.formIntro).toBe('Пишите — ответим.');

    // Обратно к заготовке — 1280 снова ставит подпись по смыслу.
    await pool.query(
      `UPDATE partners SET widget_config = (widget_config - 'formIntro') || '{"buttonText":"Чат"}'::jsonb
        WHERE slug = 'mestechko'`,
    );
    await pool.query(MIG_1280);
    const fixed = await cfg('mestechko');
    expect(fixed!.buttonText).toBe('Заявка на тур');
    expect(String(fixed!.formIntro)).toContain('«Местечко Камчатка»');
  });

  it('1280 трогает только «Местечко»; новому партнёру заготовка 142 больше не пишется', async () => {
    await pool.query(
      `INSERT INTO partners (name, category, contact, slug, widget_enabled, widget_config)
       VALUES ('Тест Заготовка', 'operator', '{}'::jsonb, 'test-legacy', TRUE, $1::jsonb)`,
      [JSON.stringify(LEGACY_142)],
    );
    await pool.query(MIG_1280);
    expect(await cfg('test-legacy')).toEqual(LEGACY_142);

    await pool.query(
      `INSERT INTO partners (name, category, contact, slug, widget_enabled)
       VALUES ('Тест Новый', 'operator', '{}'::jsonb, 'test-new', TRUE)`,
    );
    expect(await cfg('test-new')).toEqual({});

    // Читатели: заготовка и пустота — «не задано», а не «Чат» и не #D44A0C.
    for (const slug of ['test-legacy', 'test-new']) {
      const btn = await leadJsButton(slug);
      expect(btn.status).toBe(200);
      expect(btn.text).toBe('Заявка на тур');
      expect(btn.accent).toBe('#C2410A');
    }
  });

  it('PATCH админки сливает widget_config: смена цвета не стирает приветствие и подпись', async () => {
    const id = (await pool.query<{ id: string }>(`SELECT id FROM partners WHERE slug = 'mestechko'`)).rows[0].id;
    const before = await cfg('mestechko');
    const { PATCH } = await import('@/app/api/admin/operators/[id]/widget/route');
    const patch = (body: unknown, pid = id) => PATCH(
      new NextRequest(`https://vedarai.ru/api/admin/operators/${pid}/widget`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: pid }) },
    );

    const res = await patch({ widget_config: { accentColor: '#003466' } });
    expect(res.status).toBe(200);
    const after = await cfg('mestechko');
    expect(after).toEqual({ ...before, accentColor: '#003466' });

    // Тумблер приходит без конфига — конфиг не трогается вовсе.
    expect((await patch({ widget_enabled: true })).status).toBe(200);
    expect(await cfg('mestechko')).toEqual(after);

    // Несуществующий оператор — честный 404, а не «успех».
    const missing = await patch({ widget_enabled: false }, '00000000-0000-4000-8000-0000000000ff');
    expect(missing.status).toBe(404);
    expect(missing).toBeInstanceOf(NextResponse);
  });

  it('1281: в «widget» уходят только заявки формы виджета из other/NULL; повтор — ноль строк', async () => {
    const lead = async (sourceData: Record<string, unknown> | null, channel: string | null, sourceUrl: string | null = null) =>
      (await pool.query<{ id: string }>(
        `INSERT INTO leads (name, phone, source_url, source_data, source_channel)
         VALUES ('Тест', '+70000000000', $1, $2::jsonb, $3) RETURNING id`,
        [sourceUrl, sourceData ? JSON.stringify(sourceData) : null, channel],
      )).rows[0].id;

    const ids = {
      formOther: await lead({ source: 'partner_widget', partner_slug: 'mestechko' }, 'other'),
      formNull: await lead({ source: 'partner_widget', partner_slug: 'fishingkam' }, null),
      formMcp: await lead({ source: 'partner_widget', partner_slug: 'mestechko' }, 'mcp'),
      operatorPage: await lead({ source: 'operator_page', partner_slug: 'mestechko' }, 'site', 'https://vedarai.ru/mestechko'),
      // Тот же partner_slug и согласие 'widget', канал не распознан — всё равно
      // не виджет: признак только source.
      operatorPageOther: await lead({ source: 'operator_page', partner_slug: 'mestechko' }, 'other'),
      chat: await lead({ type: 'widget', partner_id: 'mestechko' }, 'widget'),
      plain: await lead(null, 'other'),
    };
    const channel = async (id: string) =>
      (await pool.query<{ source_channel: string | null }>(`SELECT source_channel FROM leads WHERE id = $1`, [id])).rows[0].source_channel;

    const first = await pool.query(MIG_1281);
    expect(first.rowCount).toBe(2);
    expect(await channel(ids.formOther)).toBe('widget');
    expect(await channel(ids.formNull)).toBe('widget');
    expect(await channel(ids.formMcp)).toBe('mcp');
    expect(await channel(ids.operatorPage)).toBe('site');
    expect(await channel(ids.operatorPageOther)).toBe('other');
    expect(await channel(ids.chat)).toBe('widget');
    expect(await channel(ids.plain)).toBe('other');

    const second = await pool.query(MIG_1281);
    expect(second.rowCount).toBe(0);
  });
});
