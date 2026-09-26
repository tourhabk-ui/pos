/**
 * GET /api/cron/place-description-geo — описание называет одно, координата
 * говорит другое. Bearer CRON_SECRET, ТОЛЬКО ЧТЕНИЕ.
 *
 * Повод, устройство улики и границы применимости — в шапке
 * `lib/places/description-geo.ts`. Здесь только запрос и сборка ответа.
 *
 * ── Что отвечает ──────────────────────────────────────────────────────────
 *
 * Не «сколько описаний плохие» — такого эта перепись знать не может. Она
 * отвечает: у каких мест описание НАЗЫВАЕТ известный нам объект и при этом
 * стоит от него дальше порога, и насколько дальше. Дальше судит человек: у
 * «Каньона Опасного» названный Карымский — выдумка, а у места, которое честно
 * пишет «виден Ичинский», расстояние законно, потому что вулкан ВИДЕН за сто
 * километров.
 *
 * Поэтому порог не приговор, а сортировка: список идёт по убыванию
 * расстояния, и верх разбирается глазами, партиями. Тот же приём, что у
 * подсказчика связей и у сверки с OSM — там из 24 сильных улик настоящими
 * ошибками оказались три.
 *
 * ── Три исхода, а не два ──────────────────────────────────────────────────
 *
 *   with_evidence   — описание называет объект, до которого далеко;
 *   no_evidence     — называет, и всё близко;
 *   nothing_to_check— описания нет вовсе, или оно не называет ни одного
 *                     ИЗВЕСТНОГО НАМ объекта. Это не «чисто»: выдумка про
 *                     реку, которой у нас нет, попадает именно сюда.
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { distanceKm } from '@/lib/routes/place-link';
import {
  nameStem,
  findMentions,
  stemCorpusHits,
  WORD_SHARE_MAX,
  type Landmark,
} from '@/lib/places/description-geo';
import { descriptionVoice } from '@/lib/places/description-voice';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Дальше этого упоминание считается уликой. Не приговор — порог сортировки. */
const FAR_KM_DEFAULT = 60;
const MAX_ITEMS = 200;

interface Row {
  id: string;
  name: string;
  lat: string | null;
  lng: string | null;
  description: string | null;
}

export async function GET(req: NextRequest) {
  if (!timingSafeCompare(getCronSecret(req), process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const farKm = Math.max(5, Math.min(2000, Number(url.searchParams.get('far_km')) || FAR_KM_DEFAULT));
  const limit = Math.max(1, Math.min(MAX_ITEMS, Number(url.searchParams.get('limit')) || 60));

  try {
    const { rows } = await pool.query<Row>(
      `SELECT id::text, name, lat::text, lng::text, description
         FROM places
        WHERE is_visible IS NOT FALSE
          AND merged_into_id IS NULL
          AND lat IS NOT NULL AND lng IS NOT NULL
        ORDER BY name`,
    );

    // Справочник строится из тех же живых мест: имена и координаты у нас
    // есть, ходить наружу незачем.
    const gazetteer: Landmark[] = [];
    for (const r of rows) {
      const stem = nameStem(r.name);
      if (!stem) continue;
      gazetteer.push({ id: r.id, name: r.name, stem, lat: Number(r.lat), lng: Number(r.lng) });
    }

    // ── Основы-слова снимаются, и снимаются ВСЛУХ ────────────────────────
    //
    // Прогон 60 назвал уликой 284 места из 379, и уликой была не география,
    // а язык: «лавовые», «каменная берёза», «кратер». Разбор — в шапке
    // lib/places/description-geo.ts.
    //
    // Отброшенное перечисляется в ответе со счётом: снятие, которого не
    // видно, — то же глушение отказа, только на входе (§4.0). По списку
    // видно, верен ли порог, и его можно опустить аргументом.
    const descriptions = rows.map(r => r.description ?? '');
    const corpusHits = stemCorpusHits(descriptions, gazetteer.map(g => g.stem));
    const wordShareMax = Math.max(
      0.01,
      Math.min(1, Number(url.searchParams.get('word_share')) || WORD_SHARE_MAX),
    );
    const wordHitsMax = Math.max(2, Math.floor(rows.length * wordShareMax));
    const ignoredStems = new Map<string, { stem: string; hits: number; example: string }>();
    const namesOnly: Landmark[] = [];
    for (const lm of gazetteer) {
      const hits = corpusHits.get(lm.stem) ?? 0;
      if (hits > wordHitsMax) {
        if (!ignoredStems.has(lm.stem)) {
          ignoredStems.set(lm.stem, { stem: lm.stem, hits, example: lm.name });
        }
        continue;
      }
      namesOnly.push(lm);
    }

    interface Evidence {
      place: string;
      place_id: string;
      mentions: Array<{ named: string; km: number; corpus_hits: number; quote: string }>;
      worst_km: number;
    }
    const evidence: Evidence[] = [];
    let noEvidence = 0;
    let nothingToCheck = 0;
    let statedDistanceOnly = 0;

    for (const r of rows) {
      const descr = (r.description ?? '').trim();
      if (descr.length < 40) { nothingToCheck++; continue; }

      const mentions = findMentions(descr, namesOnly, nameStem(r.name));
      if (mentions.length === 0) { nothingToCheck++; continue; }

      const implied = mentions.filter(m => m.kind === 'implied_location');
      if (implied.length === 0) { statedDistanceOnly++; continue; }

      const lat = Number(r.lat), lng = Number(r.lng);
      const far = implied
        .map(m => ({
          named: m.landmark.name,
          km: Math.round(distanceKm(lat, lng, m.landmark.lat, m.landmark.lng) * 10) / 10,
          // Сколько описаний зовут это имя. Единица — имя опознаёт объект;
          // десяток — повод посмотреть, не слово ли это, не дожидаясь порога.
          corpus_hits: corpusHits.get(m.landmark.stem) ?? 0,
          quote: m.quote,
        }))
        .filter(m => m.km >= farKm)
        .sort((a, b) => b.km - a.km);

      if (far.length === 0) { noEvidence++; continue; }
      evidence.push({
        place: r.name,
        place_id: r.id,
        mentions: far.slice(0, 4),
        worst_km: far[0].km,
      });
    }

    evidence.sort((a, b) => b.worst_km - a.worst_km);

    // ── Голос описания (26.09) ──────────────────────────────────────────────
    //
    // Вторая улика сочинённого текста, из той же выборки: путевая заметка от
    // первого лица вместо справки (Авачинский, «Вчера поднялся…»). Судит
    // lib/places/description-voice — приметы, а не приговор; переписывает
    // человек, партиями. Пустое описание — свой счёт, а не «справочный голос».
    const voiceItems: Array<{ place: string; place_id: string; voice: string; markers: string[]; quote: string }> = [];
    let voicePlain = 0;
    let voiceEmpty = 0;
    for (const r of rows) {
      const descr = (r.description ?? '').trim();
      if (descr === '') { voiceEmpty++; continue; }
      const v = descriptionVoice(descr);
      if (v.voice === 'plain') { voicePlain++; continue; }
      voiceItems.push({ place: r.name, place_id: r.id, voice: v.voice, markers: v.markers, quote: descr.slice(0, 160) });
    }
    voiceItems.sort((a, b) => (a.voice === b.voice ? a.place.localeCompare(b.place, 'ru') : a.voice === 'diary' ? -1 : 1));

    return NextResponse.json({
      ok: true,
      probe: 'place_description_geo_v2',
      far_km: farKm,
      live_places: rows.length,
      gazetteer_size: gazetteer.length,
      // Сколько имён справочника реально опознают объект, а сколько оказались
      // словами. Второе число — не брак, а измеренное свойство наших имён.
      gazetteer_names: namesOnly.length,
      word_hits_max: wordHitsMax,
      stems_ignored_as_words: [...ignoredStems.values()].sort((a, b) => b.hits - a.hits),
      with_evidence: evidence.length,
      no_evidence: noEvidence,
      // Описания нет либо оно не называет ни одного ИЗВЕСТНОГО НАМ объекта.
      // Это не «чисто»: выдумка про объект вне нашей базы попадает сюда.
      nothing_to_check: nothingToCheck,
      // Упоминания только с расстоянием («в 40 км от Петропавловска») —
      // законная форма, в улики не идёт.
      stated_distance_only: statedDistanceOnly,
      items: evidence.slice(0, limit),
      voice: {
        diary: voiceItems.filter(v => v.voice === 'diary').length,
        impression: voiceItems.filter(v => v.voice === 'impression').length,
        plain: voicePlain,
        empty: voiceEmpty,
        items: voiceItems.slice(0, MAX_ITEMS),
        note: 'diary — рассказ от первого лица, MCP и Кузьмич его как справку не отдают; impression — ощущения, отдаются подписанными. Приметы, не приговор',
      },
      // Ноль улик при пустом справочнике — отказ, а не чистота (§4.0).
      // Пустым он может стать и после снятия слов: если порог снёс ВСЕ имена,
      // сравнивать не с чем, и молчание такой переписи ничего не значит.
      meaningful: namesOnly.length > 0 && rows.length > 0,
      note: 'улика, не приговор: вулкан бывает ВИДЕН за сто километров, и такое упоминание законно. Разбирать глазами, сверху вниз',
    });
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'нет SQLSTATE';
    console.error(`[place-description-geo] перепись не выполнена, SQLSTATE ${code}:`, err);
    return NextResponse.json(
      { ok: false, probe: 'place_description_geo_v2', error: 'перепись не выполнена', sqlstate: code },
      { status: 503 },
    );
  }
}
