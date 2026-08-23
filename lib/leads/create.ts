/**
 * Единая функция создания лида.
 * Все точки входа вызывают createLead() — это гарантирует:
 *   1. Скоринг (ни один лид без оценки качества)
 *   2. Вставка в БД (единая точка)
 *   3. Уведомление админу (fire-and-forget, не блокирует ответ)
 */

import { pool } from '@/lib/db-pool';
import { computeQuickScore, classifyLead } from '@/lib/leads/scoring';
import { normalizeLeadChannel } from '@/lib/leads/channel';
import { notifyAdminNewLead } from '@/lib/notifications/telegram-channel';
import type { PdConsentRecord } from '@/lib/legal/pd-consent';

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
}

/**
 * Создаёт лид: скоринг → INSERT → уведомление админу.
 * Возвращает ID созданного лида (или существующего при дубликате).
 *
 * Для /api/leads (форма сайта) вызывается с дополнительными полями:
 *   route_id, route_title, operator_id — они заполняются из schema.
 *
 * Для дедупликации (тот же телефон + комментарий за 24ч)
 * возвращает ID существующего лида вместо вставки.
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
  } catch {
    return null; // дедуп опционален — как в createLead
  }
}

export async function createLead(params: CreateLeadParams): Promise<string | null> {
  const {
    name,
    phone = '',
    comment,
    route_id,
    route_title,
    source_url,
    source_data,
    operator_id,
    telegram_chat_id,
    status = 'new',
    pd_consent = null,
  } = params;

  // ── 1. Скоринг ──────────────────────────────────────────────────────────
  const quickScore = computeQuickScore(name, phone, comment ?? null, source_data ?? null);
  const isLowQuality = quickScore < 30;

  // ── 2. Дубль: тот же телефон + тот же комментарий за 24ч ────────────────
  if (phone && comment) {
    try {
      const dupCheck = await pool.query<{ id: string }>(
        `SELECT id FROM leads
         WHERE phone = $1 AND comment = $2
           AND created_at > NOW() - INTERVAL '24 hours'
         LIMIT 1`,
        [phone, comment],
      );
      if (dupCheck.rows.length > 0) {
        return dupCheck.rows[0].id;
      }
    } catch {
      // Не блокируем — дедуп опционален
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
    } catch { /* атрибуция опциональна — лид важнее */ }
  }

  // ── 4. INSERT ───────────────────────────────────────────────────────────
  let leadId: string | null = null;
  try {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO leads (name, phone, comment, route_id, route_title, source_url, source_data, source_channel, ai_score, processed_at, operator_id, telegram_chat_id, status,
                          pd_consent_at, pd_consent_ip, pd_consent_source, pd_consent_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
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
        isLowQuality ? new Date() : null,   // низкое качество — сразу закрываем для cron
        resolvedOperatorId,
        telegram_chat_id ?? null,
        status,
        pd_consent?.at ?? null,
        pd_consent?.ip ?? null,
        pd_consent?.source ?? null,
        pd_consent?.version ?? null,
      ],
    );
    leadId = res.rows[0]?.id ?? null;
  } catch {
    return null;
  }

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
    }).catch((e) => console.error('[createLead] notifyAdminNewLead failed:', e));
  }

  return leadId;
}
