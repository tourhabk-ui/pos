/**
 * GET /api/cron/kuzmich-review-census — что заметки Кузьмича о местах
 * утверждают сверх данных места. Bearer CRON_SECRET, ТОЛЬКО ЧТЕНИЕ.
 *
 * Повод — слово владельца 14.10 «кузьмич навыдумывал много». Заметку
 * `places.kuzmich_review` пишет агент kuzmich-place-enricher (раз в сутки,
 * двадцать мест), и до этого дня её не мерил никто: у описаний есть перепись
 * голоса (place-description-geo, блок voice), у заметок — ничего.
 *
 * Улики считает `lib/kuzmich/review-claims` — та же функция, которой агент
 * теперь проверяет свою же заметку перед записью. Улика — не приговор: число
 * без опоры бывает и верным. Разбирает человек, по списку.
 *
 * Четыре счёта, а не «хорошие/плохие»:
 *   with_evidence — у заметки есть улика (дневник, число или опасность без
 *                   опоры в описании и профиле);
 *   no_evidence   — улик нет. Это не «проверено», а «сверх данных не
 *                   сказано ничего, что мы умеем узнать»;
 *   empty         — заметка снята пустой строкой (её не перепишет агент);
 *   missing       — заметки нет (NULL): агент до места ещё не дошёл, или у
 *                   места нет описания от 100 знаков.
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { verifyCronSecret, diagnoseCronAuth } from '@/lib/auth/cron';
import { honestSafetyFields, asProfileSource } from '@/lib/safety/profile-source';
import { reviewClaims, reviewRewriteReason, type ReviewFlag, type RewriteReason } from '@/lib/kuzmich/review-claims';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_ITEMS = 150;

interface Row {
  id: string;
  slug: string | null;
  name: string;
  description: string | null;
  kuzmich_review: string | null;
  hazard_types: string[] | null;
  profile_source: string | null;
  altitude_m: number | null;
}

export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized', ...diagnoseCronAuth(req) }, { status: 401 });
  }

  let rows: Row[];
  try {
    ({ rows } = await pool.query<Row>(
      `SELECT p.id::text AS id, p.slug, p.name,
              COALESCE(p.description, p.description_withdrawn) AS description, p.kuzmich_review,
              lsp.hazard_types, lsp.profile_source, lsp.altitude_m
         FROM places p
         LEFT JOIN location_safety_profile lsp ON lsp.agent_route_id = p.ark_id
        WHERE p.is_visible = TRUE
          AND p.merged_into_id IS NULL
        ORDER BY p.name`,
    ));
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'нет кода';
    console.error('[kuzmich-review-census] места не прочитаны', `sqlstate=${code}`, err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Места не прочитаны', sqlstate: code }, { status: 503 });
  }

  const byFlag: Record<ReviewFlag, number> = { diary: 0, number_not_in_data: 0, hazard_not_in_data: 0 };
  const voice = { diary: 0, impression: 0, plain: 0 };
  let empty = 0;
  let missing = 0;
  let noEvidence = 0;
  // Сколько снимет перепроверка агента (kuzmich-place-enricher, 14.10):
  // улика или описание-дневник, по которому заметку писали.
  const rewriteQueue: Record<RewriteReason, number> = { evidence: 0, diary_description: 0 };
  const items: Array<{
    place: string; slug: string | null; place_id: string;
    flags: ReviewFlag[]; numbers: string[]; hazards: string[]; review: string;
  }> = [];

  for (const r of rows) {
    if (r.kuzmich_review === null) { missing++; continue; }
    const review = r.kuzmich_review.trim();
    if (review === '') { empty++; continue; }

    const honest = honestSafetyFields(
      { hazardTypes: r.hazard_types ?? [], capacityPerDay: null, optimalGroupSize: null, difficultyLevel: null, terrainType: null },
      asProfileSource(r.profile_source),
    );
    const facts = { description: r.description, hazardCodes: honest.hazardTypes, altitudeM: r.altitude_m };
    const v = reviewClaims(review, facts);
    voice[v.voice]++;
    const reason = reviewRewriteReason(review, facts);
    if (reason !== null) rewriteQueue[reason]++;
    if (v.flags.length === 0) { noEvidence++; continue; }
    for (const f of v.flags) byFlag[f]++;
    items.push({ place: r.name, slug: r.slug, place_id: r.id, flags: v.flags, numbers: v.numbers, hazards: v.hazards, review });
  }

  // Сначала опасности без опоры — они дороже всего человеку в поле, потом дневник, потом числа.
  const rank = (f: ReviewFlag[]) => (f.includes('hazard_not_in_data') ? 0 : f.includes('diary') ? 1 : 2);
  items.sort((a, b) => rank(a.flags) - rank(b.flags) || a.place.localeCompare(b.place, 'ru'));

  return NextResponse.json({
    places_visible: rows.length,
    reviews: {
      with_evidence: items.length,
      no_evidence: noEvidence,
      empty,
      missing,
    },
    by_flag: byFlag,
    voice,
    rewrite_queue: rewriteQueue,
    items: items.slice(0, MAX_ITEMS),
    items_total: items.length,
    note: 'Улики, не приговор: число без опоры бывает и верным. Сверяется с описанием места и произносимым профилем безопасности (шаблон 070 не в счёт). Только чтение.',
  });
}
