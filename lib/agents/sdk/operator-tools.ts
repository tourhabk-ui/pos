/**
 * lib/agents/sdk/operator-tools.ts
 *
 * SDK-инструменты для операторов через AI-чат.
 * Позволяют управлять турами и бронированиями из диалога:
 * - Просмотр своих туров и статистики
 * - Просмотр бронирований (сегодня, по туру)
 * - Просмотр выручки
 * - Обновление цен  
 * - Управление статусом туров (publish/unpublish)
 */

import type { SDKTool } from './sdk-runner';
import { pool } from '@/lib/db-pool';
import { transaction } from '@/lib/database';
import { saveTourChange } from '@/lib/tours/tour-change';
import { executeGovernedAction, hashInput } from '@/lib/agents/kernel';
import { checkPriceMove } from '@/lib/agents/kernel/guardrails';
import { redactPII } from '@/lib/security/pii-redact';

/**
 * Ключ идемпотентности мутации на ИНВОКАЦИЮ: seed приходит от запроса
 * пользователя (сессия + номер сообщения, см. getOperatorTools), а не
 * генерируется случайно внутри retry. Один пользовательский запрос — один
 * эффект: повтор модели в том же agentic-цикле с теми же аргументами даёт
 * тот же ключ и отбивается ядром; новый запрос — новый seed, действие
 * законно исполняется снова. Без seed ключа нет — и это честнее ключа,
 * выдуманного на месте.
 */
/**
 * Слова самого оператора в этом запросе (проверка безопасности ИИ-части 26.11,
 * слово владельца «чини Карт бланш»). Инструменты помощника читают данные, в
 * которые пишут туристы (пожелания к брони, сообщения), и текст туриста мог
 * велеть модели снять туры с публикации или поменять цену — а флаг «оператор
 * подтвердил» (`confirm_large_move`) ставила сама модель. Теперь подтверждение
 * читает код: из сообщения оператора, которое роут передаёт доверенным полем
 * `_operatorMessage`, а не из аргументов модели.
 */
function operatorMessageOf(args: Record<string, unknown>): string {
  return typeof args._operatorMessage === 'string' ? args._operatorMessage : '';
}

/** Написал ли оператор в своём сообщении именно эту цену (пробелы между разрядами — любые). */
export function priceStatedByOperator(message: string, price: number): boolean {
  if (!Number.isFinite(price) || price <= 0) return false;
  const digits = message.replace(/(\d)[\s\u00a0\u202f.]+(?=\d{3}(?!\d))/g, '$1');
  const want = String(Math.round(price));
  return new RegExp(`(^|[^\\d])${want}([^\\d]|$)`).test(digits);
}

/**
 * Глаголы целым словом и без отрицания перед ними: «не подтверждаю» — не
 * подтверждение, «снимок» — не «сними», а «сними с публикации» — не просьба
 * опубликовать (слово «публикации» в ней есть).
 */
const NOT_NEGATED = '(?<!не\\s)(?<!не\\sнадо\\s)(?<!нельзя\\s)(?<![\\p{L}])';
const WORD_END = '(?![\\p{L}])';
const CONFIRM_RE = new RegExp(`${NOT_NEGATED}(подтверждаю|подтверждаем)${WORD_END}`, 'iu');
const PUBLISH_RE = new RegExp(
  `${NOT_NEGATED}(опубликуй|опубликуйте|опубликовать|опубликуем|верни(?:те)?\\s+на\\s+(?:сайт|витрину)|покажи(?:те)?\\s+на\\s+сайте|publish)${WORD_END}`,
  'iu',
);
const UNPUBLISH_RE = new RegExp(
  `${NOT_NEGATED}(сними|снимите|снять|снимем|скрой|скройте|скрыть|убери|уберите|убрать|отключи|отключите|отключить|unpublish|hide)${WORD_END}`,
  'iu',
);

/** Слово подтверждения хода цены больше 50% — в сообщении оператора. */
export function operatorConfirmed(message: string): boolean {
  return CONFIRM_RE.test(message);
}

/** Просит ли оператор в своём сообщении снять тур (false) или опубликовать его (true). */
export function operatorAsksPublish(message: string, published: boolean): boolean {
  return (published ? PUBLISH_RE : UNPUBLISH_RE).test(message);
}

function invocationKey(args: Record<string, unknown>, tool: string): string | undefined {
  const seed = typeof args._invocationSeed === 'string' ? args._invocationSeed : null;
  if (!seed) return undefined;
  const publicArgs = Object.fromEntries(Object.entries(args).filter(([k]) => !k.startsWith('_')));
  return `op:${tool}:${hashInput({ seed, publicArgs })}`;
}

/**
 * «Строка та же, что я видел» — сверка версии по `updated_at` ($3).
 *
 * Сверяется с точностью до миллисекунды: столько несёт JS-`Date`, которым
 * версия прочитана и возвращена в запрос. В базе у `NOW()` — микросекунды, и
 * прямое `updated_at = $3` не совпадало почти никогда: оба инструмента ниже
 * отвечали «тур изменён параллельно» на любой вызов. Нашёл это тест двери на
 * настоящем PostgreSQL (tests/integration/tour-moderation.pg.test.ts, 23.11) —
 * на подменённой базе сравнение «совпадало» всегда.
 */
const SAME_VERSION_SQL = `date_trunc('milliseconds', updated_at) = date_trunc('milliseconds', $3::timestamptz)`;

// ── My Tours ─────────────────────────────────────────────────

const myTours: SDKTool = {
  name: 'my_tours',
  description: 'Показать список туров оператора с ключевой статистикой: название, цена, бронирования, ближайшая дата, свободные места.',
  parameters: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        description: 'Фильтр: active (по умолчанию), inactive, all',
      },
    },
  },
  execute: async (args) => {
    const operatorId = args._operatorId as string;
    if (!operatorId) return JSON.stringify({ error: 'Не удалось определить оператора' });

    const statusFilter = args.status === 'inactive'
      ? 'AND ot.is_active = false'
      : args.status === 'all'
        ? ''
        : 'AND ot.is_active = true';

    const res = await pool.query(
      `SELECT ot.id, ot.title, ot.base_price, ot.is_published,
              ot.activity_type, ot.duration_hours,
              COUNT(ob.id)::int AS bookings_count,
              MIN(CASE WHEN ta.date >= CURRENT_DATE THEN ta.date END)::text AS next_date,
              SUM(CASE WHEN ta.date >= CURRENT_DATE THEN ta.available_slots ELSE 0 END)::int AS available_slots
       FROM operator_tours ot
       LEFT JOIN operator_bookings ob ON ob.operator_tour_id = ot.id AND ob.booking_status != 'cancelled'
       -- ta.operator_tour_id, а НЕ ta.tour_id: колонку tour_id объявляла
       -- призрачная копия таблицы в lib/database/schema.sql, которую деплой
       -- не применяет вовсе. Настоящая таблица создана миграцией 040 и
       -- ссылается на operator_tours (issue #1331, 22.08.2026).
       LEFT JOIN tour_availability ta ON ta.operator_tour_id = ot.id
       WHERE ot.operator_id = $1 AND ot.deleted_at IS NULL ${statusFilter}
       GROUP BY ot.id
       ORDER BY ot.is_active DESC, ot.title`,
      [operatorId],
    );
    return JSON.stringify({ tours: res.rows, count: res.rowCount });
  },
};

// ── Tour Bookings ────────────────────────────────────────────

const tourBookings: SDKTool = {
  name: 'tour_bookings',
  description: 'Показать бронирования для конкретного тура или все бронирования оператора. Можно фильтровать по статусу и периоду.',
  parameters: {
    type: 'object',
    properties: {
      tour_id: {
        type: 'string',
        description: 'ID тура (число). Если не указан, покажет все бронирования оператора.',
      },
      status: {
        type: 'string',
        description: 'Фильтр статуса: confirmed, completed, cancelled, new, all (по умолчанию all)',
      },
      period: {
        type: 'string',
        description: 'Период: today, week, month, all (по умолчанию month)',
      },
    },
  },
  execute: async (args) => {
    const operatorId = args._operatorId as string;
    if (!operatorId) return JSON.stringify({ error: 'Не удалось определить оператора' });

    const conditions: string[] = ['ot.operator_id = $1', 'ot.deleted_at IS NULL'];
    const params: unknown[] = [operatorId];
    let paramIdx = 2;

    if (args.tour_id) {
      conditions.push(`ob.operator_tour_id = $${paramIdx}`);
      params.push(parseInt(args.tour_id as string, 10));
      paramIdx++;
    }

    if (args.status && args.status !== 'all') {
      conditions.push(`ob.booking_status = $${paramIdx}`);
      params.push(args.status);
      paramIdx++;
    }

    const period = (args.period as string) || 'month';
    if (period === 'today') conditions.push(`ob.created_at >= CURRENT_DATE`);
    else if (period === 'week') conditions.push(`ob.created_at >= CURRENT_DATE - INTERVAL '7 days'`);
    else if (period === 'month') conditions.push(`ob.created_at >= CURRENT_DATE - INTERVAL '30 days'`);

    const res = await pool.query<BookingRow>(
      `SELECT ob.id, ot.title AS tour_title, ob.tourist_name, ob.tourist_email,
              ob.booking_date::text, ob.participants, ob.final_price,
              ob.booking_status, ob.payment_status, ob.special_requests
       FROM operator_bookings ob
       JOIN operator_tours ot ON ot.id = ob.operator_tour_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY ob.booking_date DESC
       LIMIT 20`,
      params,
    );
    // `res.rows` целиком отсюда НЕ уходит: строка брони несёт имя, почту и
    // свободный текст пожеланий (см. bookingForModel).
    return JSON.stringify({ bookings: res.rows.map(bookingForModel), count: res.rowCount });
  },
};

interface BookingRow {
  id: number;
  tour_title: string;
  tourist_name: string | null;
  tourist_email: string | null;
  booking_date: string | null;
  participants: number | null;
  final_price: string | number | null;
  booking_status: string | null;
  payment_status: string | null;
  special_requests: string | null;
}

/**
 * Бронь в том виде, в каком её можно показать модели.
 *
 * Находка аудита 08.09: инструмент возвращал `res.rows` ЦЕЛИКОМ, а строка
 * брони несёт `tourist_name`, `tourist_email` и свободный текст
 * `special_requests`. Результат инструмента уходит обратно в модель, а
 * модель у нас зарубежная (OpenRouter) — то есть это трансграничная
 * передача персональных данных, §8 и 152-ФЗ.
 *
 * Гард D1 (`pii-flow-scanner`) этого не видел и увидеть не мог: он ищет ПД,
 * ВПИСАННЫЕ в текст промпта, а здесь они приезжают результатом инструмента.
 * Дыра не в его настройке, а в том, что путь другой.
 *
 * Что остаётся: номер брони. Именно им её и находят — тот же выбор уже
 * сделан в алертах спасателя («имя туриста в алерт не идёт: находят бронь по
 * номеру»). Оператор видит полные данные в карточке брони, где он и должен
 * их видеть — под своей аутентификацией, а не в чужой LLM.
 *
 * Пожелания не выбрасываются: они бывают про безопасность (аллергия, рост,
 * опыт), и модели они нужны. Но это свободный текст, куда турист сам мог
 * вписать телефон, — поэтому через `redactPII`.
 */
function bookingForModel(r: BookingRow): Record<string, unknown> {
  return {
    booking_id: r.id,
    tour: r.tour_title,
    // Имя и почта намеренно НЕ отдаются: бронь опознаётся номером.
    guest: r.tourist_name ? 'указан' : 'не указан',
    date: r.booking_date,
    participants: r.participants,
    price: r.final_price,
    booking_status: r.booking_status,
    payment_status: r.payment_status,
    special_requests: redactPII(r.special_requests),
  };
}

// ── Revenue ───────────────────────────────────────────────────

const revenue: SDKTool = {
  name: 'operator_revenue',
  description: 'Показать выручку оператора: за 7 дней, 30 дней, всего. Включает количество бронирований и средний чек.',
  parameters: {
    type: 'object',
    properties: {},
  },
  execute: async (args) => {
    const operatorId = args._operatorId as string;
    if (!operatorId) return JSON.stringify({ error: 'Не удалось определить оператора' });

    const res = await pool.query(
      `SELECT
        COALESCE(SUM(ob.final_price) FILTER (WHERE ob.created_at >= CURRENT_DATE - INTERVAL '7 days'), 0)::numeric AS revenue_7d,
        COUNT(*) FILTER (WHERE ob.created_at >= CURRENT_DATE - INTERVAL '7 days')::int AS bookings_7d,
        COALESCE(SUM(ob.final_price) FILTER (WHERE ob.created_at >= CURRENT_DATE - INTERVAL '30 days'), 0)::numeric AS revenue_30d,
        COUNT(*) FILTER (WHERE ob.created_at >= CURRENT_DATE - INTERVAL '30 days')::int AS bookings_30d,
        COALESCE(SUM(ob.final_price), 0)::numeric AS revenue_total,
        COUNT(*)::int AS bookings_total,
        COALESCE(AVG(ob.final_price), 0)::numeric AS avg_check
       FROM operator_bookings ob
       JOIN operator_tours ot ON ot.id = ob.operator_tour_id
       WHERE ot.operator_id = $1 AND ob.booking_status != 'cancelled' AND ob.payment_status = 'paid'`,
      [operatorId],
    );
    return JSON.stringify(res.rows[0] ?? {});
  },
};

// ── Update Price ──────────────────────────────────────────────

const updatePrice: SDKTool = {
  name: 'update_tour_price',
  description: 'Обновить цену тура. Только для туров этого оператора. Нужен ID тура и новая цена. Цена меняется только на число, которое оператор сам написал в сообщении; ход цены больше 50% — ещё и со словом «подтверждаю» в том же сообщении. Иначе отказ — передай его оператору. Цена тура, который уже на сайте, меняется после проверки администратором: если в ответе pending_review — скажи оператору, что цена отправлена на проверку и на сайте пока прежняя.',
  parameters: {
    type: 'object',
    properties: {
      tour_id: { type: 'string', description: 'ID тура (число)' },
      new_price: { type: 'string', description: 'Новая цена в рублях (число)' },
    },
    required: ['tour_id', 'new_price'],
  },
  execute: async (args) => {
    const operatorId = args._operatorId as string;
    if (!operatorId) return JSON.stringify({ error: 'Не удалось определить оператора' });

    const tourId = parseInt(args.tour_id as string, 10);
    const newPrice = parseFloat(args.new_price as string);
    if (isNaN(tourId) || isNaN(newPrice) || newPrice <= 0) {
      return JSON.stringify({ error: 'Некорректный ID тура или цена' });
    }

    // Текущая версия строки (updated_at) — для optimistic concurrency:
    // эффект обновляет ровно ту версию, которую видел, параллельное
    // изменение — честный конфликт, не тихая перезапись.
    const check = await pool.query<{ id: number; title: string; base_price: string; updated_at: Date }>(
      `SELECT id, title, base_price, updated_at FROM operator_tours WHERE id = $1 AND operator_id = $2 AND deleted_at IS NULL`,
      [tourId, operatorId],
    );
    if (check.rowCount === 0) return JSON.stringify({ error: 'Тур не найден или не принадлежит вам' });
    const oldPrice = check.rows[0].base_price;
    const expectedVersion = check.rows[0].updated_at;

    // Величина хода — guardrail ядра, ДО постановки действия: право менять
    // цену не отменяет того, что «12000 вместо 120000» — опечатка. Подтвердить
    // большой ход может только оператор словом «подтверждаю» в своём
    // сообщении — код читает его сам (26.11); аргумента модели больше нет.
    const said = operatorMessageOf(args);
    if (!priceStatedByOperator(said, newPrice)) {
      return JSON.stringify({ error: `Изменение не выполнено: цену помощник ставит только ту, что оператор написал в этом сообщении. Пусть оператор напишет: «поставь цену ${Math.round(newPrice)} на тур ${tourId}».` });
    }
    const move = checkPriceMove(oldPrice, newPrice, operatorConfirmed(said));
    if (!move.ok) {
      return JSON.stringify({ error: `Изменение не выполнено: ${move.reason}`, move_pct: move.move_pct, old_price: oldPrice, new_price: newPrice });
    }

    // Мутация — через ядро: policy (ownership на pre_commit), задача,
    // события эффекта, trace. Ключ идемпотентности стабилен на ИНВОКАЦИЮ
    // (seed от сообщения пользователя): один запрос — один эффект, повтор
    // модели внутри той же инвокации эффект не удвоит.
    const gov = await executeGovernedAction<{ conflict: boolean; pending: string | null }>({
      principal: { type: 'operator', id: operatorId },
      capability: 'tour.update_price',
      resource: { type: 'tour', id: String(tourId) },
      idempotencyKey: invocationKey(args, 'update_tour_price'),
      inputHash: hashInput({ tourId, newPrice }),
      // Запись — единая дверь владельца (lib/tours/tour-change, план готовности
      // 23.11, этап 4): цена тура на витрине уходит на проверку администратору,
      // а не в живую строку. Версия строки сверяется под замком.
      execute: () => transaction(async (client) => {
        const seen = await client.query(
          `SELECT 1 FROM operator_tours
            WHERE id = $1 AND operator_id = $2 AND deleted_at IS NULL AND ${SAME_VERSION_SQL}
            FOR UPDATE`,
          [tourId, operatorId, expectedVersion],
        );
        if (seen.rowCount === 0) return { conflict: true, pending: null };
        const w = await saveTourChange(client, {
          tourId: String(tourId), ownerId: operatorId, userId: null,
          input: { base_price: newPrice }, current: {},
        });
        if (w.outcome === 'not_found') return { conflict: true, pending: null };
        return { conflict: false, pending: w.outcome === 'pending' ? w.pending.notice : null };
      }),
      summarize: (r) => (r.conflict
        ? `цена тура ${tourId}: конфликт версий, не применено`
        : r.pending
          ? `цена тура ${tourId}: ${oldPrice} → ${newPrice}, на проверке`
          : `цена тура ${tourId}: ${oldPrice} → ${newPrice}`),
    });
    if (!gov.ok) return JSON.stringify({ error: `Изменение не выполнено: ${gov.reason}` });
    if (gov.duplicate) return JSON.stringify({ error: 'Повтор запроса: цена уже менялась этим же запросом' });
    if (gov.result.conflict) {
      return JSON.stringify({ error: 'Тур изменён параллельно — обнови данные и повтори' });
    }

    return JSON.stringify({
      success: true,
      tour: check.rows[0].title,
      old_price: oldPrice,
      new_price: newPrice,
      // Цена ушла на проверку: на сайте пока прежняя. Модель обязана сказать
      // это оператору, а не «цена изменена».
      ...(gov.result.pending ? { pending_review: true, note: gov.result.pending } : {}),
      task_id: gov.taskId,
    });
  },
};

// ── Set Published ─────────────────────────────────────────────
// До 27.08 инструмент назывался toggle_tour_publish и делал
// `SET is_published = NOT is_published` — неидемпотентно: повтор вызова
// (retry модели, сетевой ретрай, двойной клик) ОТМЕНЯЛ уже достигнутый
// результат. Агентский инструмент обязан называть целевое состояние.

const setPublished: SDKTool = {
  name: 'set_tour_published',
  description: 'Установить статус публикации тура: published=true — попросить опубликовать (тур выходит на сайт после проверки администратором; в ответе pending_review), published=false — снять с публикации сразу. Повторный вызов с тем же значением безопасен.',
  parameters: {
    type: 'object',
    properties: {
      tour_id: { type: 'string', description: 'ID тура (число)' },
      published: { type: 'boolean', description: 'Целевое состояние публикации' },
    },
    required: ['tour_id', 'published'],
  },
  execute: async (args) => {
    const operatorId = args._operatorId as string;
    if (!operatorId) return JSON.stringify({ error: 'Не удалось определить оператора' });

    const tourId = parseInt(args.tour_id as string, 10);
    if (isNaN(tourId)) return JSON.stringify({ error: 'Некорректный ID тура' });
    if (typeof args.published !== 'boolean') {
      return JSON.stringify({ error: 'Параметр published обязан быть true или false' });
    }
    const published = args.published;
    if (!operatorAsksPublish(operatorMessageOf(args), published)) {
      return JSON.stringify({ error: published
        ? 'Не выполнено: опубликовать тур помощник просит только по прямой просьбе оператора в этом сообщении («опубликуй тур …»).'
        : 'Не выполнено: снять тур с публикации помощник может только по прямой просьбе оператора в этом сообщении («сними тур … с публикации»).' });
    }

    // Текущая версия строки — для optimistic concurrency (см. update_price).
    const cur = await pool.query<{ updated_at: Date }>(
      `SELECT updated_at FROM operator_tours WHERE id = $1 AND operator_id = $2 AND deleted_at IS NULL`,
      [tourId, operatorId],
    );
    if (cur.rowCount === 0) return JSON.stringify({ error: 'Тур не найден или не принадлежит вам' });
    const expectedVersion = cur.rows[0].updated_at;

    // Мутация — через ядро (policy c ownership на pre_commit, задача,
    // события эффекта, trace). Ключ идемпотентности стабилен на ИНВОКАЦИЮ
    // (seed от сообщения пользователя): статичный ключ «tour:id:published»
    // навсегда запретил бы опубликовать тур повторно после снятия, а
    // инвокационный не даёт одному запросу исполниться дважды.
    const gov = await executeGovernedAction<{ title: string; is_published: boolean; pending: string | null } | null>({
      principal: { type: 'operator', id: operatorId },
      capability: 'tour.set_published',
      resource: { type: 'tour', id: String(tourId) },
      idempotencyKey: invocationKey(args, 'set_tour_published'),
      inputHash: hashInput({ tourId, published }),
      // Запись — единая дверь владельца (lib/tours/tour-change, этап 4): снять
      // тур с публикации можно сразу, а опубликовать — только просьбой, которую
      // одобряет администратор. Версия строки сверяется под замком.
      execute: async () => {
        const row = await transaction(async (client) => {
          const seen = await client.query(
            `SELECT 1 FROM operator_tours
              WHERE id = $1 AND operator_id = $2 AND deleted_at IS NULL AND ${SAME_VERSION_SQL}
              FOR UPDATE`,
            [tourId, operatorId, expectedVersion],
          );
          if (seen.rowCount === 0) return null;
          const w = await saveTourChange(client, {
            tourId: String(tourId), ownerId: operatorId, userId: null,
            input: { is_published: published }, current: {},
          });
          if (w.outcome === 'not_found') return null;
          const now = await client.query<{ title: string; is_published: boolean | null }>(
            `SELECT title, is_published FROM operator_tours WHERE id = $1`, [tourId],
          );
          return {
            title: now.rows[0].title,
            is_published: now.rows[0].is_published === true,
            pending: w.outcome === 'pending' ? w.pending.notice : null,
          };
        });
        if (row === null) return null;

        // Аудит эффекта: кто, что, во что перевёл. Отказ записи не роняет
        // действие, но и не молчит (§4.0). Колонки по миграции 059: у
        // ai_actions_log есть action_type и metadata JSONB — agent_id/details
        // там НЕТ (их пишет только код из ALLOWLIST фантомного сторожа).
        await pool.query(
          `INSERT INTO ai_actions_log (action_type, metadata)
           VALUES ('set_tour_published', $1)`,
          [JSON.stringify({ agent: 'operator_sdk', tour_id: tourId, operator_id: operatorId, published })],
        ).catch((err) => {
          console.error('[operator-tools] audit set_tour_published не записан:', err instanceof Error ? err.message : err);
        });
        return row;
      },
      summarize: (row) => (row
        ? `тур ${tourId}: is_published=${row.is_published}${row.pending ? ', просьба о публикации на проверке' : ''}`
        : `тур ${tourId} не найден`),
    });

    if (!gov.ok) return JSON.stringify({ error: `Изменение не выполнено: ${gov.reason}` });
    if (gov.duplicate) return JSON.stringify({ error: 'Повтор запроса: действие уже исполнено ранее' });
    if (!gov.result) {
      // Версия ушла между чтением и эффектом — конфликт, не тихий success.
      return JSON.stringify({ error: 'Тур изменён параллельно — обнови данные и повтори' });
    }

    return JSON.stringify({
      success: true,
      tour: gov.result.title,
      is_published: gov.result.is_published,
      // Просьба о публикации ждёт администратора: «опубликован» было бы неправдой.
      ...(gov.result.pending ? { pending_review: true } : {}),
      message: gov.result.pending
        ?? (gov.result.is_published ? 'Тур опубликован' : 'Тур снят с публикации'),
      task_id: gov.taskId,
    });
  },
};

// ── Tour Stats ────────────────────────────────────────────────

const tourStats: SDKTool = {
  name: 'tour_stats',
  description: 'Статистика конкретного тура: бронирования, выручка, рейтинг, отзывы, конверсия.',
  parameters: {
    type: 'object',
    properties: {
      tour_id: { type: 'string', description: 'ID тура (число)' },
    },
    required: ['tour_id'],
  },
  execute: async (args) => {
    const operatorId = args._operatorId as string;
    if (!operatorId) return JSON.stringify({ error: 'Не удалось определить оператора' });

    const tourId = parseInt(args.tour_id as string, 10);
    if (isNaN(tourId)) return JSON.stringify({ error: 'Некорректный ID тура' });

    const res = await pool.query(
      `SELECT ot.title, ot.base_price, ot.rating, ot.review_count,
              ot.is_published, ot.is_active,
              COUNT(ob.id)::int AS total_bookings,
              COUNT(ob.id) FILTER (WHERE ob.booking_status = 'completed')::int AS completed,
              COUNT(ob.id) FILTER (WHERE ob.booking_status = 'cancelled')::int AS cancelled,
              COALESCE(SUM(ob.final_price) FILTER (WHERE ob.payment_status = 'paid'), 0)::numeric AS total_revenue,
              COALESCE(AVG(ob.participants), 0)::numeric AS avg_group_size
       FROM operator_tours ot
       LEFT JOIN operator_bookings ob ON ob.operator_tour_id = ot.id
       WHERE ot.id = $1 AND ot.operator_id = $2 AND ot.deleted_at IS NULL
       GROUP BY ot.id`,
      [tourId, operatorId],
    );
    if (res.rowCount === 0) return JSON.stringify({ error: 'Тур не найден' });
    return JSON.stringify(res.rows[0]);
  },
};

// ── Export ─────────────────────────────────────────────────────

export function getOperatorTools(operatorId: string, invocationSeed?: string, operatorMessage?: string): SDKTool[] {
  const tools = [myTours, tourBookings, revenue, updatePrice, setPublished, tourStats];
  // operatorId, seed инвокации и сообщение оператора инжектируются ЗДЕСЬ, из
  // доверенного контекста вызывающего роута, и стоят ПОСЛЕ аргументов модели —
  // модель их не задаёт и не подделает. Без сообщения пишущие инструменты
  // отказывают: подтверждать нечем.
  return tools.map(t => ({
    ...t,
    execute: (args: Record<string, unknown>) =>
      t.execute({
        ...args,
        _operatorId: operatorId,
        _operatorMessage: operatorMessage ?? '',
        ...(invocationSeed ? { _invocationSeed: invocationSeed } : {}),
      }),
  }));
}
