/**
 * GET /api/cron/partner-candidates-census — сколько у нас потенциальных
 * партнёров и насколько до них можно дотянуться.
 *
 * Запрос владельца 15.08: нужен агент, который находит небольших операторов
 * (одна-две активности) и готовит обращение. Прежде чем строить агента —
 * цифры: правило «сначала цифры, потом пороги». Если кандидатов пять, агент
 * не нужен; если двести — нужен.
 *
 * Два пула, и второй теплее первого:
 *   registry — записи официального реестра (official_registry_operators,
 *              миграция 742) без matched_partner_id: лицензированные
 *              операторы, которых у нас нет;
 *   dormant  — партнёры, УЖЕ заведённые у нас, но не доведённые до витрины:
 *              непубличные, без туров, без виджета. Эти однажды пришли сами.
 *
 * ПД: наружу идут названия компаний и ФЛАГИ наличия контактов, но НЕ сами
 * телефоны и почты. Ответ переписи читается из логов CI, а у ИП телефон —
 * персональные данные (152-ФЗ). Для решения «нужен ли агент» достаточно
 * знать, что контакт есть; сам контакт владелец берёт в кабинете, когда
 * дошёл до конкретного разговора.
 *
 * READ-ONLY, Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const NAMES_CAP = 300;

interface RegistryRow {
  name: string;
  registry_status: string | null;
  region: string | null;
  has_phone: boolean;
  has_email: boolean;
  has_website: boolean;
}

interface DormantRow {
  name: string;
  category: string;
  is_public: boolean;
  is_verified: boolean;
  tours: number;
  has_contacts: boolean;
}

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const [registryRes, dormantRes] = await Promise.all([
      // Кандидаты из официального реестра: нет связи с нашим партнёром.
      // Контакты не отдаём — только факт их наличия.
      pool.query<RegistryRow>(
        `SELECT name,
                registry_status,
                region,
                COALESCE(NULLIF(contacts->>'phone',   ''), '') <> '' AS has_phone,
                COALESCE(NULLIF(contacts->>'email',   ''), '') <> '' AS has_email,
                COALESCE(NULLIF(contacts->>'website', ''), '') <> '' AS has_website
           FROM official_registry_operators
          WHERE matched_partner_id IS NULL
          ORDER BY name`,
      ),
      // Спящие свои: заведены, но не доведены. tours — активные туры.
      pool.query<DormantRow>(
        `SELECT p.name,
                p.category,
                COALESCE(p.is_public, false)   AS is_public,
                COALESCE(p.is_verified, false) AS is_verified,
                (SELECT COUNT(*)::int FROM operator_tours ot
                  WHERE ot.operator_id = p.id
                    AND ot.is_active = true AND ot.deleted_at IS NULL) AS tours,
                jsonb_typeof(p.contacts) IS NOT NULL
                  AND p.contacts::text NOT IN ('[]', '{}', 'null') AS has_contacts
           FROM partners p
          ORDER BY p.name`,
      ),
    ]);

    const registry = registryRes.rows;
    const dormant = dormantRes.rows;

    const reachable = registry.filter((r) => r.has_phone || r.has_email || r.has_website);
    const active = registry.filter((r) => (r.registry_status ?? '').toLowerCase().includes('действ'));

    // Спящие: не на витрине ИЛИ без единого активного тура. Это и есть
    // ближайший разговор — человек однажды пришёл сам.
    const notOnShelf = dormant.filter((d) => !d.is_public || d.tours === 0);
    const byCategory = dormant.reduce<Record<string, number>>((acc, d) => {
      acc[d.category] = (acc[d.category] ?? 0) + 1;
      return acc;
    }, {});

    const registryNames = reachable.slice(0, NAMES_CAP).map((r) => r.name);
    const dormantNames = notOnShelf
      .filter((d) => d.category !== 'guide')
      .slice(0, NAMES_CAP)
      .map((d) => `${d.name} [${d.category}${d.is_public ? '' : ', скрыт'}, туров ${d.tours}${d.has_contacts ? ', контакты есть' : ', контактов нет'}]`);

    return NextResponse.json({
      ok: true,
      generated_at: new Date().toISOString(),
      registry_pool: {
        total_unmatched: registry.length,
        with_any_contact: reachable.length,
        with_phone: registry.filter((r) => r.has_phone).length,
        with_email: registry.filter((r) => r.has_email).length,
        with_website: registry.filter((r) => r.has_website).length,
        marked_active: active.length,
        regions: [...new Set(registry.map((r) => r.region).filter(Boolean))].slice(0, 20),
        names_sample: registryNames,
        names_dropped: Math.max(0, reachable.length - registryNames.length),
      },
      dormant_pool: {
        partners_total: dormant.length,
        by_category: byCategory,
        not_on_shelf: notOnShelf.length,
        public_with_tours: dormant.filter((d) => d.is_public && d.tours > 0).length,
        one_or_two_activities: dormant.filter((d) => d.tours === 1 || d.tours === 2).length,
        names_sample: dormantNames,
        names_dropped: Math.max(0, notOnShelf.filter((d) => d.category !== 'guide').length - dormantNames.length),
      },
      note: 'Контакты намеренно не отдаются — только флаги наличия (152-ФЗ, логи CI).',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'census failed';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
