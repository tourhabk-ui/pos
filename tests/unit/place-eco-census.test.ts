// @vitest-environment node
/**
 * Перепись режима мест (GET /api/cron/place-eco-census) — что она отдаёт
 * (15.10, перепись по схеме парков).
 *
 * Поимённый список мест без записанного режима нужен, чтобы сверить их точки
 * с контурами охраняемых территорий: 'none' проставила миграция 170 всем
 * оставшимся видимым местам одним UPDATE, без сверки, — значит «нет режима» и
 * «не записано» в переписи стоят рядом. Только чтение: ни одного UPDATE или
 * INSERT в отправленном SQL.
 *
 * Вызовом роута с подставной базой. Сам отбор (видимые, «нет» и «не записано»,
 * скобки вокруг OR) проверен на PostgreSQL: без скобок в список попадает
 * скрытое место — мок такого не видит.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sent: string[] = [];
vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: async (sql: string) => {
      sent.push(sql);
      if (/GROUP BY p\.eco_zone\s+ORDER BY COUNT/.test(sql)) {
        return { rows: [{ eco_zone: 'none', places: '2', permit_true: '0', permit_false: '2', permit_null: '0', rules_present: '0', rules_withdrawn: '0' }] };
      }
      if (/p\.eco_zone IS NULL OR p\.eco_zone = 'none'/.test(sql)) {
        return { rows: [
          { id: 'p1', name: 'Ново-Место', lat: '54.1', lng: '159.6', eco_zone: 'none' },
          { id: 'p2', name: 'Без режима', lat: '53.0', lng: '158.7', eco_zone: null },
        ] };
      }
      return { rows: [] };
    },
  },
}));

beforeEach(() => { sent.length = 0; process.env.CRON_SECRET = 'test-secret'; });

async function call(auth = 'Bearer test-secret') {
  const { GET } = await import('@/app/api/cron/place-eco-census/route');
  const { NextRequest } = await import('next/server');
  const res = await GET(new NextRequest('http://localhost/api/cron/place-eco-census', { headers: { authorization: auth } }));
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

describe('перепись режима мест', () => {
  it('без секрета — 401', async () => {
    expect((await call('Bearer wrong')).status).toBe(401);
  });

  it('места без режима — поимённо, с точкой; «нет» и «не записано» рядом', async () => {
    const { status, body } = await call();
    expect(status).toBe(200);
    expect(body.regime_unrecorded).toEqual({
      truncated: false,
      places: [
        { id: 'p1', name: 'Ново-Место', lat: 54.1, lng: 159.6, zone: 'none' },
        { id: 'p2', name: 'Без режима', lat: 53.0, lng: 158.7, zone: null },
      ],
    });
  });

  it('только чтение и только видимые места', async () => {
    await call();
    expect(sent.length).toBeGreaterThanOrEqual(4);
    for (const sql of sent) {
      expect(sql).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/i);
      expect(sql).toMatch(/p\.is_visible = TRUE AND p\.merged_into_id IS NULL/);
    }
  });
});
