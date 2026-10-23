/**
 * Согласие партнёра на материалы сайта и сайт в форме партнёра — на
 * настоящем PostgreSQL (миграция 1321; оба пункта из одного сообщения
 * владельца 23.10: «почему сайт не заполнен? и нужна форма согласия об
 * использовании матерьялов сайтов партнеров на нашем сайте»). Проверяется
 * то, чего мок не видит:
 *
 *   · ссылка: выпуск, проверка, запись, повтор той же ссылкой — «использована»,
 *     новая ссылка гасит прежнюю (unknown) и снова открывает запись;
 *     состояние ссылки для админки — «ждёт», «использована», «истекла»;
 *   · в базу пишется текст, собранный сервером из имени и сайтов партнёра;
 *     текст страницы разошёлся с ним — записи нет, ссылка не погашена;
 *   · новое согласие гасит прежнее с причиной «заменено новым», и отзыв нового
 *     не воскрешает старое;
 *   · CHECK-и базы: короткий текст не пишется, отзыв — только с причиной;
 *   · строка на странице: загрузчики перевозчика и прокатчика «Лагуны» (посев
 *     1318) видят действующее согласие без имени подписанта, а после отзыва —
 *     нет;
 *   · форма партнёра в админке (PUT): непустой массив людей в contacts не
 *     стирается, сохранение без правки сайта не откатывает сайт, который
 *     оператор сменил в кабинете, а правка сайта доходит до всех трёх мест.
 *
 * Без KERNEL_PG_TEST_URL файл честно пропускается — «не прогнано», а не
 * «прошло».
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('@/lib/auth/middleware', () => ({ requireAdmin: async () => ({ userId: 'admin', role: 'admin' }) }));
import { createTestDatabase, dropTestDatabase } from '../helpers/pg-schema';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[partner-material-consent.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'partner_material_consent_test';

withPg('согласие партнёра на материалы на настоящем PostgreSQL', () => {
  let pool: import('pg').Pool;
  let lagunaId = '';

  const pd = () => ({ at: new Date(), ip: '203.0.113.7', source: 'partner-consent-page', version: '2026-10-23-partner-signer' });
  const sqlState = async (p: Promise<unknown>): Promise<string | null> => {
    try { await p; return null; } catch (e) { return (e as { code?: string }).code ?? 'без кода'; }
  };

  beforeAll(async () => {
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    const { Pool } = await import('pg');
    pool = new Pool({ connectionString: dbUrl, max: 4 });
    process.env.DATABASE_URL = dbUrl;
    process.env.DATABASE_SSL = 'false';
    const r = await pool.query<{ id: string }>(`SELECT id::text FROM partners WHERE slug = 'laguna-prokat'`);
    lagunaId = r.rows[0]!.id;
  });

  afterAll(async () => {
    const { pool: appPool } = await import('@/lib/db-pool');
    await Promise.resolve(appPool.end()).catch(() => undefined);
    await pool?.end().catch(() => undefined);
    if (PG_URL) await dropTestDatabase(PG_URL, TEST_DB);
  });

  const doc = async () => {
    const { consentDocument } = await import('@/lib/legal/partner-materials-consent');
    return consentDocument({ partnerName: 'Лагуна Прокат', sites: ['https://лагунапрокат.рф/'] });
  };

  it('ссылка: выпуск → проверка → запись → повтор «использована» → новая ссылка гасит прежнюю', async () => {
    const mc = await import('@/lib/partners/material-consent');
    const first = await mc.issueConsentInvite(lagunaId);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(await mc.loadConsentInvite(lagunaId)).toMatchObject({ state: 'pending' });
    const check = await mc.checkConsentInvite(first.key);
    expect(check).toMatchObject({ state: 'ok', partnerName: 'Лагуна Прокат', current: null });
    if (check.state === 'ok') expect(check.sites).toEqual(['https://лагунапрокат.рф/']);

    const granted = await mc.grantMaterialsConsent({
      key: first.key, signerName: 'Анна Петрова', signerRole: 'владелец', shownText: await doc(), pd: pd(),
    });
    expect(granted).toMatchObject({ ok: true, partnerName: 'Лагуна Прокат' });
    expect(await mc.loadConsentInvite(lagunaId)).toMatchObject({ state: 'used' });
    expect(await mc.grantMaterialsConsent({
      key: first.key, signerName: 'Анна Петрова', signerRole: 'владелец', shownText: await doc(), pd: pd(),
    })).toEqual({ ok: false, reason: 'used' });
    expect(await mc.checkConsentInvite(first.key)).toEqual({ state: 'used' });

    // Записан текст, собранный сервером, — тот, что прочёл подписант.
    const stored = await pool.query<{ signed_text: string }>(
      `SELECT signed_text FROM partner_material_consents WHERE partner_id = $1 AND revoked_at IS NULL`, [lagunaId]);
    expect(stored.rows[0]?.signed_text).toBe(await doc());

    const second = await mc.issueConsentInvite(lagunaId);
    if (!second.ok) throw new Error('ссылка не выпущена');
    expect(await mc.checkConsentInvite(first.key)).toEqual({ state: 'unknown' });
    const again = await mc.checkConsentInvite(second.key);
    expect(again).toMatchObject({ state: 'ok', current: { sites: ['https://лагунапрокат.рф/'] } });
    // Имени прежнего подписанта в ответе нет: ссылку могли переслать.
    expect(JSON.stringify(again)).not.toContain('Анна');

    // Просроченная ссылка — «истекла» и для админки, и для ключа.
    await pool.query(`UPDATE partner_consent_invites SET expires_at = NOW() - interval '1 day' WHERE partner_id = $1`, [lagunaId]);
    expect(await mc.loadConsentInvite(lagunaId)).toMatchObject({ state: 'expired' });
    expect(await mc.checkConsentInvite(second.key)).toEqual({ state: 'expired' });
  });

  it('текст страницы разошёлся с серверным — записи нет, ссылка не погашена', async () => {
    const mc = await import('@/lib/partners/material-consent');
    const inv = await mc.issueConsentInvite(lagunaId);
    if (!inv.ok) throw new Error('ссылка не выпущена');
    const before = await pool.query(`SELECT count(*)::int AS n FROM partner_material_consents WHERE partner_id = $1`, [lagunaId]);
    const res = await mc.grantMaterialsConsent({
      key: inv.key, signerName: 'Анна Петрова', signerRole: 'владелец',
      shownText: (await doc()).replace('Лагуна Прокат', 'Другое имя'), pd: pd(),
    });
    expect(res).toEqual({ ok: false, reason: 'text_changed' });
    const after = await pool.query(`SELECT count(*)::int AS n FROM partner_material_consents WHERE partner_id = $1`, [lagunaId]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
    expect(await mc.checkConsentInvite(inv.key)).toMatchObject({ state: 'ok' });
  });

  it('новое согласие гасит прежнее «заменено новым»; отзыв нового не воскрешает старое', async () => {
    const mc = await import('@/lib/partners/material-consent');
    const inv = await mc.issueConsentInvite(lagunaId);
    if (!inv.ok) throw new Error('ссылка не выпущена');
    await mc.grantMaterialsConsent({
      key: inv.key, signerName: 'Иван Сидоров', signerRole: 'директор', shownText: await doc(), pd: pd(),
    });
    const list = await mc.loadPartnerConsents(lagunaId);
    expect(list.filter((c) => !c.revokedAt)).toHaveLength(1);
    expect(list[0]).toMatchObject({ signerName: 'Иван Сидоров', revokedAt: null, revokedOn: null, textVersion: '2026-10-23' });
    expect(list.slice(1).every((c) => c.revokeReason === mc.SUPERSEDED_REASON)).toBe(true);

    expect(await mc.revokeMaterialsConsent(lagunaId, 'Написал в MAX 25.10: снять всё')).toEqual({ ok: true, revoked: 1 });
    const after = await mc.loadPartnerConsents(lagunaId);
    expect(after.every((c) => c.revokedAt !== null)).toBe(true);
    expect(after[0]?.revokedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(await mc.revokeMaterialsConsent(lagunaId, 'повторный отзыв ни о чём')).toEqual({ ok: false, reason: 'nothing_active' });
  });

  it('CHECK-и базы: короткий текст не пишется, отзыв — только с причиной', async () => {
    const base = `INSERT INTO partner_material_consents
      (partner_id, text_version, signed_text, signer_name, signer_role, source, pd_consent_at, pd_consent_ip, pd_consent_source, pd_consent_version)
      VALUES ($1, '2026-10-23', $2, 'Анна', 'владелец', 'link', NOW(), '1.1.1.1', 'x', 'v')`;
    expect(await sqlState(pool.query(base, [lagunaId, 'да']))).toBe('23514');
    expect(await sqlState(pool.query(base, [lagunaId, ' '.repeat(300)]))).toBe('23514');
    const ok = await pool.query<{ id: string }>(`${base} RETURNING id::text`, [lagunaId, await doc()]);
    expect(await sqlState(pool.query(`UPDATE partner_material_consents SET revoked_at = NOW() WHERE id = $1`, [ok.rows[0]!.id]))).toBe('23514');
    expect(await sqlState(pool.query(`UPDATE partner_material_consents SET revoked_at = NOW(), revoke_reason = 'кратко' WHERE id = $1`, [ok.rows[0]!.id]))).toBe('23514');
    await pool.query(`UPDATE partner_material_consents SET revoked_at = NOW(), revoke_reason = 'проверка CHECK, строка теста' WHERE id = $1`, [ok.rows[0]!.id]);
  });

  it('страницы «Лагуны»: действующее согласие видно без имени подписанта, после отзыва — нет', async () => {
    const mc = await import('@/lib/partners/material-consent');
    const { loadCarrierBySlug } = await import('@/lib/transfers/charter');
    const { loadRentalCompanyBySlug } = await import('@/lib/rental/rental');

    const inv = await mc.issueConsentInvite(lagunaId);
    if (!inv.ok) throw new Error('ссылка не выпущена');
    await mc.grantMaterialsConsent({
      key: inv.key, signerName: 'Анна Петрова', signerRole: 'владелец', shownText: await doc(), pd: pd(),
    });
    const carrier = await loadCarrierBySlug('laguna-prokat');
    const rental = await loadRentalCompanyBySlug('laguna-prokat');
    for (const page of [carrier, rental]) {
      expect(page?.materialsConsent).toMatchObject({ sites: ['https://лагунапрокат.рф/'] });
      expect(page?.materialsConsent?.grantedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(JSON.stringify(page?.materialsConsent)).not.toContain('Анна');
    }

    await mc.revokeMaterialsConsent(lagunaId, 'Отзыв в тесте: проверка страницы');
    expect((await loadCarrierBySlug('laguna-prokat'))?.materialsConsent).toBeNull();
    expect((await loadRentalCompanyBySlug('laguna-prokat'))?.materialsConsent).toBeNull();
  });

  describe('форма партнёра в админке (PUT): сайт', () => {
    const put = async (id: string, website: string) => {
      const { PUT } = await import('@/app/api/admin/content/partners/[id]/route');
      const res = await PUT(new Request(`http://x/api/admin/content/partners/${id}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Проверка формы', description: 'новое описание', contact: { website } }),
      }) as never, { params: Promise.resolve({ id }) });
      expect(res.status).toBe(200);
      const r = await pool.query<{ contacts: unknown; website: string | null; contact: Record<string, unknown> }>(
        `SELECT contacts, website, contact FROM partners WHERE id = $1`, [id]);
      return r.rows[0]!;
    };
    const seed = async (contact: unknown, contacts: unknown, website: string | null) => {
      const r = await pool.query<{ id: string }>(
        `INSERT INTO partners (name, category, contact, contacts, website)
         VALUES ('Проверка формы', 'operator', $1::jsonb, $2::jsonb, $3) RETURNING id::text`,
        [JSON.stringify(contact), JSON.stringify(contacts), website]);
      return r.rows[0]!.id;
    };

    it('непустой массив людей в contacts не стирается ни при правке сайта, ни без неё', async () => {
      const people = [{ name: 'Анатолий', phone: '+79140000000' }, { address: 'Елизово', website: 'https://fishing.test' }];
      const id = await seed({}, people, null);
      expect((await put(id, '')).contacts).toEqual(people);
      const changed = await put(id, 'https://новый.test');
      expect(changed.contacts).toEqual(people);
      expect(changed.website).toBe('https://новый.test');
    });

    it('сохранение без правки сайта не откатывает сайт, сменённый оператором в кабинете', async () => {
      const id = await seed({ website: 'https://old-site.ru' }, { website: 'https://new-site.ru', email: 'a@b.test' }, null);
      // Форма показала бы new-site (adminContactView) — администратор сайт не трогал.
      const row = await put(id, 'https://new-site.ru');
      expect(row.contacts).toEqual({ website: 'https://new-site.ru', email: 'a@b.test' });
      expect(row.website).toBeNull();
    });

    it('поменянный сайт — во все три места; пустое поле — снимает с витрины и колонки', async () => {
      const id = await seed({}, { email: 'a@b.test' }, 'https://old.test');
      const set = await put(id, 'https://site.test');
      expect(set.contacts).toEqual({ email: 'a@b.test', website: 'https://site.test' });
      expect(set.website).toBe('https://site.test');
      expect(set.contact.website).toBe('https://site.test');
      const cleared = await put(id, '');
      expect(cleared.contacts).toEqual({ email: 'a@b.test' });
      expect(cleared.website).toBeNull();
    });
  });
});
