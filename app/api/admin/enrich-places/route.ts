/**
 * POST /api/admin/enrich-places
 *
 * Пишет описания мест из ДАННЫХ. Партия за вызов, {done, total, results[]};
 * звать повторно, пока done не сравняется с total.
 *
 * ── Почему промпт переписан (19.09) ────────────────────────────────────────
 *
 * Владелец показал пост канала про Ключевскую и спросил: «что за сочинение,
 * вулкан потухший». Пост перепечатал `places.description`, а текст сочинил
 * этот роут. В промпте стояло: «Напиши описание так, БУДТО ТЫ ТОЛЬКО ЧТО
 * ВЕРНУЛСЯ ОТТУДА» — при том что модели дают имя, тип, район, координаты и
 * высоту. Ни запаха, ни звука, ни частоты извержений в этих данных нет.
 *
 * Получилось ровно то, что обещает §4.0: «Просить деталь, которую знают не
 * все, не дав источника, — заказ на выдумку». Модель написала про «запах серы
 * и остывающего камня» и «лаву раз в несколько лет» — и превратила один из
 * самых активных вулканов планеты в затухающий. Испорчен был не слог, а
 * центральный факт, на платформе, существующей ради безопасности туриста.
 *
 * Теперь промпт просит справку ИЗ ДАННЫХ и прямо разрешает короткий текст:
 * две точные фразы лучше пяти придуманных.
 *
 * ── Почему появился журнал происхождения ───────────────────────────────────
 *
 * Роут писал `places.description` и не оставлял следа. Editor'у журнал завели
 * миграцией 911 именно потому, что «на вопрос „сколько описаний сочинено"
 * ответить было нечем»; здесь тот же вопрос оставался без ответа до 19.09 —
 * и когда владелец нашёл одно выдуманное описание, сказать, сколько их ещё,
 * было невозможно.
 *
 * ── Почему изменён отбор ───────────────────────────────────────────────────
 *
 * Очередь брала всё короче 250 знаков. С честным промптом это ЗАМКНУТЫЙ КРУГ:
 * место, о котором в данных сказано мало, получает короткий верный текст,
 * снова попадает в очередь как «недописанное» и переписывается — пока модель
 * не добавит недостающие знаки единственным доступным ей способом, то есть
 * выдумкой. Поэтому место, о котором мы уже написали из данных, второй раз не
 * берётся: короткий текст здесь ответ, а не недоработка. Пересобрать заново
 * можно аргументом `force`.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { callAIFast } from '@/lib/ai/providers';
import type { ChatMessage } from '@/lib/ai/prompts';
import { z } from 'zod';
import { stripTags } from '@/lib/html/text';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Кто написал. Стоит в журнале происхождения и в отборе очереди — одно имя на
 * оба места: разойдутся они молча, и роут начнёт переписывать то, что сам же
 * и написал.
 */
const WRITER = 'enrich-places-ai';
// Подставляется в SQL напрямую: это замороженная константа кода из латиницы и
// дефиса, снаружи в неё попасть нечем (та же форма, что у SHOWN_MODELS).

const Schema = z.object({
  batch:  z.number().int().min(1).max(50).default(20),
  force:  z.boolean().default(false),
});

const TYPE_RU: Record<string, string> = {
  volcano: 'вулкан', hot_spring: 'термальный источник', lake: 'озеро',
  waterfall: 'водопад', mountain: 'горный массив', bay: 'бухта',
  cape: 'мыс', river: 'река / каньон', cave: 'пещера', beach: 'пляж',
  viewpoint: 'смотровая площадка', island: 'остров', forest: 'природный парк',
  geyser: 'гейзерное поле', glacier: 'ледник', rock: 'скальный объект',
  historical: 'историческое место', other: 'природный объект',
};

const ECO_NOTE: Record<string, string> = {
  federal_reserve: 'Находится в Кроноцком государственном биосферном заповеднике.',
  natural_park:    'Территория природного парка Камчатки.',
  zakaznik:        'Государственный природный заказник.',
  UNESCO:          'Объект Всемирного природного наследия ЮНЕСКО «Вулканы Камчатки».',
};

/**
 * Чем кормили модель — ровно то, что уходит в промпт.
 *
 * Список один на оба места намеренно. Свой перечень у журнала означал бы, что
 * мы записываем не то, что дали: запись «дано 5 фактов» при трёх в промпте
 * хуже отсутствия записи, потому что выглядит как проверка.
 */
export function factsGiven(p: {
  description: string | null; location_type: string | null;
  zone: string | null; district: string | null;
  eco_zone: string | null; altitude_m: number | null;
}): string[] {
  const facts: string[] = ['тип объекта', 'координаты'];
  if (p.zone || p.district) facts.push('район');
  if (p.altitude_m && p.altitude_m > 100) facts.push('высота');
  if (p.eco_zone && ECO_NOTE[p.eco_zone]) facts.push('охранный статус');
  if (stripTags(p.description ?? '').trim()) facts.push('прежнее описание');
  return facts;
}

function buildPrompt(p: {
  name: string; description: string | null; location_type: string | null;
  lat: number; lng: number; zone: string | null; district: string | null;
  eco_zone: string | null; altitude_m: number | null;
}): ChatMessage[] {
  const type    = TYPE_RU[p.location_type ?? 'other'] ?? 'природный объект';
  const ecoNote = p.eco_zone && ECO_NOTE[p.eco_zone] ? ECO_NOTE[p.eco_zone] : '';
  const altNote = p.altitude_m && p.altitude_m > 100 ? `Высота: ${p.altitude_m} м.` : '';
  const rawDesc = stripTags(p.description ?? '').slice(0, 600);

  return [
    {
      role: 'system',
      content:
        'Ты пишешь справку о месте для платформы о безопасности туристов на Камчатке. ' +
        'Пиши ТОЛЬКО из данных ниже. Ничего не добавляй от себя. ' +
        'ЗАПРЕЩЕНО писать то, чего в данных нет: ощущения и впечатления (запахи, звуки, «чувствуешь», ' +
        '«слышен», «дышит»), обращение к читателю на «ты», а также любые утверждения о частоте событий, ' +
        'высоте, температуре, времени в пути, погоде и опасностях, если они не даны. ' +
        'Запрещены рекламные обороты: «обязательно посетите», «вас ждёт», «незабываемые», «уникальный», «красивый». ' +
        'Запрещено упоминать сайты, туроператоров, ссылки. ' +
        'Нечего сказать сверх данных — пиши КОРОЧЕ. Две точные фразы лучше пяти придуманных. ' +
        'Объём: 2–5 предложений. Только русский текст, без кавычек и заголовков.',
    },
    {
      role: 'user',
      content:
        `Объект: ${p.name}\nТип: ${type}\n` +
        `Район: ${[p.zone, p.district].filter(Boolean).join(', ') || 'Камчатка'}\n` +
        `Координаты: ${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}\n` +
        (altNote ? altNote + '\n' : '') +
        (ecoNote ? ecoNote + '\n' : '') +
        `Имеющееся описание: ${rawDesc || '(нет)'}\n\n` +
        'Напиши справку по этим данным.',
    },
  ];
}

export async function POST(req: NextRequest) {
  const authErr = await requireAdmin(req);
  if (authErr) return authErr;

  const body = await req.json().catch(() => ({}));
  // safeParse, а не parse.
  //
  // `Schema.parse` БРОСАЕТ на негодном вводе, а обработчик исключения не
  // ловил — значит `{"batch": 100}` давал пятисотку вместо внятного отказа.
  // Пятисотка означает «сломались мы»; здесь же ошибся вызывающий, и сказать
  // ему об этом надо словами. Находка эволюции «Прод 500:
  // /api/admin/enrich-places» верна по симптому; причина — не отсутствующий
  // return (возвраты на месте), а незакрытая валидация.
  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Неверные параметры: batch — целое от 1 до 50, force — да/нет' },
      { status: 400 },
    );
  }
  const { batch, force } = parsed.data;

  // `written` — места, о которых этот роут уже написал из данных. Второй раз
  // они не берутся: короткий честный текст здесь ответ, а не недоработка (см.
  // шапку про замкнутый круг). `force` обходит и это, и порог длины.
  const written = `NOT EXISTS (
         SELECT 1 FROM description_provenance dp
          WHERE dp.entity_id = p.ark_id AND dp.written_by = '${WRITER}'
       )`;

  const condition = force
    ? 'is_visible = true'
    : `is_visible = true AND ${written} AND (
         description IS NULL
         OR length(description) < 250
         OR description ILIKE '%idilesom%'
         OR description ILIKE '%topkam%'
         OR description ILIKE '%openstreetmap%'
         OR description ILIKE '%wikipedia.org%'
         OR description ILIKE '%источник:%'
       )`;

  // Алиас `p` обязателен и здесь: условие общее с выборкой ниже, а она берёт
  // `places p`. Два разных написания одного отбора разошлись бы молча — счёт
  // показывал бы одно, партия трогала другое.
  const { rows: pending } = await pool.query(
    `SELECT COUNT(*) AS cnt FROM places p WHERE ${condition}`
  );
  const total = Number(pending[0].cnt);

  if (total === 0) {
    return NextResponse.json({ done: 0, total: 0, results: [], message: 'Все описания уже обогащены' });
  }

  const { rows } = await pool.query(`
    SELECT p.id, p.ark_id::text AS ark_id, p.name, p.description, p.location_type,
           p.lat::float, p.lng::float, p.zone, p.district, p.eco_zone,
           sp.altitude_m::int AS altitude_m
    FROM places p
    LEFT JOIN location_safety_profile sp ON sp.agent_route_id = p.ark_id
    WHERE ${condition}
    ORDER BY p.location_type, p.name
    LIMIT $1
  `, [batch]);

  const results: { name: string; status: 'ok' | 'error'; chars?: number; facts?: number; error?: string }[] = [];

  for (const p of rows) {
    try {
      const messages = buildPrompt(p as Parameters<typeof buildPrompt>[0]);
      const text = (await callAIFast(messages)).trim().replace(/^["«»]|["«»]$/g, '').trim();

      if (text.length >= 80) {
        const prevChars = typeof p.description === 'string' ? p.description.length : null;
        await pool.query(`UPDATE places SET description = $1 WHERE id = $2`, [text, p.id]);

        // Журнал рядом с текстом, а не «когда-нибудь потом»: без него машинный
        // текст неотличим от текста из источника, и на вопрос «сколько описаний
        // сочинено» отвечать нечем (тот же довод, что у Editor, миграция 911).
        // Отказ журнала не отменяет описание, но и не молчит.
        const facts = factsGiven(p as Parameters<typeof buildPrompt>[0]);
        if (typeof p.ark_id === 'string' && p.ark_id) {
          try {
            await pool.query(
              `INSERT INTO description_provenance
                 (entity_id, entity_kind, entity_title, written_by, facts_given,
                  facts_count, chars, previous_chars)
               VALUES ($1::uuid, 'place', $2, $3, $4::jsonb, $5, $6, $7)`,
              [p.ark_id, p.name, WRITER, JSON.stringify(facts), facts.length,
               text.length, prevChars],
            );
          } catch (err) {
            console.error('[enrich-places] происхождение не записано:', p.name, err);
          }
        } else {
          // Без ark_id связать запись журнала не с чем. Это не «записали», и
          // молчать об этом нельзя: такое место вернётся в очередь снова.
          console.error('[enrich-places] у места нет ark_id, происхождение не записано:', p.name);
        }

        results.push({ name: p.name as string, status: 'ok', chars: text.length, facts: facts.length });
      } else {
        results.push({ name: p.name as string, status: 'error', error: `слишком короткий ответ (${text.length})` });
      }
    } catch (err) {
      // §4.0: отказ не глушится. Раньше он уходил только в ответ вызывающему —
      // то есть исчезал, если ответ никто не читал.
      console.error('[enrich-places] описание не записано:', p.name, err);
      results.push({ name: p.name as string, status: 'error', error: (err as Error).message.slice(0, 80) });
    }
  }

  const done = results.filter(r => r.status === 'ok').length;
  return NextResponse.json({ done, total, remaining: total - done, results });
}
