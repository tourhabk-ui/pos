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
import { callAIWithModel } from '@/lib/ai/providers';
import { knowledgeBase } from '@/lib/agents/memory/agent-knowledge';
import { pool } from '@/lib/db-pool';
import { writeDailyBriefing, readAgentBriefing } from '@/lib/agents/warmup';
import { jaccardSimilarity } from '@/lib/utils/text-similarity';
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
  sent_to_tg: boolean;
  intel_entries: number;
  duration_ms: number;
  issues_created: string[];
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
): Promise<StructuredProposal[]> {
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
      content: `Ты Scout-Innovator — технический аналитик платформы Ведар (Камчатка, Next.js 15 + PostgreSQL).
Сформируй 2-3 конкретных технических предложения в JSON-массиве.

Правила:
- Предлагай только то чего ещё НЕТ (проверь инвентарь и открытые Issues)
- НЕ трогай защищённые файлы: middleware.ts, lib/auth.ts, app/api/payments/, app/api/safety/sos
- Каждое предложение должно реализоваться за 1-4 файла максимум
- files_to_change — конкретные пути (проверь по списку существующих API роутов)
- Сложность small = 1-2ч, medium = 2-8ч, large = 1-2д
- Не предлагай дубли открытых или закрытых Issues
- Не используй устаревшие таблицы (bookings → operator_bookings, tours → operator_tours)

Ответь ТОЛЬКО JSON-массивом без markdown-обёртки:
[{"title":"...","why":"...","files_to_change":["app/api/...", "lib/..."],"implementation_steps":["1. ..."],"acceptance_criteria":["..."],"complexity":"small","category":"feature"}]`,
    },
    {
      role: 'user',
      content: `${repoContext}

${apiRoutesSection}

=== РАЗВЕДДАННЫЕ ИЗ BRAIN ===
${intelContext}

=== СТАТИСТИКА ПЛАТФОРМЫ ЗА 7 ДНЕЙ ===
- Бронирований: ${platformStats.bookings_week} всего, ${platformStats.confirmed_week} подтверждено
- Новых операторов: ${platformStats.new_operators}
${gitSection}

Сформируй 2-3 конкретных технических предложения.`,
    },
  ];

  try {
    const { text: raw } = await callAIWithModel(messages, 'anthropic/claude-opus-4-8', {
      maxTokens: 1500,
      timeoutMs: 45_000,
      temperature: 0.4,
    });
    const json = raw.trim().replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as StructuredProposal[];
  } catch (err) {
    console.error('[scout-innovator] Phase 1 AI call failed:', err);
    return [];
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
    `@claude Реализуй это предложение. Файлы которые надо изменить: ${p.files_to_change.join(', ')}. Следуй CLAUDE.md: TypeScript strict, CSS vars, параметризованный SQL, без эмодзи в коде.`,
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
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
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
  const rawProposals = await generateStructuredProposals(
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
    };
  }

  // Code-level dedup: filter proposals similar to existing open GitHub Issues.
  // Prompt says "don't repeat" but LLM isn't reliable — code decides.
  const openTitles = openIssues
    .split('\n')
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim())
    .filter(Boolean);

  const proposals = rawProposals.filter(
    (p) => !openTitles.some((t) => jaccardSimilarity(p.title, t) >= 0.5),
  );
  const skipped_duplicates = rawProposals.length - proposals.length;

  if (proposals.length === 0) {
    return {
      proposals_count: 0,
      skipped_duplicates,
      sent_to_tg: false,
      intel_entries: allPages.length,
      duration_ms: Date.now() - start,
      issues_created: [],
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

  for (const p of proposals) {
    const url = await createGitHubIssue(p, dateKey);
    if (url) {
      issueUrls.push(url);
      await tgSend(`<b>Создана задача для кодера</b>\n${p.title}\n${url}`);
    }
  }

  return {
    proposals_count: proposals.length,
    skipped_duplicates,
    sent_to_tg: sent,
    intel_entries: allPages.length,
    duration_ms: Date.now() - start,
    issues_created: issueUrls,
  };
}
