/**
 * Согласие партнёра на материалы сайта на настоящем PostgreSQL (миграция
 * 1321, решение владельца 23.10). Проверяется то, чего мок не видит:
 *
 *   · ссылка: выпуск, проверка, запись, повтор той же ссылкой — «использована»,
 *     новая ссылка гасит прежнюю (unknown) и снова открывает запись;
 *   · новое согласие гасит прежнее с причиной «заменено новым», и отзыв нового
 *     не воскрешает старое;
 *   · CHECK-и базы: своя страница в объёме обязательна, отзыв — только с
 *     причиной, чужое слово в объёме не пишется;
 *   · строка на странице: загрузчики перевозчика и прокатчика «Лагуны» (посев
 *     1318) видят действующее согласие без имени подписанта, а после отзыва —
 *     нет.
 *
 * Без KERNEL_PG_TEST_URL файл честно пропускается — «не прогнано», а не
 * «прошло».
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

  it('ссылка: выпуск → проверка → запись → повтор «использована» → новая ссылка гасит прежнюю', async () => {
    const mc = await import('@/lib/partners/material-consent');
    const first = await mc.issueConsentInvite(lagunaId);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const check = await mc.checkConsentInvite(first.key);
    expect(check).toMatchObject({ state: 'ok', partnerName: 'Лагуна Прокат', current: null });
    if (check.state === 'ok') expect(check.sites).toEqual(['https://лагунапрокат.рф/']);

    const granted = await mc.grantMaterialsConsent({
      key: first.key, signerName: 'Анна Петрова', signerRole: 'владелец', materials: ['photos', 'logo'], surfaces: ['own_page', 'showcases'], pd: pd(),
    });
    expect(granted).toMatchObject({ ok: true, partnerName: 'Лагуна Прокат' });
    expect(await mc.grantMaterialsConsent({
      key: first.key, signerName: 'Анна Петрова', signerRole: 'владелец', materials: ['photos'], surfaces: ['own_page'], pd: pd(),
    })).toEqual({ ok: false, reason: 'used' });
    expect(await mc.checkConsentInvite(first.key)).toEqual({ state: 'used' });

    const second = await mc.issueConsentInvite(lagunaId);
    if (!second.ok) throw new Error('ссылка не выпущена');
    expect(await mc.checkConsentInvite(first.key)).toEqual({ state: 'unknown' });
    const again = await mc.checkConsentInvite(second.key);
    expect(again).toMatchObject({ state: 'ok', current: { materials: ['photos', 'logo'], surfaces: ['own_page', 'showcases'] } });
    // Имени прежнего подписанта в ответе ссылки нет: её могли переслать.
    expect(JSON.stringify(again)).not.toContain('Анна');
  });

  it('новое согласие гасит прежнее «заменено новым»; отзыв нового не воскрешает старое', async () => {
    const mc = await import('@/lib/partners/material-consent');
    const inv = await mc.issueConsentInvite(lagunaId);
    if (!inv.ok) throw new Error('ссылка не выпущена');
    await mc.grantMaterialsConsent({
      key: inv.key, signerName: 'Иван Сидоров', signerRole: 'директор', materials: ['texts'], surfaces: ['own_page'], pd: pd(),
    });
    const list = await mc.loadPartnerConsents(lagunaId);
    expect(list.filter((c) => !c.revokedAt)).toHaveLength(1);
    expect(list[0]).toMatchObject({ signerName: 'Иван Сидоров', materials: ['texts'], revokedAt: null, textVersion: '2026-10-23' });
    expect(list.slice(1).every((c) => c.revokeReason === mc.SUPERSEDED_REASON)).toBe(true);

    expect(await mc.revokeMaterialsConsent(lagunaId, 'Написал в MAX 25.10: снять всё')).toEqual({ ok: true, revoked: 1 });
    const after = await mc.loadPartnerConsents(lagunaId);
    expect(after.every((c) => c.revokedAt !== null)).toBe(true);
    expect(await mc.revokeMaterialsConsent(lagunaId, 'повторный отзыв ни о чём')).toEqual({ ok: false, reason: 'nothing_active' });
  });

  it('CHECK-и базы: своя страница обязательна, чужое слово не пишется, отзыв — только с причиной', async () => {
    const base = `INSERT INTO partner_material_consents
      (partner_id, text_version, materials, surfaces, signer_name, signer_role, source, pd_consent_at, pd_consent_ip, pd_consent_source, pd_consent_version)
      VALUES ($1, '2026-10-23', $2::text[], $3::text[], 'Анна', 'владелец', 'link', NOW(), '1.1.1.1', 'x', 'v')`;
    expect(await sqlState(pool.query(base, [lagunaId, ['photos'], ['showcases']]))).toBe('23514');
    expect(await sqlState(pool.query(base, [lagunaId, ['обои'], ['own_page']]))).toBe('23514');
    expect(await sqlState(pool.query(base, [lagunaId, [], ['own_page']]))).toBe('23514');
    const ok = await pool.query<{ id: string }>(`${base} RETURNING id::text`, [lagunaId, ['photos'], ['own_page']]);
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
      key: inv.key, signerName: 'Анна Петрова', signerRole: 'владелец', materials: ['logo', 'photos'], surfaces: ['own_page'], pd: pd(),
    });
    const carrier = await loadCarrierBySlug('laguna-prokat');
    const rental = await loadRentalCompanyBySlug('laguna-prokat');
    for (const page of [carrier, rental]) {
      expect(page?.materialsConsent).toMatchObject({ materials: ['photos', 'logo'], surfaces: ['own_page'], sites: ['https://лагунапрокат.рф/'] });
      expect(page?.materialsConsent?.grantedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(JSON.stringify(page?.materialsConsent)).not.toContain('Анна');
    }

    await mc.revokeMaterialsConsent(lagunaId, 'Отзыв в тесте: проверка страницы');
    expect((await loadCarrierBySlug('laguna-prokat'))?.materialsConsent).toBeNull();
    expect((await loadRentalCompanyBySlug('laguna-prokat'))?.materialsConsent).toBeNull();
  });
});
