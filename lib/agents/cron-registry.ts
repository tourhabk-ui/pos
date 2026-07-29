/**
 * lib/agents/cron-registry.ts
 *
 * Единый реестр запланированных cron-агентов платформы — источник правды для
 * liveness-панели «AI и автоматизации». Расписания сверены с
 * .github/workflows/cron-*.yml; agentId — по фактическим писателям в
 * agent_run_history (grep logAgentRun / INSERT INTO agent_run_history).
 *
 * Принцип «не врать»: agentId === null означает, что cron НЕ пишет телеметрию в
 * agent_run_history. Такой агент показывается со статусом «нет телеметрии», а НЕ
 * зелёным. Врать зелёным про непроверяемую джобу запрещено.
 *
 * Меняешь cron в workflow — обнови cron/everyMin здесь. Реестр — данные, не код.
 */

export type CronTier = 'safety' | 'ops' | 'growth' | 'content' | 'quality';

export interface CronEntry {
  /** Стабильный ключ строки */
  key: string;
  /** Человеческое имя */
  label: string;
  /** Что делает — одна строка */
  description: string;
  /** Файл workflow (для ссылки на GitHub Actions) */
  workflow: string;
  /** cron-выражение как в workflow */
  cron: string;
  /** Человеческое расписание */
  schedule: string;
  /** Ожидаемый максимальный интервал между запусками, мин (для liveness) */
  everyMin: number;
  /** Разряд критичности — определяет порог тревоги и порядок */
  tier: CronTier;
  /** agent_id в agent_run_history или null, если джоба не инструментирована */
  agentId: string | null;
  /** Можно ли запустить вручную через /api/admin/agents/trigger */
  triggerable: boolean;
}

const DAY = 1440;
const WEEK = 10080;
const MONTH = 44640; // 31 сутки — верхняя граница для ежемесячных джоб

// Порядок разрядов: сначала безопасность
export const TIER_ORDER: CronTier[] = ['safety', 'ops', 'quality', 'growth', 'content'];

export const TIER_LABELS: Record<CronTier, string> = {
  safety: 'Безопасность',
  ops: 'Операции',
  quality: 'Качество',
  growth: 'Рост',
  content: 'Контент',
};

export const CRON_REGISTRY: CronEntry[] = [
  // ── Безопасность ─────────────────────────────────────────────────────────
  {
    key: 'safety-ingest', label: 'Safety Ingest',
    description: 'КБГС РАН / МЧС фиды → тревоги (цунами от 185 км ≈ 15 мин).',
    workflow: 'cron-safety-ingest.yml', cron: '*/5 * * * *', schedule: 'каждые 5 мин',
    everyMin: 5, tier: 'safety', agentId: 'safety-ingest', triggerable: false,
  },
  {
    key: 'watchdog', label: 'Watchdog',
    description: 'Единственный сторож: SOS-таймаут, брони без подтверждения, лиды, мёртвый сейсмо-крон.',
    workflow: 'cron-watchdog.yml', cron: '*/30 * * * *', schedule: 'каждые 30 мин',
    everyMin: 30, tier: 'safety', agentId: 'watchdog', triggerable: true,
  },
  {
    key: 'sos-bridge', label: 'SOS Events Bridge',
    description: 'Мост SOS-событий в шину агентов.',
    workflow: 'cron-sos-bridge.yml', cron: '10,40 * * * *', schedule: 'каждые 30 мин',
    everyMin: 30, tier: 'safety', agentId: 'sos-bridge', triggerable: false,
  },
  {
    key: 'danger-analysis', label: 'Danger Analysis',
    description: 'Оценка риска по зонам Камчатки.',
    workflow: 'cron-danger-analysis.yml', cron: '0,30 * * * *', schedule: 'каждые 30 мин',
    everyMin: 30, tier: 'safety', agentId: 'danger-analysis', triggerable: false,
  },
  {
    key: 'checkin-watchdog', label: 'Check-in Watchdog',
    description: 'Эскалация просроченных регистраций туристов (МЧС).',
    workflow: 'cron-checkin-watchdog.yml', cron: '0 * * * *', schedule: 'каждый час',
    everyMin: 60, tier: 'safety', agentId: 'checkin-watchdog', triggerable: false,
  },
  {
    key: 'kvert-acc', label: 'KVERT ACC',
    description: 'Авиационные цветовые коды вулканов (KVERT).',
    workflow: 'cron-kvert-acc.yml', cron: '17 */6 * * *', schedule: 'каждые 6 ч',
    everyMin: 360, tier: 'safety', agentId: 'kvert-acc', triggerable: false,
  },
  {
    key: 'safety-check', label: 'Safety Self-Check',
    description: 'Синтетическая проверка safety-флоу.',
    workflow: 'cron-safety-check.yml', cron: '15 */6 * * *', schedule: 'каждые 6 ч',
    everyMin: 360, tier: 'safety', agentId: 'safety-check', triggerable: false,
  },
  {
    key: 'rescue', label: 'Rescue',
    description: 'Погодные угрозы ближайшим турам + отток операторов. SOS/брони — у Watchdog.',
    workflow: 'cron-rescue.yml', cron: '15,45 * * * *', schedule: 'каждые 30 мин',
    everyMin: 30, tier: 'safety', agentId: 'rescue', triggerable: true,
  },

  // ── Операции ─────────────────────────────────────────────────────────────
  {
    key: 'leads', label: 'Lead Processing',
    description: 'AI-обработка лидов + follow-up напоминания.',
    workflow: 'cron-leads.yml', cron: '*/30 * * * *', schedule: 'каждые 30 мин',
    everyMin: 30, tier: 'ops', agentId: null, triggerable: false,
  },
  {
    key: 'tg-watchdog', label: 'Telegram Webhook Watchdog',
    description: 'Проверка и починка вебхука бота.',
    workflow: 'cron-tg-watchdog.yml', cron: '5,35 * * * *', schedule: 'каждые 30 мин',
    everyMin: 30, tier: 'ops', agentId: null, triggerable: false,
  },
  {
    key: 'health', label: 'System Health Check',
    description: 'AI-провайдеры, БД, платежи.',
    workflow: 'cron-health.yml', cron: '20 * * * *', schedule: 'каждый час',
    everyMin: 60, tier: 'ops', agentId: 'health', triggerable: false,
  },
  {
    key: 'llm-budget', label: 'LLM Budget Check',
    description: 'Контроль дневного бюджета AI.',
    workflow: 'cron-llm-budget.yml', cron: '30 * * * *', schedule: 'каждый час',
    everyMin: 60, tier: 'ops', agentId: 'llm-budget', triggerable: false,
  },
  {
    key: 'payments', label: 'Abandoned Booking Recovery',
    description: 'Поиск брошенных бронирований.',
    workflow: 'cron-payments.yml', cron: '0 * * * *', schedule: 'каждый час',
    everyMin: 60, tier: 'ops', agentId: 'payments', triggerable: false,
  },
  {
    key: 'channel-sync', label: 'Channel Sync',
    description: 'Заказы из Tripster/Авито/Sputnik8.',
    workflow: 'cron-channel-sync.yml', cron: '15,45 * * * *', schedule: 'каждые 30 мин',
    everyMin: 30, tier: 'ops', agentId: 'channel-sync', triggerable: false,
  },
  {
    key: 'support-escalate', label: 'Support Escalate',
    description: 'Эскалация зависших тикетов поддержки (>24ч).',
    workflow: 'cron-support-escalate.yml', cron: '0 */2 * * *', schedule: 'каждые 2 ч',
    everyMin: 120, tier: 'ops', agentId: 'support-escalate', triggerable: false,
  },
  {
    key: 'route-escalation', label: 'Route Escalation',
    description: 'Маршруты без ответа.',
    workflow: 'cron-route-escalation.yml', cron: '30 */2 * * *', schedule: 'каждые 2 ч',
    everyMin: 120, tier: 'ops', agentId: 'route-escalation', triggerable: false,
  },
  {
    key: 'tour-reminder', label: 'Tour Reminder',
    description: 'Напоминание о туре за 24ч.',
    workflow: 'cron-tour-reminder.yml', cron: '0 6 * * *', schedule: 'ежедневно · 06:00 UTC',
    everyMin: DAY, tier: 'ops', agentId: null, triggerable: false,
  },
  {
    key: 'trip-reminders', label: 'Trip Reminders',
    description: 'Напоминание туристам за 2 дня.',
    workflow: 'cron-trip-reminders.yml', cron: '0 5 * * *', schedule: 'ежедневно · 05:00 UTC',
    everyMin: DAY, tier: 'ops', agentId: null, triggerable: false,
  },
  {
    key: 'booking-stall', label: 'Booking Stall Alert',
    description: '0 броней за 7 дней → алерт.',
    workflow: 'cron-booking-stall.yml', cron: '0 8 * * *', schedule: 'ежедневно · 08:00 UTC',
    everyMin: DAY, tier: 'ops', agentId: 'booking-stall', triggerable: false,
  },
  {
    key: 'eco-expire', label: 'Сгорание эко',
    description: 'Истёкшие эко сжигаются проводкой; после прогона сверяется инвариант реестра.',
    workflow: 'cron-eco-expire.yml', cron: '7 2 * * *', schedule: 'ежедневно · 02:00 UTC',
    everyMin: DAY, tier: 'ops', agentId: 'eco-expire', triggerable: false,
  },
  {
    key: 'ssr-sentinel', label: 'SSR-сторож листингов',
    description: 'Проверка SSR листингов /routes, /operators (SEO).',
    workflow: 'cron-ssr-sentinel.yml', cron: '0 5 * * 1', schedule: 'пн · 05:00 UTC',
    everyMin: WEEK, tier: 'ops', agentId: null, triggerable: false,
  },

  // ── Качество ─────────────────────────────────────────────────────────────
  {
    // Сверено с кодом 24.07: cron-kuzmich-eval.yml дёргает /api/cron/kuzmich-eval,
    // который пишет agent_id 'kuzmich-eval' (и 'kuzmich-eval-live' при source=live).
    // До этого здесь стоял agentId 'kuzmich-redteam' — телеметрия ДРУГОЙ джобы
    // (ежемесячный red-team), из-за чего панель могла показывать недельный eval
    // зелёным по чужим прогонам. Реестр сам запрещает врать зелёным — исправлено.
    key: 'kuzmich-eval', label: 'Kuzmich Faithfulness Eval',
    description: 'Faithfulness-регрессия ответов Кузьмича + живые вопросы.',
    workflow: 'cron-kuzmich-eval.yml', cron: '0 5 * * 1', schedule: 'пн · 05:00 UTC',
    everyMin: WEEK, tier: 'quality', agentId: 'kuzmich-eval', triggerable: false,
  },
  {
    // Отдельная джоба: redteam-kuzmich.yml → /api/cron/kuzmich-redteam
    // (пишет agent_id 'kuzmich-redteam'). В реестр не попадала, потому что имя
    // файла не по шаблону cron-*.yml — значит в liveness-панели её не было вовсе.
    key: 'kuzmich-redteam', label: 'Kuzmich Red-Team',
    description: 'Состязательный (adversarial) прогон Кузьмича на устойчивость.',
    workflow: 'redteam-kuzmich.yml', cron: '0 4 1 * *', schedule: '1-е число · 04:00 UTC',
    everyMin: MONTH, tier: 'quality', agentId: 'kuzmich-redteam', triggerable: false,
  },
  {
    key: 'kb-gap', label: 'KB Gap',
    description: 'Анализ пробелов в знаниях Кузьмича.',
    workflow: 'cron-kb-gap.yml', cron: '0 4 * * *', schedule: 'ежедневно · 04:00 UTC',
    everyMin: DAY, tier: 'quality', agentId: null, triggerable: false,
  },

  // ── Рост ─────────────────────────────────────────────────────────────────
  {
    key: 'evo', label: 'Evo System',
    description: 'Growth Scan + Evolution Loop + intel-bridge + model-watcher → GitHub Issues.',
    workflow: 'cron-evo.yml', cron: '13 17,20,23 * * *', schedule: '3× в сутки · 17/20/23 UTC (off-peak)',
    everyMin: DAY, tier: 'growth', agentId: 'evo', triggerable: true,
  },
  {
    key: 'intelligence', label: 'Intelligence Monitor',
    description: 'Сигналы AI/тревел/конкуренты из RSS и поиска → Brain.',
    workflow: 'cron-intelligence.yml', cron: '0 3,9,15,21 * * *', schedule: 'каждые 6 ч · 3/9/15/21 UTC',
    everyMin: 360, tier: 'growth', agentId: 'intelligence', triggerable: true,
  },
  {
    key: 'scout', label: 'Scout-Innovator',
    description: 'Brain → платформа → 2-3 предложения → Telegram.',
    workflow: 'cron-scout.yml', cron: '0 8 * * *', schedule: 'ежедневно · 08:00 UTC',
    everyMin: DAY, tier: 'growth', agentId: 'scout', triggerable: true,
  },
  {
    key: 'scout-digest', label: 'Scout Digest',
    description: 'RSS (Habr, RATA, Tourprom, Kamgov) → AI-синтез → дайджест в Telegram.',
    workflow: 'cron-scout-digest.yml', cron: '0 7 * * *', schedule: 'ежедневно · 07:00 UTC',
    everyMin: DAY, tier: 'growth', agentId: 'scout-digest', triggerable: true,
  },
  {
    key: 'group-scout', label: 'Group Scout',
    description: 'Разведка TG-групп по туризму.',
    workflow: 'cron-group-scout.yml', cron: '0 18 * * 0', schedule: 'вс · 18:00 UTC',
    everyMin: WEEK, tier: 'growth', agentId: null, triggerable: false,
  },
  {
    key: 'memory-bridge', label: 'Memory Bridge',
    description: 'Синхронизация предпочтений пользователей в память агентов.',
    workflow: 'cron-memory-bridge.yml', cron: '0 1,7,13,19 * * *', schedule: 'каждые 6 ч',
    everyMin: 360, tier: 'growth', agentId: null, triggerable: false,
  },
  {
    key: 'engagement', label: 'Engagement',
    description: 'Реэнгейджмент туристов Кузьмичом.',
    workflow: 'cron-engagement.yml', cron: '0 10 * * *', schedule: 'ежедневно · 10:00 UTC',
    everyMin: DAY, tier: 'growth', agentId: null, triggerable: false,
  },
  {
    key: 'smart-notify', label: 'Smart Notify',
    description: 'Матч туров под предпочтения пользователя.',
    workflow: 'cron-smart-notify.yml', cron: '0 11 * * *', schedule: 'ежедневно · 11:00 UTC',
    everyMin: DAY, tier: 'growth', agentId: null, triggerable: false,
  },
  {
    key: 'osm-traces-scout', label: 'OSM Traces Scout',
    description: 'GPS-записи туристов из OSM.',
    workflow: 'cron-osm-traces.yml', cron: '30 5 * * *', schedule: 'ежедневно · 05:30 UTC',
    everyMin: DAY, tier: 'growth', agentId: 'osm-traces-scout', triggerable: false,
  },

  // ── Контент ──────────────────────────────────────────────────────────────
  {
    key: 'editor', label: 'Editor',
    description: 'Туры с описанием <300 символов → AI переписывает.',
    workflow: 'cron-editor.yml', cron: '0 22 * * *', schedule: 'ежедневно · 22:00 UTC (off-peak)',
    everyMin: DAY, tier: 'content', agentId: 'editor', triggerable: true,
  },
  {
    key: 'enrich-routes', label: 'Enrich Routes',
    description: 'Обогащение описаний маршрутов (20/запуск).',
    workflow: 'cron-enrich-routes.yml', cron: '0 23 * * *', schedule: 'ежедневно · 23:00 UTC (off-peak)',
    everyMin: DAY, tier: 'content', agentId: null, triggerable: false,
  },
  {
    key: 'routes-cache', label: 'Routes Cache Refresh',
    description: 'Обновление кэша описаний маршрутов.',
    workflow: 'cron-routes-cache.yml', cron: '0 13 * * *', schedule: 'ежедневно · 13:00 UTC',
    everyMin: DAY, tier: 'content', agentId: null, triggerable: false,
  },
  {
    key: 'kuzmich-places', label: 'Kuzmich Place Reviews',
    description: 'Рецензии Кузьмича для мест (20/запуск).',
    workflow: 'cron-kuzmich-places.yml', cron: '0 3 * * *', schedule: 'ежедневно · 03:00 UTC',
    everyMin: DAY, tier: 'content', agentId: null, triggerable: false,
  },
  {
    key: 'import-routes', label: 'Import Route Passports',
    description: 'Паспорта маршрутов visitkamchatka.ru.',
    workflow: 'cron-import-routes.yml', cron: '0 0 * * *', schedule: 'ежедневно · 00:00 UTC',
    everyMin: DAY, tier: 'content', agentId: null, triggerable: false,
  },
  {
    key: 'kuzmich-route', label: 'Kuzmich Route Post',
    description: 'Пост о маршруте в канал (TG + MAX).',
    workflow: 'cron-kuzmich-route.yml', cron: '0 9 * * *', schedule: 'ежедневно · 09:00 UTC',
    everyMin: DAY, tier: 'content', agentId: null, triggerable: false,
  },
  {
    key: 'kuzmich-tip', label: 'Kuzmich Tip Post',
    description: 'Совет туристу в канал.',
    workflow: 'cron-kuzmich-tip.yml', cron: '0 14 * * 1,3,5', schedule: 'пн/ср/пт · 14:00 UTC',
    everyMin: 4320, tier: 'content', agentId: null, triggerable: false,
  },
  {
    key: 'kuzmich-sezon', label: 'Kuzmich Seasonal Post',
    description: 'Сезонный пост в канал.',
    workflow: 'cron-kuzmich-sezon.yml', cron: '23 16 * * 2,6', schedule: 'вт/сб · 16:23 UTC',
    everyMin: 4320, tier: 'content', agentId: null, triggerable: false,
  },
  {
    key: 'place-images', label: 'Place Images Backfill',
    description: 'Догоняет точки без фото: Qwen-Image обложки пачками до remaining=0.',
    workflow: 'cron-place-images.yml', cron: '17 21 * * *', schedule: 'ежедневно · 21:17 UTC',
    everyMin: DAY, tier: 'content', agentId: null, triggerable: false,
  },
];

/**
 * Что означает прогон, отработавший вхолостую (items_processed = 0).
 *
 * Liveness отвечает на вопрос «крон запускался», и не отвечает на «крон что-то
 * сделал». В этой щели жили все поломки, которые за июль находил владелец, а не
 * платформа: KVERT отдавал `fetched: 0` в день, когда Шивелуч дважды выбросил
 * пепел, и прогон был зелёным; прочёс эволюции считал репозиторий из десяти
 * файлов; kamgov неделями возвращал ошибку внутри успешного ответа. Каждый раз
 * ноль выглядел как здоровье, потому что смотреть было не на что.
 *
 * Судить по нулю можно только там, где ноль ненормален. Ноль просроченных
 * регистраций — хорошая новость, ноль вулканов от KVERT — мёртвый слой. Разницу
 * знает только человек, поэтому она объявляется здесь явно, а не выводится:
 *
 *  - `broken` — источник публикует постоянно, ноль означает обрыв канала;
 *  - `normal` — ноль штатен и часто желателен (очередь пуста, проблем нет);
 *  - `unknown` — крон не пишет счётчик работы либо ноль неинтерпретируем.
 *
 * `unknown` — честная позиция, а не заглушка: врать тревогой по счётчику,
 * которого нет, хуже, чем молчать. Тест `cron-idle-coverage` требует, чтобы у
 * каждого крона реестра значение было проставлено осознанно.
 */
export type IdleMeaning = 'broken' | 'normal' | 'unknown';

export const CRON_IDLE_MEANING: Record<string, IdleMeaning> = {
  // ── Безопасность ────────────────────────────────────────────────────────
  // Ноль событий за пять минут — тишина, а не поломка; у ingest свой пофидовый
  // сторож (SAFETY_SOURCE_EXPECTATIONS), дублировать его нечем.
  'safety-ingest': 'normal',
  // Ноль найденных проблем — то, ради чего сторож и работает.
  'watchdog': 'normal',
  'sos-bridge': 'normal',
  'checkin-watchdog': 'normal',
  'rescue': 'normal',
  // Оценивает зоны Камчатки на каждом прогоне: ноль оценок = не считал.
  'danger-analysis': 'broken',
  // KVERT публикует коды по действующим вулканам постоянно.
  'kvert-acc': 'broken',
  'safety-check': 'unknown',

  // ── Операции ────────────────────────────────────────────────────────────
  // Ноль проблем со здоровьем системы и ноль сгоревших эко — норма.
  'health': 'normal',
  'eco-expire': 'normal',
  // Ниже — кроны, которые счётчик работы не пишут вовсе: судить не по чему.
  'leads': 'unknown',
  'tg-watchdog': 'unknown',
  'llm-budget': 'unknown',
  'payments': 'unknown',
  'channel-sync': 'unknown',
  'support-escalate': 'unknown',
  'route-escalation': 'unknown',
  'tour-reminder': 'unknown',
  'trip-reminders': 'unknown',
  'booking-stall': 'unknown',
  'ssr-sentinel': 'unknown',

  // ── Качество ────────────────────────────────────────────────────────────
  'kuzmich-eval': 'unknown',
  'kuzmich-redteam': 'unknown',
  'kb-gap': 'unknown',

  // ── Рост ────────────────────────────────────────────────────────────────
  // items = сырые сигналы из RSS: ноль означает, что фиды не достались.
  'intelligence': 'broken',
  // items = найденные сигналы. Сутки без новостей бывают, трое подряд по
  // двенадцати фидам — это обрыв, а не спокойная неделя.
  'scout-digest': 'broken',
  // У Growth Scan ноль находок — желаемый исход, тревожить по нему нельзя.
  'evo': 'normal',
  'scout': 'unknown',
  'group-scout': 'unknown',
  'memory-bridge': 'unknown',
  'engagement': 'unknown',
  'smart-notify': 'unknown',
  // OSM с Timeweb недоступен — ноль здесь известен и объяснён внешней
  // причиной; тревога была бы шумом поверх уже понятого.
  'osm-traces-scout': 'unknown',

  // ── Контент ─────────────────────────────────────────────────────────────
  // items = туры с коротким описанием: ноль означает, что переписывать нечего.
  'editor': 'normal',
  'enrich-routes': 'unknown',
  'routes-cache': 'unknown',
  'kuzmich-places': 'unknown',
  'import-routes': 'unknown',
  'kuzmich-route': 'unknown',
  'kuzmich-tip': 'unknown',
  'kuzmich-sezon': 'unknown',
  'place-images': 'unknown',
};

export function idleMeaning(key: string): IdleMeaning {
  return CRON_IDLE_MEANING[key] ?? 'unknown';
}

export function entriesByTier(): Array<{ tier: CronTier; label: string; entries: CronEntry[] }> {
  return TIER_ORDER.map(tier => ({
    tier,
    label: TIER_LABELS[tier],
    entries: CRON_REGISTRY.filter(e => e.tier === tier),
  })).filter(g => g.entries.length > 0);
}
