/**
 * lib/agents/scout-innovator.ts
 *
 * Scout-Innovator — ежедневный синтез разведданных → конкретные предложения.
 * Читает Brain (agent_knowledge), анализирует платформу, формирует 2-3 действия.
 * Каждое кодовое предложение автоматически превращается в GitHub Issue с планом.
 *
 * Запускается через /api/cron/scout (08:00 UTC, после Scout Digest в 07:00).
 */

import { callAIWithModel } from '@/lib/ai/providers';
import { knowledgeBase } from '@/lib/agents/memory/agent-knowledge';
import { pool } from '@/lib/db-pool';
import type { ChatMessage } from '@/lib/ai/prompts';

export interface ScoutInnovatorResult {
  proposals_count: number;
  sent_to_tg: boolean;
  intel_entries: number;
  duration_ms: number;
  issues_created: string[];
}

interface CodeProposal {
  title: string;
  context: string;
  implementation_plan: string[];
  acceptance_criteria: string[];
  complexity: 'small' | 'medium' | 'large';
}

async function extractCodeProposals(proposalsText: string): Promise<CodeProposal[]> {
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `Ты технический менеджер туристической платформы на Next.js.
Из текста предложений извлеки только те, что требуют написания кода: новая страница, новый API endpoint, новая фича, UI-компонент.
Игнорируй маркетинговые или операционные предложения (написать пост, позвонить оператору, etc.).

Верни ТОЛЬКО JSON-массив (без markdown):
[{
  "title": "Краткое название задачи до 70 символов",
  "context": "Почему это нужно — 1-2 предложения из разведки",
  "implementation_plan": ["Шаг 1", "Шаг 2", "Шаг 3"],
  "acceptance_criteria": ["Критерий 1", "Критерий 2"],
  "complexity": "small|medium|large"
}]

Если кодовых предложений нет — верни [].`,
    },
    {
      role: 'user',
      content: proposalsText,
    },
  ];

  try {
    const { text: raw } = await callAIWithModel(messages, 'anthropic/claude-opus-4-8', { maxTokens: 800, timeoutMs: 30_000 });
    const json = raw.trim().replace(/^```json\n?/, '').replace(/\n?```$/, '');
    return JSON.parse(json) as CodeProposal[];
  } catch {
    return [];
  }
}

async function createGitHubIssue(proposal: CodeProposal, dateKey: string): Promise<string | null> {
  const token = process.env.GITHUB_ISSUES_TOKEN;
  const repo = 'tourhabk-ui/pos';
  if (!token) return null;

  const body = [
    `## Контекст (Scout-Innovator ${dateKey})`,
    '',
    proposal.context,
    '',
    '## План реализации',
    '',
    proposal.implementation_plan.map((s, i) => `${i + 1}. ${s}`).join('\n'),
    '',
    '## Приёмочные критерии',
    '',
    proposal.acceptance_criteria.map(c => `- [ ] ${c}`).join('\n'),
    '',
    '---',
    `*Создано автоматически Scout-Innovator · Сложность: ${proposal.complexity}*`,
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
        title: proposal.title,
        body,
        labels: ['agent-proposal'],
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

export async function runScoutInnovator(): Promise<ScoutInnovatorResult> {
  const start = Date.now();
  const dateKey = new Date().toISOString().slice(0, 10);

  // 1. Читаем последние разведданные из Brain (intel + scout digests)
  const [intelPages, scoutPages] = await Promise.all([
    knowledgeBase.list({ type: 'intel', limit: 5 }),
    knowledgeBase.search('scout digest дайджест', { limit: 3 }),
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
    return { proposals_count: 0, sent_to_tg: false, intel_entries: 0, duration_ms: Date.now() - start, issues_created: [] };
  }

  // 3. AI синтез
  const intelContext = allPages
    .map(p => `[${p.slug}]\n${(p.compiled_truth ?? '').slice(0, 300)}`)
    .join('\n\n---\n\n');

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `Ты Scout-Innovator — стратегический аналитик туристической платформы TourHab (Камчатка).
На основе собранных разведданных формируй 2-3 конкретных, выполнимых предложения для владельца платформы.

Каждое предложение — это конкретное действие + ожидаемый результат (не теория).
Избегай общих фраз типа "улучшить качество" или "развивать платформу".

Формат ответа — HTML для Telegram:
<b>Scout-Innovator ${dateKey}</b>

<b>Предложения:</b>
1. [конкретное действие] — [ожидаемый результат]
2. [конкретное действие] — [ожидаемый результат]

<b>Платформа за 7 дней:</b>
- Бронирований: [N] всего, [M] подтверждено

Если нет конкретных идей — честно напиши "Нет новых сигналов для действий".
Пиши по-русски. Без воды.`,
    },
    {
      role: 'user',
      content: `Разведданные из Brain (последние записи):

${intelContext}

Платформа за 7 дней:
- Бронирований: ${platformStats.bookings_week} всего, ${platformStats.confirmed_week} подтверждено
- Новых операторов: ${platformStats.new_operators}

Дай 2-3 конкретных предложения.`,
    },
  ];

  let proposals: string;
  try {
    const result = await callAIWithModel(messages, 'anthropic/claude-opus-4-8', {
      maxTokens: 1500,
      timeoutMs: 45_000,
      temperature: 0.5,
    });
    proposals = result.text;
  } catch (err) {
    console.error('[scout-innovator] AI call failed:', err);
    return { proposals_count: 0, sent_to_tg: false, intel_entries: allPages.length, duration_ms: Date.now() - start, issues_created: [] };
  }

  if (!proposals.trim()) {
    return { proposals_count: 0, sent_to_tg: false, intel_entries: allPages.length, duration_ms: Date.now() - start, issues_created: [] };
  }

  // 4. Сохраняем в Brain
  try {
    await knowledgeBase.upsert({
      slug: `proposals/${dateKey}`,
      type: 'decision',
      title: `Scout-Innovator предложения ${dateKey}`,
      compiled_truth: proposals,
      metadata: {
        intel_entries: allPages.length,
        bookings_week: platformStats.bookings_week,
        generated_at: dateKey,
      },
      agent_id: 'scout-innovator',
    });
  } catch (err) {
    console.error('[scout-innovator] Failed to save to Brain:', err);
  }

  // 5. Telegram
  const sent = await tgSend(proposals);

  // 6. GitHub Issues — каждое кодовое предложение → задача для агента-кодера
  const codeProposals = await extractCodeProposals(proposals);
  const issueUrls: string[] = [];

  for (const p of codeProposals) {
    const url = await createGitHubIssue(p, dateKey);
    if (url) {
      issueUrls.push(url);
      // Уведомление в Telegram об открытом issue
      await tgSend(`<b>Создана задача для кодера</b>\n${p.title}\n${url}`);
    }
  }

  const proposalCount = (proposals.match(/^\d\./gm) ?? []).length || 1;

  return {
    proposals_count: proposalCount,
    sent_to_tg: sent,
    intel_entries: allPages.length,
    duration_ms: Date.now() - start,
    issues_created: issueUrls,
  };
}
