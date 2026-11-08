/**
 * Единая функция создания лида.
 * Все точки входа вызывают createLead() — это гарантирует:
 *   1. Скоринг (ни один лид без оценки качества)
 *   2. Вставка в БД (единая точка)
 *   3. Уведомление админу (fire-and-forget, не блокирует ответ)
 */

import { pool } from '@/lib/db-pool';
import { computeQuickScore, classifyLead, LOW_QUALITY_SCORE } from '@/lib/leads/scoring';
import { normalizeLeadChannel } from '@/lib/leads/channel';
import { notifyAdminNewLead } from '@/lib/notifications/telegram-channel';
import type { PdConsentRecord } from '@/lib/legal/pd-consent';
import { linkContactQuietly } from '@/lib/crm/contacts';
import { AGENT_CONSENT_SOURCE } from '@/lib/mcp/request-status';
import { planFingerprint } from '@/lib/leads/plan-fingerprint';
import { currentLeadEntry } from '@/lib/leads/entry-context';

export interface CreateLeadParams {
  /** Имя туриста */
  name: string;
  /** Телефон (может быть пустым для виджета) */
  phone?: string;
  /** Комментарий / сообщение туриста */
  comment?: string;
  /** ID маршрута (если есть) */
  route_id?: string;
  /** Название маршрута (если есть) */
  route_title?: string;
  /** URL страницы откуда пришла заявка */
  source_url?: string;
  /** Метаданные источника */
  source_data?: Record<string, unknown>;
  /** ID оператора (для виджетов партнёров) */
  operator_id?: string | null;
  /** Telegram chat_id (для TG-бота) */
  telegram_chat_id?: string;
  /** Статус лида (по умолчанию 'new') */
  status?: string;
  /**
   * Запись согласия на обработку ПД. null — согласие НЕ зафиксировано (лид из
   * бота или MCP, где формы с галочкой нет). Это третье состояние, а не отказ:
   * лид создаётся, но обстоятельства согласия остаются пустыми и видимыми.
   */
  pd_consent?: PdConsentRecord | null;
  /**
   * Свой лид (владелец проверяет форму или коннектор): cookie vedar_self на
   * сайте, метка ?self= в MCP — lib/analytics/self-visit. Виден в кабинете
   * и в уведомлении с пометкой, в счёт спроса не идёт, follow-up не шлётся.
   */
  is_self?: boolean;
  /**
   * Лид не про подбор тура — AI-конвейер (квалификация, три тура, PDF) ему не
   * нужен и вреден: заявка на вахтовку целой машиной (MCP request_charter)
   * получила бы «предложение» без единого тура и перезаписала бы статус и
   * оценку, да ещё стоила бы несколько вызовов модели на каждый прогон cron.
   * Лид закрывается для cron сразу (processed_at), как лид низкого качества, но
   * менеджеру уведомление уходит, а статус остаётся 'new'.
   */
  skip_ai_processing?: boolean;
}

/**
 * Создаёт лид: скоринг → INSERT → уведомление админу.
 * Возвращает ID созданного лида (или существующего при дубликате).
 *
 * Для /api/leads (форма сайта) вызывается с дополнительными полями:
 *   route_id, route_title, operator_id — они заполняются из schema.
 *
 * Для дедупликации возвращает ID существующего лида вместо вставки: тот же
 * телефон и комментарий за 24ч, у заявки с планом поездки — ещё и тот же
 * план (отпечаток).
 */
/**
 * Свежий лид по телефону и ДЕТЕРМИНИРОВАННОМУ префиксу комментария (24ч).
 * Нужен идемпотентности заявок на бронь из MCP: общий дедуп ниже требует
 * точного совпадения комментария, а агент при ретрае переформулирует хвост.
 * Спецсимволы LIKE в префиксе (название тура) экранируются здесь — вызывающему
 * об этом думать не надо.
 */
export async function findRecentLeadByCommentPrefix(phone: string, prefix: string): Promise<string | null> {
  try {
    const escaped = prefix.replace(/[\\%_]/g, (m) => `\\${m}`);
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM leads
        WHERE phone = $1 AND comment LIKE $2 || '%'
          AND created_at > NOW() - INTERVAL '24 hours'
        LIMIT 1`,
      [phone, escaped],
    );
    return rows[0]?.id ?? null;
  } catch (err) {
    // Дедуп опционален — как в createLead, но отказ называется (§4.0).
    const e = err as { code?: string; message?: string };
    console.error('[leads] проверка дубля по префиксу не выполнилась:', `sqlstate=${e?.code ?? 'нет'}`, e?.message ?? String(err));
    return null;
  }
}

export async function createLead(params: CreateLeadParams): Promise<string | null> {
  return (await createLeadDetailed(params))?.id ?? null;
}

/**
 * То же, что createLead, но говорит, новая ли заявка: дубль (тот же телефон и
 * комментарий за сутки) возвращает прежний лид с `created: false`. Это
 * различие нужно двери, которая выдаёт ключ переписки (1350): ключ повтора
 * переписку не открывает — телефон не секрет.
 */
export async function createLeadDetailed(params: CreateLeadParams): Promise<{ id: string; created: boolean } | null> {
  const {
    name,
    phone = '',
    comment,
    route_id,
    route_title,
    source_url,
    operator_id,
    telegram_chat_id,
    status = 'new',
    pd_consent = null,
    is_self = false,
    skip_ai_processing = false,
  } = params;

  // Вход и инструмент заявки через инструменты Ведара (08.11, владелец:
  // «откуда лиды — человек или ИИ и через какой инструмент»): их знает граница
  // вызова (runPublicTool → lib/leads/entry-context), а не исполнитель, и до
  // этого чат Кузьмича и A2A записывались как MCP. Записанное исполнителем не
  // перетирается.
  const entryCtx = currentLeadEntry();
  const entered = entryCtx && params.source_data?.entry === undefined
    ? { ...params.source_data, entry: entryCtx.entry, ...(params.source_data?.tool === undefined ? { tool: entryCtx.tool } : {}) }
    : params.source_data;

  // Отпечаток плана поездки (аудит планировщика 07.11, H8) — пишется в
  // source_data, чтобы следующая заявка с тем же планом его нашла.
  const fingerprint = planFingerprint(entered?.plan);
  const source_data = fingerprint
    ? { ...entered, plan_fingerprint: fingerprint }
    : entered;

  // ── 1. Скоринг ──────────────────────────────────────────────────────────
  const quickScore = computeQuickScore(name, phone, comment ?? null, source_data ?? null);
  const isLowQuality = quickScore < LOW_QUALITY_SCORE;

  // ── 2. Дубль за 24ч ─────────────────────────────────────────────────────
  // Тот же телефон и тот же комментарий; у заявки с планом — ещё и тот же
  // план (отпечаток, аудит 07.11, H8). У заявки со страницы поездки
  // комментарий «Маршрут: <название> (5 дн.)» одинаков у разных планов на те
  // же даты: без плана в ключе новая заявка молча возвращала прежнюю, и
  // оператор видел старый план. Комментарий из ключа не убран: агент
  // прикладывает один план (plan_id) к заявкам на разные туры, жильё и
  // машину, и различает их только комментарий — без него заявка на второй тур
  // вернула бы первую. Заявка из планировщика бывает без комментария: с
  // планом она тоже ловится, без плана — как прежде, нет.
  const dup = phone && fingerprint
    ? { sql: `SELECT id FROM leads
               WHERE phone = $1 AND COALESCE(comment, '') = $2
                 AND source_data->>'plan_fingerprint' = $3
                 AND created_at > NOW() - INTERVAL '24 hours'
               LIMIT 1`, values: [phone, comment ?? '', fingerprint] }
    : phone && comment
      ? { sql: `SELECT id FROM leads
                 WHERE phone = $1 AND comment = $2
                   AND created_at > NOW() - INTERVAL '24 hours'
                 LIMIT 1`, values: [phone, comment] }
      : null;
  if (dup) {
    try {
      const dupCheck = await pool.query<{ id: string }>(dup.sql, dup.values);
      if (dupCheck.rows.length > 0) {
        return { id: dupCheck.rows[0].id, created: false };
      }
    } catch (err) {
      // Не блокируем — дедуп опционален, но отказ проверки не «дубля нет»,
      // это «не смогли проверить» (§4.0). Продолжаем создавать лид как обычно.
      const e = err as { code?: string; message?: string };
      console.error('[leads] проверка дубля не выполнилась:', `sqlstate=${e?.code ?? 'нет'}`, e?.message ?? String(err));
    }
  }

  // ── 3. Канал и детерминированная атрибуция оператора ────────────────────
  // Канал считается один раз при создании (Рост-5: отчёт партнёру строится
  // по leads.source_channel, а не по разбору свободного source_data на лету).
  const sourceChannel = normalizeLeadChannel({ source_url, source_data, telegram_chat_id });

  // Оператор назначается ТОЛЬКО детерминированно: лид пришёл с маршрута, и
  // активные туры по этому маршруту есть ровно у одного оператора. Матчер
  // lead-processor для атрибуции не годится — он подбирает туры ORDER BY
  // RANDOM() с fallback на любые, приписывать по нему спрос партнёру нечестно.
  let resolvedOperatorId = operator_id ?? null;
  if (!resolvedOperatorId && route_id) {
    try {
      const owners = await pool.query<{ operator_id: string }>(
        `SELECT DISTINCT operator_id FROM operator_tours
          WHERE route_id = $1 AND is_active = true AND deleted_at IS NULL
          LIMIT 2`,
        [route_id],
      );
      if (owners.rows.length === 1) resolvedOperatorId = owners.rows[0].operator_id;
    } catch (err) {
      // Атрибуция опциональна — лид важнее, но отказ называется, не молчит.
      const e = err as { code?: string; message?: string };
      console.error('[leads] атрибуция оператора не выполнилась:', `route_id=${route_id}`, `sqlstate=${e?.code ?? 'нет'}`, e?.message ?? String(err));
    }
  }

  // ── 4. INSERT ───────────────────────────────────────────────────────────
  let leadId: string | null = null;
  try {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO leads (name, phone, comment, route_id, route_title, source_url, source_data, source_channel, ai_score, processed_at, operator_id, telegram_chat_id, status,
                          pd_consent_at, pd_consent_ip, pd_consent_source, pd_consent_version, is_self)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       RETURNING id`,
      [
        name,
        phone,
        comment ?? null,
        route_id ?? null,
        route_title ?? null,
        source_url ?? null,
        source_data ? JSON.stringify(source_data) : null,
        sourceChannel,
        quickScore,
        isLowQuality || skip_ai_processing ? new Date() : null,   // низкое качество или не про подбор тура — сразу закрываем для cron
        resolvedOperatorId,
        telegram_chat_id ?? null,
        status,
        pd_consent?.at ?? null,
        pd_consent?.ip ?? null,
        pd_consent?.source ?? null,
        pd_consent?.version ?? null,
        is_self === true,
      ],
    );
    leadId = res.rows[0]?.id ?? null;
  } catch (err) {
    // Вход в ВСЮ воронку — единственная точка, где создаётся lead. Молчащий
    // catch здесь означает не «лида нет», а «не узнаем никогда, почему».
    // Тот же класс дефекта уже стоил funnel_events и operator_commissions
    // всех записей — там тоже был пустой catch на месте, где нельзя молчать.
    const e = err as { code?: string; message?: string };
    console.error('[leads] INSERT не выполнился:', `channel=${sourceChannel}`, `sqlstate=${e?.code ?? 'нет'}`, e?.message ?? String(err));
    return null;
  }

  // Лид оператора — его клиент в CRM (#2325); отказ CRM заявку не роняет.
  if (leadId) await linkContactQuietly('lead', leadId);

  // ── 5. Уведомление админу (fire-and-forget) ─────────────────────────────
  // Пропускаем для низкого качества — не спамим
  if (leadId && !isLowQuality) {
    const quality = classifyLead(quickScore);
    void notifyAdminNewLead({
      id: leadId,
      name,
      phone: phone || '',
      comment,
      sourceUrl: source_url,
      sourceData: source_data,
      score: quickScore,
      labelRu: quality.labelRu,
      isSelf: is_self === true,
      byAgent: pd_consent?.source === AGENT_CONSENT_SOURCE,
      pdConsentSource: pd_consent?.source ?? null,
    }).catch((e) => console.error('[createLead] notifyAdminNewLead failed:', e));
  }

  return leadId ? { id: leadId, created: true } : null;
}
