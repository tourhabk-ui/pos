/**
 * lib/agents/warmup.ts
 *
 * Shared warm-up module for cron agents.
 * Solves the cold-start problem: agents previously started with no context
 * and had to guess instead of reading real state.
 *
 * Two entry points:
 *   writeDailyBriefing() — called by Scout-Innovator at 08:00 UTC; writes
 *     a platform snapshot to agent_knowledge (slug='daily-briefing').
 *   readAgentBriefing(agentId) — called by each cron agent at startup;
 *     returns platform state + this agent's own run history.
 */

import { pool } from '@/lib/db-pool';
import { knowledgeBase } from '@/lib/agents/memory/agent-knowledge';
import { runRepoScan } from '@/lib/agents/repo-scanner';

/**
 * Tourism domain knowledge every agent must carry.
 * Injected into readAgentBriefing() so all cron agents see it at startup.
 */
export const TOURISM_DOMAIN = `
=== MUST-HAVE: ТУРИЗМ НА КАМЧАТКЕ ===

СЕЗОННОСТЬ:
- Полевой сезон: июнь–сентябрь. Вертолёты: июнь–сентябрь.
- Зима: декабрь–апрель (лыжи, снегоходы, подлёдная рыбалка).
- Май и октябрь — межсезонье. Перевалы закрыты, часть маршрутов недоступна.
- Рыбалка: горбуша июль–август, нерка июль–сентябрь, чавыча июнь–июль, кижуч август–октябрь, форель круглый год.

ЛОГИСТИКА В ПОЛЕ:
- 80% ключевых объектов — без дорог. Нужен вертолёт (от 25 000 ₽/чел) или 4WD + часы езды.
- Сотовая связь: только вблизи ПКО и нескольких сёл. В поле — нет.
- Маршрут >1 дня в зоне без связи = обязательная регистрация в МЧС.

БЕЗОПАСНОСТЬ (нельзя игнорировать в любом контексте):
- МЧС регистрация: обязательна на 154 маршрутах (mchs_registration_required).
- Природные парки: Налычево, Ключевской, Мутновско-Гореловский — нужен пропуск.
- Медведи: активны июль–сентябрь у рек. Дистанция ≥100 м, антизверь обязателен.
- Горячие источники: термальные до 90°C. Перед заходом измерять температуру.
- Вулканы: Авачинский и Корякский — активные. Следить за бюллетенями КБГС РАН.
- Экстренные контакты: 112 | МЧС Камчатка 8-415-2-11-05-05 | ПСО «Камчатка» 8-415-2-41-27-30.

ИНСТРУМЕНТЫ БЕЗОПАСНОСТИ ПЛАТФОРМЫ:
- /emergency.html — офлайн, 0 зависимостей, GPS + 112 + 4 протокола выживания
- /sos — SOS с офлайн-очередью (IndexedDB) + VolcanoMesh P2P ретрансляция
- /safety/offline — медведь, вулкан, гипотермия, потерялся — без интернета
- Геофенс — автоалерт при входе в зону опасности (активный вулкан, лавина)
- Офлайн-карта: зум 7–9 кешируется всегда (~8 МБ), зум 10+ по маршруту через /offline/manage

ЦЕНОВЫЕ ОРИЕНТИРЫ (для контекста):
- Вертолётный тур (гейзеры / Долина): 25 000–100 000 ₽/чел
- Экскурсия 1 день 4WD: 5 000–15 000 ₽/чел
- Треккинг с гидом: 5 000–15 000 ₽/день
- Рыбалка речная: 10 000–30 000 ₽/день
- Размещение на базе: 2 000–8 000 ₽/ночь

ПУТЬ ТУРИСТА (journey stages):
1. Планирование → маршруты, сезон, логистика, сложность
2. Подготовка → МЧС регистрация, пропуск в парк, снаряжение, офлайн-карты
3. В поле → GPS, геофенс, меш-SOS, протоколы при встрече с медведем
4. Экстренно → /emergency.html, 112, VolcanoMesh, МЧС Камчатка
`.trim();

export interface AgentBriefing {
  /** Counts from DB + agent health summary */
  platformSummary: string;
  /** Last 5 runs of THIS agent */
  recentRuns: string;
  /** Last run of EACH agent (already embedded in platformSummary) */
  systemRuns: string;
  /** Last 3 proposals from Scout-Innovator Brain */
  recentDecisions: string;
}

interface InvRow {
  places: string;
  routes: string;
  tours: string;
  partners: string;
  bookings_week: string;
  confirmed_week: string;
}

interface RunRow {
  agent_id: string;
  status: string;
  started_at: string;
  items_processed: number | null;
  error_msg: string | null;
}

interface HealthRow {
  memory_total: string;
  runs_24h: string;
  errors_24h: string;
}

interface OwnRunRow {
  status: string;
  started_at: string;
  items_processed: number | null;
  items_created: number | null;
  error_msg: string | null;
}

/**
 * Called by Scout-Innovator at 08:00 UTC before synthesizing proposals.
 * Writes slug='daily-briefing', type='briefing' to agent_knowledge.
 * Pass gitLog (last N commit messages) if available.
 */
export async function writeDailyBriefing(gitLog?: string): Promise<void> {
  try {
    const [invRows, runRows, healthRows, repoScan] = await Promise.all([
      pool.query<InvRow>(`
        SELECT
          (SELECT COUNT(*)::text FROM places WHERE is_visible = true) AS places,
          (SELECT COUNT(*)::text FROM kamchatka_routes) AS routes,
          (SELECT COUNT(*)::text FROM operator_tours WHERE is_active = true) AS tours,
          (SELECT COUNT(*)::text FROM partners WHERE is_active = true) AS partners,
          COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::text AS bookings_week,
          COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days' AND booking_status = 'confirmed')::text AS confirmed_week
        FROM operator_bookings
      `),
      pool.query<RunRow>(`
        SELECT DISTINCT ON (agent_id) agent_id, status, started_at::text, items_processed, error_msg
        FROM agent_run_history
        ORDER BY agent_id, started_at DESC
      `),
      pool.query<HealthRow>(`
        SELECT
          (SELECT COUNT(*)::text FROM agent_memory) AS memory_total,
          (SELECT COUNT(*)::text FROM agent_run_history WHERE started_at > NOW() - INTERVAL '24h') AS runs_24h,
          (SELECT COUNT(*)::text FROM agent_run_history WHERE status = 'error' AND started_at > NOW() - INTERVAL '24h') AS errors_24h
      `),
      runRepoScan(gitLog).catch(() => null),
    ]);

    const inv = invRows.rows[0];
    const health = healthRows.rows[0];

    const platformSummary = inv
      ? `Мест: ${inv.places} | маршрутов: ${inv.routes} | активных туров: ${inv.tours} | партнёров: ${inv.partners}\nБронирований за 7д: ${inv.bookings_week} (${inv.confirmed_week} подтверждено)\nПамять: ${health?.memory_total ?? '?'} записей | Запусков 24ч: ${health?.runs_24h ?? '?'} (ошибок: ${health?.errors_24h ?? '?'})`
      : '';

    const agentStatuses = runRows.rows
      .map(r =>
        `${r.agent_id}: ${r.status} (${r.started_at?.slice(0, 16)})${r.error_msg ? ' ERR: ' + r.error_msg.slice(0, 60) : ''}`
      )
      .join('\n');

    const sections = [
      `Дата: ${new Date().toISOString().slice(0, 10)}`,
      '',
      '=== ПЛАТФОРМА ===',
      platformSummary,
      '',
      '=== СТАТУСЫ АГЕНТОВ ===',
      agentStatuses,
    ];
    if (gitLog) {
      sections.push('', '=== ПОСЛЕДНИЕ КОММИТЫ ===', gitLog.slice(0, 1500));
    }
    const today = new Date().toISOString().slice(0, 10);
    if (repoScan && repoScan.tablesScanned > 0) {
      sections.push(
        '',
        '=== REPO STATE ===',
        `Production: ${repoScan.healthSummary.split('\n')[0]}`,
        `DB: ${repoScan.tablesScanned} таблиц`,
        `Repo: ${repoScan.filesFound} файлов | API routes: см. repo-scan/${today}`,
      );
    } else {
      sections.push(
        '',
        '=== REPO STATE ===',
        repoScan
          ? `[ЧАСТИЧНЫЙ ОТКАЗ зондов: ${repoScan.dbSummary}]`
          : '[REPO SCAN: ЗОНДЫ НЕДОСТУПНЫ — данные за сегодня не получены]',
      );
    }

    await knowledgeBase.upsert({
      slug: 'daily-briefing',
      type: 'briefing',
      title: `Ежедневный брифинг ${new Date().toISOString().slice(0, 10)}`,
      compiled_truth: sections.join('\n'),
      metadata: { generated_at: new Date().toISOString() },
      agent_id: 'system',
    });
  } catch (err) {
    console.error('[warmup] writeDailyBriefing failed:', err);
  }
}

/**
 * Called by each cron agent at startup.
 * Returns structured briefing: platform state + this agent's own run history.
 */
export async function readAgentBriefing(agentId: string): Promise<AgentBriefing> {
  const today = new Date().toISOString().slice(0, 10);
  const [briefingPage, ownRunRows, decisionPages, repoScanPage] = await Promise.all([
    knowledgeBase.get('daily-briefing').catch(() => null),
    pool.query<OwnRunRow>(`
      SELECT status, started_at::text, items_processed, items_created, error_msg
      FROM agent_run_history
      WHERE agent_id = $1
      ORDER BY started_at DESC
      LIMIT 5
    `, [agentId]).catch(() => ({ rows: [] as OwnRunRow[] })),
    knowledgeBase.list({ type: 'decision', limit: 3 }).catch(() => []),
    knowledgeBase.get(`repo-scan/${today}`).catch(() => null),
  ]);

  const ownHistory = ownRunRows.rows.length
    ? ownRunRows.rows.map(r =>
        `${r.started_at?.slice(0, 16)} — ${r.status}` +
        (r.items_processed != null ? ` (обработано: ${r.items_processed})` : '') +
        (r.items_created != null ? ` (создано: ${r.items_created})` : '') +
        (r.error_msg ? ` ERR: ${r.error_msg.slice(0, 80)}` : '')
      ).join('\n')
    : 'Нет истории запусков';

  const recentDecisions = decisionPages.length
    ? decisionPages.map(p => `[${p.slug}] ${p.compiled_truth?.slice(0, 200)}`).join('\n\n---\n\n')
    : '';

  const repoStateSnippet = repoScanPage
    ? repoScanPage.compiled_truth.slice(0, 2000)
    : `[REPO SCAN: не запускался сегодня (${today}) — данные отсутствуют, проверь /api/cron/repo-scan]`;

  const platformSummary = [
    briefingPage?.compiled_truth ?? '',
    repoStateSnippet ? '\n\n=== REPO STATE (сегодня) ===\n' + repoStateSnippet : '',
    '\n\n' + TOURISM_DOMAIN,
  ].join('').trim();

  return {
    platformSummary,
    recentRuns: ownHistory,
    systemRuns: '',  // already embedded in platformSummary
    recentDecisions,
  };
}
