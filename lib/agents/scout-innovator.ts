/**
 * lib/agents/scout-innovator.ts
 *
 * Scout-Innovator — ежедневный синтез разведданных → конкретные предложения.
 * Двухфазный синтез: Phase 1 — JSON структура (Opus), Phase 2 — форматирование Telegram.
 * Каждое предложение автоматически превращается в GitHub Issue с планом.
 *
 * Запускается через /api/cron/scout (08:00 UTC, после Scout Digest в 07:00).
 */

import { readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { callAIWithModel, callAIFast } from '@/lib/ai/providers';
import { knowledgeBase } from '@/lib/agents/memory/agent-knowledge';
import { pool } from '@/lib/db-pool';
import { writeDailyBriefing, readAgentBriefing } from '@/lib/agents/warmup';
import { jaccardSimilarity } from '@/lib/utils/text-similarity';
import { parseProposalArray } from '@/lib/agents/agent-diagnostics';
import { agentMemory } from '@/lib/agents/memory/agent-memory';
import type { ChatMessage } from '@/lib/ai/prompts';

interface StructuredProposal {
  title: string;
  why: string;
  files_to_change: string[];
  implementation_steps: string[];
  acceptance_criteria: string[];
  complexity: 'small' | 'medium' | 'large';
  category: 'feature' | 'fix' | 'performance' | 'content' | 'ux';
}

export interface ScoutInnovatorResult {
  proposals_count: number;
  skipped_duplicates: number;
  skipped_by_critic?: number;
  sent_to_tg: boolean;
  intel_entries: number;
  duration_ms: number;
  issues_created: string[];
  /** Почему issues не создались (для диагностики молчания): no_intel / ai_call_failed /
   *  ai_empty / parse_error / ai_empty_array / all_duplicates / all_critic_rejected /
   *  issue_creation_failed / ok. Видно прямо в HTTP-ответе крон-эндпоинта. */
  reason?: string;
}

async function readCodebaseRules(): Promise<string> {
  try {
    const raw = await readFile(join(process.cwd(), 'CLAUDE.md'), 'utf-8');
    // Extract sections 4, 4.1, 7 — code rules, schema, protected files
    const markers = ['## 4. КОД', '## 4.1 СТРУКТУРА ДАННЫХ', '## 7. НЕ ТРОГАТЬ'];
    const sections: string[] = [];
    for (const marker of markers) {
      const start = raw.indexOf(marker);
      if (start < 0) continue;
      const nextH2 = raw.indexOf('\n## ', start + marker.length);
      sections.push(raw.slice(start, nextH2 > 0 ? nextH2 : start + 2000));
    }
    return sections.join('\n\n---\n\n').slice(0, 5000);
  } catch {
    return '';
  }
}

async function scanApiRoutes(): Promise<string> {
  try {
    const apiDir = join(process.cwd(), 'app', 'api');
    const routes: string[] = [];

    async function walk(dir: string, prefix = '/api'): Promise<void> {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory()) {
          await walk(join(dir, e.name), `${prefix}/${e.name}`);
        } else if (e.name === 'route.ts') {
          routes.push(prefix);
        }
      }
    }

    await walk(apiDir);
    return routes.sort().join('\n');
  } catch {
    return '';
  }
}

async function scanLibFiles(): Promise<string> {
  try {
    const libDir = join(process.cwd(), 'lib');
    const lines: string[] = [];
    async function walk(dir: string): Promise<void> {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) { await walk(full); }
        else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) {
          lines.push(full.replace(process.cwd() + '/', ''));
        }
      }
    }
    await walk(libDir);
    return lines.sort().join('\n');
  } catch {
    return '';
  }
}

async function readGitHubIssues(state: 'open' | 'closed'): Promise<string> {
  const token = process.env.GITHUB_ISSUES_TOKEN;
  if (!token) return '';
  try {
    const res = await fetch(
      `https://api.github.com/repos/tourhabk-ui/pos/issues?state=${state}&labels=agent-proposal&per_page=15`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) return '';
    const issues = await res.json() as Array<{ title: string; created_at: string }>;
    if (!issues.length) return '';
    return issues.map(i => `- ${i.title}`).join('\n');
  } catch {
    return '';
  }
}

async function readPlatformInventory(): Promise<string> {
  try {
    const [inv, mig] = await Promise.all([
      pool.query<{ places: string; routes: string; tours: string; partners: string; guides: string }>(`
        SELECT
          (SELECT COUNT(*)::text FROM places WHERE is_visible = true) AS places,
          (SELECT COUNT(*)::text FROM kamchatka_routes) AS routes,
          (SELECT COUNT(*)::text FROM operator_tours WHERE is_active = true) AS tours,
          (SELECT COUNT(*)::text FROM partners WHERE is_active = true) AS partners,
          (SELECT COUNT(*)::text FROM partners WHERE role = 'guide') AS guides
      `),
      pool.query<{ name: string }>(`SELECT name FROM _migrations ORDER BY applied_at DESC LIMIT 1`),
    ]);
    const r = inv.rows[0];
    if (!r) return '';
    const lastMigName = mig.rows[0]?.name ?? '';
    const lastMigNum = parseInt(lastMigName.match(/^(\d+)/)?.[1] ?? '0', 10);
    const nextMig = lastMigNum > 0 ? `${lastMigNum + 1}` : '?';
    return `Мест: ${r.places} · маршрутов: ${r.routes} · активных туров: ${r.tours} · партнёров: ${r.partners} · гидов: ${r.guides}\nПоследняя миграция: ${lastMigName} → следующая: migrations/${nextMig}_*.sql`;
  } catch {
    return '';
  }
}

async function generateStructuredProposals(
  repoContext: string,
  intelContext: string,
  platformStats: { bookings_week: string; confirmed_week: string; new_operators: string },
  apiRoutesList: string,
  gitContext?: { git_log?: string; changed_files?: string },
): Promise<{ proposals: StructuredProposal[]; reason: string }> {
  const gitSection = gitContext?.git_log || gitContext?.changed_files
    ? [
        '',
        '=== ПОСЛЕДНИЕ ИЗМЕНЕНИЯ В РЕПОЗИТОРИИ ===',
        gitContext.git_log ? `Git log (последние 30):\n${gitContext.git_log}` : '',
        gitContext.changed_files ? `Изменённые файлы (последние 10 коммитов):\n${gitContext.changed_files}` : '',
      ].filter(Boolean).join('\n')
    : '';

  const apiRoutesSection = apiRoutesList
    ? `=== СУЩЕСТВУЮЩИЕ API РОУТЫ (проверяй перед предложением нового) ===\n${apiRoutesList}`
    : '';

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `Ты Scout-Innovator — технический аналитик платформы TourHab / Ведар (Volcano OS): туристическая платформа Камчатки на Next.js 15 (App Router, TS strict) + PostgreSQL (прямой SQL, без Prisma).

ГЛАВНАЯ ЦЕЛЬ ПЛАТФОРМЫ — безопасность туриста в дикой природе. Offline-first: карта, SOS, маршруты обязаны работать без интернета. Три раздельные сущности: ТОЧКА (places — географический факт) ≠ МАРШРУТ (kamchatka_routes — путь, инструкция, МЧС) ≠ ТУР (operator_tours — коммерция, цена, бронь). Не смешивай их в предложениях.

ЗАДАЧА: предложи 2-3 ТЕХНИЧЕСКИХ улучшения, которые реально двигают одну из метрик: (1) безопасность туриста, (2) полнота/качество данных о местах и маршрутах, (3) конверсия/удержание операторов и броней, (4) производительность или надёжность. Каждое предложение должно быть привязано к КОНКРЕТНОМУ триггеру из переданного контекста: цифра из инвентаря (напр. "0 маршрутов с geometry"), запись разведданных, пробел в списке API/lib, или статистика за 7 дней. Если триггера нет — не выдумывай предложение.

КРИТЕРИИ ХОРОШЕГО ПРЕДЛОЖЕНИЯ:
- Решает наблюдаемую проблему, а не "было бы неплохо". В поле why — назови триггер дословно (цифра/факт из контекста) + измеримый эффект.
- Реализуемо за 1-4 существующих или новых файла. Пути в files_to_change бери ТОЛЬКО из переданных списков API-роутов и lib/-файлов, либо помечай как новый файл по реальной структуре (app/api/.../route.ts, lib/services/*.ts, migrations/NNN_*.sql). Не выдумывай пути.
- acceptance_criteria — проверяемые утверждения (что покажет тест/запрос/экран), не "работает корректно".
- implementation_steps — конкретные действия по файлам, а не пересказ why.

ЗАПРЕЩЕНО (нарушение = предложение невалидно):
- Трогать защищённые: middleware.ts, lib/auth.ts, app/api/payments/, app/api/safety/sos, миграции 001-049.
- Устаревшие таблицы: вместо bookings → operator_bookings (колонка booking_status), вместо tours → operator_tours, вместо SELECT из kamchatka_routes → v_kamchatka_routes_api. НЕ писать INSERT в agent_route_knowledge (это VIEW), не трогать _agent_route_knowledge_legacy.
- Прямой импорт pool default (только import { pool }), прямые вызовы callDeepSeek/callMiMo/callOpenrouter (только через callAIWaterfall/callAIFast).
- Generic-идеи без привязки к Камчатке: абстрактные "дашборды аналитики", "тёмная тема", "рефакторинг ради рефакторинга", "улучшить сообщения об ошибках" — если за ними нет конкретного триггера.
- Дубли: тебе переданы мои прошлые запуски, открытые и закрытые agent-proposal Issues. Не предлагай ничего семантически близкого к ним. В рамках одной выдачи — 2-3 РАЗНЫХ предложения, не вариации одной идеи. Балансируй category, не делай всё "feature".

ФОРМАТ: title и why — на русском. complexity: small=1-2ч, medium=2-8ч, large=1-2д. category: feature|fix|performance|content|ux.
Ответь ТОЛЬКО валидным JSON-массивом без markdown-обёртки, без текста до или после:
[{"title":"...","why":"триггер: <дословный факт из контекста>. Эффект: <измеримо>","files_to_change":["app/api/...","lib/..."],"implementation_steps":["1. ..."],"acceptance_criteria":["..."],"complexity":"small","category":"feature"}]`,
    },
    {
      role: 'user',
      content: `Ниже контекст платформы. Используй секции по назначению:
- ПРАВИЛА КОДОВОЙ БАЗЫ / ИНВЕНТАРЬ / API-роуты / lib-файлы — это ТЕКУЩЕЕ состояние. files_to_change бери отсюда; пробелы здесь = источник предложений.
- МОИ ПРЕДЫДУЩИЕ ЗАПУСКИ / ОТКРЫТЫЕ ЗАДАЧИ / РЕАЛИЗОВАННЫЕ — это ТАБУ на дубли: ничего близкого к ним не предлагай.
- РАЗВЕДДАННЫЕ и СТАТИСТИКА — это ТРИГГЕРЫ: ищи тут проблемы. Нулевые или аномальные цифры (напр. 0 подтверждённых броней, 0 маршрутов с geometry) — сильный сигнал, разбери их.

${repoContext}

${apiRoutesSection}

=== РАЗВЕДДАННЫЕ ИЗ BRAIN ===
${intelContext}

=== СТАТИСТИКА ПЛАТФОРМЫ ЗА 7 ДНЕЙ ===
- Бронирований: ${platformStats.bookings_week} всего, ${platformStats.confirmed_week} подтверждено
- Новых операторов: ${platformStats.new_operators}
${gitSection}

Прежде чем писать JSON, мысленно выбери 2-3 САМЫХ ОСТРЫХ триггера выше (не общие идеи). Для каждого проверь: (а) нет ли уже такого в открытых/закрытых задачах и прошлых запусках, (б) что все пути в files_to_change есть в списках выше или это явно новый файл в существующей структуре, (в) что why ссылается на дословный факт из контекста. Если острых триггеров меньше трёх — верни меньше предложений, не добивай водой. Если в контексте недостаточно данных для предложения — верни пустой массив [].

Ответь ТОЛЬКО JSON-массивом, без markdown и без текста вокруг.`,
    },
  ];

  try {
    const { text: raw } = await callAIWithModel(messages, 'anthropic/claude-opus-4-8', {
      maxTokens: 1500,
      timeoutMs: 45_000,
      temperature: 0.4,
    });
    const { proposals, reason } = parseProposalArray(raw);
    if (reason !== 'ok') {
      console.error(`[scout-innovator] Phase 1 вернул пусто: ${reason} (raw ${raw?.length ?? 0} симв.)`);
    }
    return { proposals: proposals as StructuredProposal[], reason };
  } catch (err) {
    console.error('[scout-innovator] Phase 1 AI call failed:', err);
    return { proposals: [], reason: 'ai_call_failed' };
  }
}

function formatTelegramMessage(
  proposals: StructuredProposal[],
  dateKey: string,
  platformStats: { bookings_week: string; confirmed_week: string; new_operators: string },
): string {
  const lines: string[] = [
    `<b>Scout-Innovator ${dateKey}</b>`,
    '',
    '<b>Предложения:</b>',
  ];

  proposals.forEach((p, i) => {
    lines.push(`${i + 1}. <b>${p.title}</b> [${p.complexity}]`);
    lines.push(`   ${p.why}`);
    if (p.files_to_change.length > 0) {
      lines.push(`   Файлы: ${p.files_to_change.slice(0, 3).join(', ')}`);
    }
    lines.push('');
  });

  lines.push(`<b>Платформа за 7 дней:</b> ${platformStats.bookings_week} бронирований, ${platformStats.confirmed_week} подтверждено, ${platformStats.new_operators} новых операторов`);

  return lines.join('\n');
}

interface CriticVerdict { approved: boolean; reason: string }

/**
 * Critic-gate (Roitman §24.6.2 reflection / §24.8.5 против amplification):
 * дешёвая вторая пара глаз ПЕРЕД созданием Issue. Отсеивает предложения,
 * нарушающие жёсткие правила CLAUDE.md или уже реализованные.
 * Fail-open: при любом сбое AI/парсинга → approved (поток не блокируется,
 * гейт никогда не обнуляет выдачу — только убирает явно плохое).
 */
export async function criticReviewProposal(
  p: StructuredProposal,
  codebaseRules: string,
  closedIssues: string,
  libFilesList: string,
): Promise<CriticVerdict> {
  const prompt = `Ты — строгий ревьюер предложений для платформы. Реши, можно ли создавать задачу.

ПРЕДЛОЖЕНИЕ:
Заголовок: ${p.title}
Зачем: ${p.why}
Файлы: ${(p.files_to_change ?? []).join(', ')}
Шаги: ${(p.implementation_steps ?? []).join('; ')}

ОТКЛОНИ (approved=false), если предложение:
- трогает защищённые области ради рефактора (middleware.ts, lib/auth.ts, app/api/payments/, app/api/safety/sos);
- использует устаревшее (таблицы bookings/tours вместо operator_*, прямая запись в agent_route_knowledge вместо places/kamchatka_routes, импорт pool по умолчанию, прямые вызовы провайдеров вместо waterfall);
- меняет схему БД без миграции;
- по сути УЖЕ реализовано (см. закрытые issues / существующие файлы lib ниже);
- расплывчато и не имеет проверяемого критерия приёмки.
Иначе approved=true.

=== ПРАВИЛА (CLAUDE.md, выдержка) ===
${codebaseRules.slice(0, 2500)}

=== УЖЕ РЕАЛИЗОВАНО (закрытые issues) ===
${closedIssues.slice(0, 1500)}

=== СУЩЕСТВУЮЩИЕ ФАЙЛЫ lib/ ===
${libFilesList.slice(0, 1500)}

Верни ТОЛЬКО JSON: {"approved": true|false, "reason": "<кратко почему>"}`;

  try {
    const raw = await callAIFast([{ role: 'user' as const, content: prompt }]);
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return { approved: true, reason: 'critic: нет JSON, fail-open' };
    const parsed = JSON.parse(m[0]) as { approved?: unknown; reason?: unknown };
    return {
      approved: parsed.approved !== false, // отклоняет только явное false
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
    };
  } catch {
    return { approved: true, reason: 'critic: ошибка, fail-open' };
  }
}

// ── Task-locking: кросс-прогонный дедуп предложений (Roitman §24.8.2) ─────────

const LOCK_TYPE = 'proposal_lock';
const LOCK_KEY = 'recent';
const LOCK_CAP = 60;
const LOCK_TTL_DAYS = 21;

/** Похоже ли название на одно из existing (Jaccard ≥ threshold). Чистая функция. */
export function isDuplicateTitle(title: string, existing: string[], threshold = 0.5): boolean {
  return existing.some(t => jaccardSimilarity(title, t) >= threshold);
}

/** Персистентный набор недавно созданных предложений (живёт между прогонами). */
async function loadProposalLocks(): Promise<string[]> {
  try {
    const e = await agentMemory.get('scout-innovator', LOCK_TYPE, LOCK_KEY);
    const titles = (e?.value as { titles?: unknown })?.titles;
    return Array.isArray(titles) ? titles.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

async function saveProposalLocks(titles: string[]): Promise<void> {
  try {
    await agentMemory.remember({
      agent_id: 'scout-innovator',
      memory_type: LOCK_TYPE,
      key: LOCK_KEY,
      value: { titles: titles.slice(-LOCK_CAP) },
      source: 'scout-innovator',
      expires_at: new Date(Date.now() + LOCK_TTL_DAYS * 24 * 60 * 60 * 1000),
    });
  } catch {
    /* не критично — лок лишь снижает повторы */
  }
}

async function createGitHubIssue(p: StructuredProposal, dateKey: string): Promise<string | null> {
  const token = process.env.GITHUB_ISSUES_TOKEN;
  const repo = 'tourhabk-ui/pos';
  if (!token) return null;

  const body = [
    `## Зачем (Scout-Innovator ${dateKey})`,
    p.why,
    '',
    '## Файлы для изменения',
    p.files_to_change.map(f => `- \`${f}\``).join('\n'),
    '',
    '## Шаги реализации',
    p.implementation_steps.map((s, i) => `${i + 1}. ${s}`).join('\n'),
    '',
    '## Критерии приёмки',
    p.acceptance_criteria.map(c => `- [ ] ${c}`).join('\n'),
    '',
    '---',
    `*Scout-Innovator ${dateKey} · Сложность: ${p.complexity} · Категория: ${p.category}*`,
    '',
    '---',
    '',
    `@claude Реализуй это предложение. Ограничься файлами: ${p.files_to_change.join(', ')} (если нужен ещё файл — обоснуй в PR, не трогай защищённые: middleware.ts, lib/auth.ts, app/api/payments/, app/api/safety/sos).
Definition of done — все критерии приёмки из этой задачи выполнены и проверяемы.
Обязательно по CLAUDE.md: TypeScript strict (unknown + type guards, без any), все цвета — CSS vars, SQL только параметризованный ($1,$2) и import { pool } from '@/lib/db-pool', таблицы operator_bookings (booking_status) / operator_tours / v_kamchatka_routes_api (не устаревшие bookings и tours, не прямой выбор из kamchatka_routes), Zod-валидация входных данных API и JWT на защищённых роутах, AI только через callAIWaterfall/callAIFast, без отладочного console-вывода в продакшн-коде, без эмодзи в коде/UI/логах, новая миграция — следующий свободный номер, идемпотентная.
Перед завершением: npx tsc --noEmit (0 ошибок) и npx vitest run (зелёные). Оформи изменения как PR, не пушь напрямую в main.`,
  ].join('\n');

  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        title: p.title,
        body,
        labels: ['agent-proposal', p.category],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json() as { html_url?: string };
    return data.html_url ?? null;
  } catch {
    return null;
  }
}

async function tgSend(text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;
  try {
    const res = await fetch(`${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.substring(0, 4000),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    const data = await res.json() as { ok: boolean };
    return data.ok === true;
  } catch {
    return false;
  }
}

export async function runScoutInnovator(
  gitContext?: { git_log?: string; changed_files?: string },
): Promise<ScoutInnovatorResult> {
  const start = Date.now();
  const dateKey = new Date().toISOString().slice(0, 10);

  // 0. Warm-up: write today's platform briefing FIRST so other agents can read it,
  //    then read own run history so Opus knows what Scout-Innovator has done before.
  await writeDailyBriefing(gitContext?.git_log);
  const selfBriefing = await readAgentBriefing('scout-innovator');

  // 1. Читаем всё параллельно: разведка, статистика, контекст репо
  const [
    intelPages,
    scoutPages,
    codebaseRules,
    openIssues,
    closedIssues,
    inventoryStr,
    apiRoutesList,
    libFilesList,
  ] = await Promise.all([
    knowledgeBase.list({ type: 'intel', limit: 5 }),
    knowledgeBase.search('scout digest дайджест', { limit: 3 }),
    readCodebaseRules(),
    readGitHubIssues('open'),
    readGitHubIssues('closed'),
    readPlatformInventory(),
    scanApiRoutes(),
    scanLibFiles(),
  ]);

  const allPages = [...intelPages, ...scoutPages].slice(0, 6);

  // 2. Платформа за 7 дней
  let platformStats = { bookings_week: '0', confirmed_week: '0', new_operators: '0' };
  try {
    const { rows } = await pool.query<{
      bookings_week: string;
      confirmed_week: string;
      new_operators: string;
    }>(`
      SELECT
        COUNT(*) FILTER (WHERE created_at > NOW() - '7 days'::interval)::text AS bookings_week,
        COUNT(*) FILTER (WHERE created_at > NOW() - '7 days'::interval AND booking_status = 'confirmed')::text AS confirmed_week,
        (SELECT COUNT(*)::text FROM partners WHERE created_at > NOW() - '7 days'::interval) AS new_operators
      FROM operator_bookings
    `);
    if (rows[0]) platformStats = rows[0];
  } catch (err) {
    console.error('[scout-innovator] Failed to read platform stats:', err);
  }

  if (allPages.length === 0) {
    console.error('[scout-innovator] No intel data in Brain — skipping');
    return {
      proposals_count: 0,
      skipped_duplicates: 0,
      sent_to_tg: false,
      intel_entries: 0,
      duration_ms: Date.now() - start,
      issues_created: [],
      reason: 'no_intel',
    };
  }

  // 3. Строим контекст
  const intelContext = allPages
    .map(p => `[${p.slug}]\n${(p.compiled_truth ?? '').slice(0, 300)}`)
    .join('\n\n---\n\n');

  const repoContext = [
    codebaseRules ? `=== ПРАВИЛА КОДОВОЙ БАЗЫ (CLAUDE.md) ===\n${codebaseRules}` : '',
    inventoryStr ? `=== ИНВЕНТАРЬ ПЛАТФОРМЫ ===\n${inventoryStr}` : '',
    libFilesList ? `=== СУЩЕСТВУЮЩИЕ ФАЙЛЫ В lib/ (проверяй перед предложением новой утилиты) ===\n${libFilesList.slice(0, 3000)}\nПравило: если предлагаешь новую утилиту — сначала проверь список выше. Если похожий файл уже есть — предлагай РАСШИРИТЬ его, не создавать новый.` : '',
    selfBriefing.recentRuns ? `=== МОИ ПРЕДЫДУЩИЕ ЗАПУСКИ (не повторять уже созданные предложения) ===\n${selfBriefing.recentRuns}` : '',
    openIssues ? `=== УЖЕ ОТКРЫТЫЕ ЗАДАЧИ (agent-proposal issues, не дублировать) ===\n${openIssues}` : '',
    closedIssues ? `=== УЖЕ РЕАЛИЗОВАННЫЕ ПРЕДЛОЖЕНИЯ (закрытые issues) ===\n${closedIssues}` : '',
  ].filter(Boolean).join('\n\n');

  // 4. Phase 1 — генерируем структурированные предложения (JSON)
  const { proposals: rawProposals, reason: phase1Reason } = await generateStructuredProposals(
    repoContext,
    intelContext,
    platformStats,
    apiRoutesList,
    gitContext,
  );

  if (rawProposals.length === 0) {
    return {
      proposals_count: 0,
      skipped_duplicates: 0,
      sent_to_tg: false,
      intel_entries: allPages.length,
      duration_ms: Date.now() - start,
      issues_created: [],
      // phase1Reason различает: ai_call_failed / ai_empty / parse_error /
      // not_array / ai_empty_array — почему модель не дала предложений.
      reason: phase1Reason,
    };
  }

  // Code-level dedup: filter proposals similar to existing open GitHub Issues.
  // Prompt says "don't repeat" but LLM isn't reliable — code decides.
  const openTitles = openIssues
    .split('\n')
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim())
    .filter(Boolean);

  // Task-locking (§24.8.2): дедуп не только против открытых issues, но и против
  // персистентного набора недавно созданных предложений — чтобы то же самое не
  // предлагалось заново после закрытия issue. Детерминированный backstop к critic-gate.
  const locks = await loadProposalLocks();
  const blockTitles = [...openTitles, ...locks];
  const deduped = rawProposals.filter((p) => !isDuplicateTitle(p.title, blockTitles));
  const skipped_duplicates = rawProposals.length - deduped.length;

  // Critic-gate: вторая пара глаз перед созданием Issue (fail-open, параллельно)
  const verdicts = await Promise.all(
    deduped.map((p) => criticReviewProposal(p, codebaseRules, closedIssues, libFilesList)),
  );
  const proposals = deduped.filter((_, i) => verdicts[i].approved);
  const skipped_by_critic = deduped.length - proposals.length;
  verdicts.forEach((v, i) => {
    if (!v.approved) console.error(`[scout-innovator] critic отклонил: ${deduped[i].title} — ${v.reason}`);
  });

  if (proposals.length === 0) {
    return {
      proposals_count: 0,
      skipped_duplicates,
      skipped_by_critic,
      sent_to_tg: false,
      intel_entries: allPages.length,
      duration_ms: Date.now() - start,
      issues_created: [],
      // Предложения были, но всё отсеяно: дедупом или критиком.
      reason: skipped_by_critic > 0 && deduped.length > 0 ? 'all_critic_rejected' : 'all_duplicates',
    };
  }

  // 5. Phase 2 — форматируем для Telegram
  const tgMessage = formatTelegramMessage(proposals, dateKey, platformStats);

  // 6. Сохраняем в Brain
  try {
    await knowledgeBase.upsert({
      slug: `proposals/${dateKey}`,
      type: 'decision',
      title: `Scout-Innovator предложения ${dateKey}`,
      compiled_truth: tgMessage,
      metadata: {
        intel_entries: allPages.length,
        bookings_week: platformStats.bookings_week,
        generated_at: dateKey,
        proposals_count: proposals.length,
        skipped_duplicates,
        skipped_by_critic,
      },
      agent_id: 'scout-innovator',
    });
  } catch (err) {
    console.error('[scout-innovator] Failed to save to Brain:', err);
  }

  // 7. Telegram
  const sent = await tgSend(tgMessage);

  // 8. GitHub Issues — каждое предложение → задача для агента-кодера
  const issueUrls: string[] = [];
  const createdTitles: string[] = [];

  for (const p of proposals) {
    const url = await createGitHubIssue(p, dateKey);
    if (url) {
      issueUrls.push(url);
      createdTitles.push(p.title);
      await tgSend(`<b>Создана задача для кодера</b>\n${p.title}\n${url}`);
    }
  }

  // Обновляем лок: добавляем созданные предложения, чтобы не повторять их в будущих прогонах
  if (createdTitles.length > 0) {
    await saveProposalLocks([...locks, ...createdTitles]);
  }

  return {
    proposals_count: proposals.length,
    skipped_duplicates,
    skipped_by_critic,
    sent_to_tg: sent,
    intel_entries: allPages.length,
    duration_ms: Date.now() - start,
    issues_created: issueUrls,
    // Предложения были, но ни одно не превратилось в issue → сбой создания (GitHub API/токен).
    reason: issueUrls.length === 0 ? 'issue_creation_failed' : 'ok',
  };
}
