/**
 * lib/services/safety/emsd-vmon-sync.ts — записать суточную сводку КФ ФИЦ ЕГС
 * РАН о вулканах (www.emsd.ru/vmon) в volcano_bulletin_kfegs.
 *
 * Решение владельца 24.09: «да, показывай обе шкалы на радаре». Радар знал о
 * вулканах только от KVERT — авиационный код ICAO. У КФ ЕГС своя шкала
 * (сейсмичность, газ, термоаномалии, пепел — легенда в самой сводке), и
 * 22.09 по ней Мутновский и Горелый стояли жёлтыми, а на радаре их не было.
 *
 * ── Что пишется и чего не трогает ─────────────────────────────────────────
 *
 * Пишется ТОЛЬКО своя таблица (миграция 1010). volcano_status (KVERT) не
 * трогается: две шкалы лежат рядом, каждая со своим смыслом, и ни одна не
 * перезаписывает другую. События ленты и пуши эта сводка НЕ производит —
 * жёлтый у КФ ЕГС бывает неделями, и тревога из него стала бы шумом. Это
 * отдельное решение владельца.
 *
 * ── Отказы ────────────────────────────────────────────────────────────────
 *
 * Не дошли, не раскодировали, не разобрали дату — ничего не пишем и
 * называем причину. Запись с выдуманной датой («сегодня») сделала бы
 * позавчерашнюю сводку свежей на радаре.
 */

import { pool } from '@/lib/db-pool';
import { fetchEmsdPage } from '@/lib/services/safety/emsd-fetch';
import { parseVmon, EMSD_VMON_URL } from '@/lib/services/safety/emsd-vmon';
import { matchVolcanoPlace } from '@/lib/services/safety/volcano-match';
import { loadVolcanoIndex } from '@/lib/agents/kvert-sync';

export interface VmonSyncResult {
  /** Дошли и записали сводку. false — смотри reason. */
  ok: boolean;
  reason: string | null;
  observedDate: string | null;
  volcanoes: number;
  written: number;
  /** Сопоставлено с местом каталога. Без места радар вулкан не нарисует. */
  matched: number;
  /** Имена без места — пробел каталога или неоднозначность, названы поимённо. */
  unmatched: Array<{ name: string; why: 'no_place' | 'ambiguous' }>;
  /** Код не разобран (например «Белый»). */
  unknownColor: string[];
  problems: string[];
}

export async function syncEmsdVmon(): Promise<VmonSyncResult> {
  const empty = (reason: string, problems: string[] = []): VmonSyncResult => ({
    ok: false, reason, observedDate: null, volcanoes: 0, written: 0, matched: 0,
    unmatched: [], unknownColor: [], problems,
  });

  const page = await fetchEmsdPage(EMSD_VMON_URL, 30_000);
  if (!page.html) return empty(`сводка не получена: ${page.error ?? 'причина не названа'}`);

  const bulletin = parseVmon(page.html);
  if (bulletin.rows.length === 0) {
    return empty('сводка получена, но вулканов разобрано ноль', bulletin.problems);
  }
  if (!bulletin.observedDate) {
    // Без даты сводки писать нельзя: подставленное «сегодня» сделало бы
    // старую сводку свежей на радаре.
    return empty('дата сводки не разобрана — за какие сутки наблюдения, неизвестно', bulletin.problems);
  }

  const index = await loadVolcanoIndex();
  if (index.size === 0) {
    // Пустой каталог вулканов — не «ничего не совпало», а «сопоставлять не с
    // чем». Пишем всё равно (сводка ценна и без места), но говорим об этом.
    bulletin.problems.push('каталог вулканов пуст — ни один вулкан не сопоставлен с местом');
  }

  const result: VmonSyncResult = {
    ok: true, reason: null, observedDate: bulletin.observedDate,
    volcanoes: bulletin.rows.length, written: 0, matched: 0,
    unmatched: [], unknownColor: [], problems: bulletin.problems,
  };

  for (const r of bulletin.rows) {
    const m = matchVolcanoPlace(index, r.nameRu);
    const arkId = m.kind === 'matched' ? m.arkId : null;
    if (m.kind === 'matched') result.matched++;
    else result.unmatched.push({ name: r.nameRu, why: m.kind });
    if (r.color === null) result.unknownColor.push(r.nameRu);

    await pool.query(
      `INSERT INTO volcano_bulletin_kfegs
         (observed_date, volcano_name, volcano_name_en, place_ark_id,
          color, color_raw, color_unknown_reason, seismicity, fetched_at)
       VALUES ($1::date, $2, $3, $4::uuid, $5, $6, $7, $8, NOW())
       ON CONFLICT (observed_date, volcano_name) DO UPDATE SET
         volcano_name_en      = EXCLUDED.volcano_name_en,
         place_ark_id         = COALESCE(EXCLUDED.place_ark_id, volcano_bulletin_kfegs.place_ark_id),
         color                = EXCLUDED.color,
         color_raw            = EXCLUDED.color_raw,
         color_unknown_reason = EXCLUDED.color_unknown_reason,
         seismicity           = EXCLUDED.seismicity,
         fetched_at           = NOW()`,
      [
        bulletin.observedDate, r.nameRu, r.nameEn, arkId,
        r.color, r.colorRaw, r.colorUnknownReason, r.seismicity.slice(0, 1000),
      ],
    );
    result.written++;
  }
  return result;
}
