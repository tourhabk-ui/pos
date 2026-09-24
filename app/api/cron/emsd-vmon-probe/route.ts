/**
 * GET /api/cron/emsd-vmon-probe — достижима ли с прода суточная сводка КФ ФИЦ
 * ЕГС РАН о вулканах, и разбирается ли живая страница так же, как снимок.
 *
 * ТОЛЬКО ЧТЕНИЕ. Ни UPDATE, ни INSERT — ни при каком аргументе. Это перепись,
 * а не производитель: она должна сказать, что мы УВИДИМ, прежде чем кто-нибудь
 * начнёт на основании этого писать статусы или поднимать тревоги.
 *
 * ── Зачем (23.09) ─────────────────────────────────────────────────────────
 *
 * Вопрос владельца 21.09 «ни предупреждений по вулканам 3 дня» имел две
 * половины. Сейсмическая была транспортной поломкой и починена. Вулканическая
 * — другая: предупреждать НЕЧЕМ. Единственный производитель события
 * `volcanic_eruption` — парсер канала КБГС, молчащего с 24 марта; KVERT идёт
 * по расписанию, но пишет только `volcano_status` (карточка места), тревогой
 * не становясь ни при каком цвете.
 *
 * Сводка КФ ЕГС — второй независимый наблюдатель. В снимке владельца за 20.09
 * она показывала Мутновский и Горелый жёлтыми (372 и 571 событие за сутки,
 * непрерывное дрожание), Шивелуч оранжевым. Мутновский и Горелый — пешие
 * маршруты.
 *
 * ── Что именно меряется, и почему это нельзя было написать без прогона ────
 *
 * Три неизвестных, и ни одно не проверяется из контейнера разработки
 * (`www.emsd.ru` не в списке разрешённых хостов, FTP через прокси не ходит):
 *
 *  1. **Достижимость.** emsd.ru — российский хост, и с Timeweb должен
 *     открываться без реле. «Должен» — не замер.
 *  2. **Кодировка.** Страница в windows-1251. `res.text()` разобрал бы её как
 *     UTF-8 и выдал кракозябры, которые парсер принял бы за «вулканов ноль».
 *     `TextDecoder('windows-1251')` требует полного ICU, а рантайм —
 *     `node:22-alpine`; есть ли там полное ICU, я подтвердить не могу.
 *     Поэтому отказ декодера ловится и НАЗЫВАЕТСЯ, а не превращается в
 *     пустую сводку.
 *  3. **Расхождение с KVERT.** У нас уже есть источник авиационных кодов —
 *     другое учреждение (ИВиС ДВО РАН). Два наблюдателя одного вулкана могут
 *     разойтись. Сколько раз они расходятся СЕГОДНЯ — вопрос к данным, и от
 *     ответа зависит, кто пишет в общее поле. Решение принимает владелец;
 *     проба даёт ему число, а не правило.
 *
 * Авторизация: Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret, diagnoseCronAuth } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';
import { fetchEmsdPage } from '@/lib/services/safety/emsd-fetch';
import {
  parseVmon,
  elevatedRows,
  unknownColorRows,
  EMSD_VMON_URL,
} from '@/lib/services/safety/emsd-vmon';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Маркер версии: по нему видно, та ли сборка отвечает (см. wait-for-deploy). */
const PROBE = 'emsd_vmon_probe_v1';

/** Что у нас уже записано по вулканам от KVERT. Только SELECT. */
async function ourVolcanoStatus(): Promise<{
  rows: Array<{ name: string; color: string | null; observed_at: string | null }> | null;
  error: string | null;
}> {
  try {
    const { rows } = await pool.query<{ name: string; color: string | null; observed_at: string | null }>(
      `SELECT volcano_name AS name,
              aviation_color_code AS color,
              observed_at::text AS observed_at
         FROM volcano_status
        ORDER BY volcano_name`,
    );
    return { rows, error: null };
  } catch (e) {
    // Отказ БД не глушится: «сравнить не смогли» и «расхождений нет» — разные
    // ответы, и путать их нельзя (§4.0).
    const why = e instanceof Error ? e.message : String(e);
    console.error('[emsd-vmon-probe] volcano_status недоступен:', why);
    return { rows: null, error: why.slice(0, 300) };
  }
}

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я]/g, '');
}

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized', ...diagnoseCronAuth(request) }, { status: 401 });
  }

  const [page, ours] = await Promise.all([fetchEmsdPage(EMSD_VMON_URL, 30_000), ourVolcanoStatus()]);

  if (!page.html) {
    // Не дошли — это НЕ «вулканы спокойны». Отвечаем отказом явно, чтобы
    // прогон покраснел, а не напечатал пустой список (урок сверки с OSM 20.09).
    return NextResponse.json({
      success: false,
      probe: PROBE,
      url: EMSD_VMON_URL,
      reachable: false,
      http_status: page.status,
      bytes: page.bytes,
      error: page.error ?? 'страница не получена, причина не названа',
    }, { status: 502 });
  }

  const bulletin = parseVmon(page.html);
  const elevated = elevatedRows(bulletin);
  const unknown = unknownColorRows(bulletin);

  // Расхождение с KVERT — ФАКТ, а не вердикт: чей цвет вернее, проба не
  // решает и решать не должна (тот же принцип, что у clusterConflicts в
  // подсказчике связей — улика без приговора).
  const byName = new Map((ours.rows ?? []).map((r) => [normalizeName(r.name), r]));
  const comparison = ours.rows === null ? null : bulletin.rows.map((r) => {
    const mine = byName.get(normalizeName(r.nameRu)) ?? (r.nameEn ? byName.get(normalizeName(r.nameEn)) : undefined);
    return {
      name: r.nameRu,
      emsd: r.color ?? r.colorRaw,
      emsd_parsed: r.color !== null,
      kvert: mine?.color ?? null,
      kvert_observed_at: mine?.observed_at ?? null,
      state: !mine ? 'нет у KVERT'
        : r.color === null ? 'код emsd не разобран — сравнивать нечем'
        : mine.color === r.color ? 'совпало'
        : 'РАСХОЖДЕНИЕ',
    };
  });

  return NextResponse.json({
    success: true,
    probe: PROBE,
    url: EMSD_VMON_URL,
    reachable: true,
    http_status: page.status,
    bytes: page.bytes,
    decoded_by: page.decodedBy,
    observed_date: bulletin.observedDate,
    observed_date_raw: bulletin.observedDateRaw,
    volcanoes_total: bulletin.rows.length,
    // Жалобы парсера — наверх, а не в хвост: по ним видно смену вёрстки.
    parse_problems: bulletin.problems,
    elevated_total: elevated.length,
    elevated: elevated.map((r) => ({
      name: r.nameRu, color: r.color, seismicity: r.seismicity.slice(0, 300),
    })),
    unknown_color_total: unknown.length,
    unknown_color: unknown.map((r) => ({
      name: r.nameRu, raw: r.colorRaw, why: r.colorUnknownReason, seismicity: r.seismicity.slice(0, 200),
    })),
    kvert_compare: comparison,
    kvert_compare_error: ours.error,
    kvert_rows_total: ours.rows?.length ?? null,
    disagreements_total: comparison?.filter((c) => c.state === 'РАСХОЖДЕНИЕ').length ?? null,
  });
}
