/**
 * Канал происхождения лида — единый словарь и единственный нормализатор.
 *
 * Рост-5 (стратегия 14.08): партнёру продаётся измеримый входящий спрос,
 * значит у каждого лида должен быть честный ответ «откуда пришёл». Сырьё
 * уже есть — каждая точка входа передаёт в createLead() свои source_url и
 * source_data, но в свободной форме: отчёт по ним не построить. Канал
 * вычисляется здесь ОДИН раз при создании лида и пишется в
 * leads.source_channel (миграция 860).
 *
 * Правила детерминированные, по фактическим сигнатурам вызывающих
 * (mcp/route.ts, telegram/webhook, max/kuzmich, widget/chat,
 * ai/booking-intake, leads POST). Непознанное — 'other', не догадка.
 */

export const LEAD_CHANNELS = [
  'telegram',        // Кузьмич в Telegram (t.me / telegram_chat_id)
  'max',             // Кузьмич в MAX
  'widget',          // партнёрский виджет на чужом сайте
  'mcp',             // AI-агенты через vedar-mcp
  'site_chat',       // чат-приёмник на сайте (booking-intake)
  'site_route',      // форма заявки со страницы маршрута /routes/[id]
  'site_tour',       // форма со страницы тура
  'site_planner',    // планировщик
  'site',            // сайт, страница точнее не определена
  'other',           // источник не распознан
] as const;

export type LeadChannel = (typeof LEAD_CHANNELS)[number];

export interface ChannelSignals {
  source_url?: string | null;
  source_data?: Record<string, unknown> | null;
  telegram_chat_id?: string | null;
}

/** Детерминированный канал лида по сигналам точки входа. */
export function normalizeLeadChannel(s: ChannelSignals): LeadChannel {
  const url = s.source_url ?? '';
  const data = s.source_data ?? {};
  const src = typeof data.source === 'string' ? data.source : '';

  if (src === 'mcp' || url.startsWith('mcp://')) return 'mcp';
  if (src === 'max_bot' || url.includes('max.ru')) return 'max';
  if (s.telegram_chat_id || url.includes('t.me/')) return 'telegram';
  if (data.type === 'widget') return 'widget';
  if (src === 'booking_intake_bot' || url.includes('/api/ai/booking-intake')) return 'site_chat';

  // Форма сайта: source_url — адрес страницы, откуда отправлена заявка.
  if (/^https?:\/\/|^\//.test(url)) {
    if (url.includes('/routes/')) return 'site_route';
    if (url.includes('/tours/')) return 'site_tour';
    if (url.includes('/planner')) return 'site_planner';
    return 'site';
  }

  return 'other';
}
