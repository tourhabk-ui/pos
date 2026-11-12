// @vitest-environment node
/**
 * /api/trip/plan снят (#3199, (а)-3): четвёртый «планировщик» на модели мимо
 * трёх движков подбора, без вызывающих, с запросом к несуществующим колонкам.
 * Адрес отвечает 410 и называет, где план собирается теперь, а перепись
 * роутов относит его к снятым, а не к «проверки не нашли».
 */
import { describe, it, expect } from 'vitest';
import { POST } from '@/app/api/trip/plan/route';
import { inventoryRoutes } from '@/lib/security/route-inventory';

describe('/api/trip/plan — снят', () => {
  it('POST отвечает 410 и называет, куда идти', async () => {
    const res = await POST();
    expect(res.status).toBe(410);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain('vedarai.ru/planner');
    expect(body.error).toContain('Кузьмич');
  });

  it('перепись роутов видит его снятым', () => {
    const rec = inventoryRoutes(process.cwd()).find((r) => r.url === '/api/trip/plan');
    expect(rec?.protection).toBe('deprecated_stub');
  });
});
