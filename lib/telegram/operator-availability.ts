/**
 * lib/telegram/operator-availability.ts
 *
 * Чтение Telegram-групп туроператоров через MTProto (gramjs).
 * Ищет объявления о свободных местах на туры за последние N часов.
 * Сохраняет сигналы в agent_memory для Кузьмича.
 *
 * Требует: TG_API_ID, TG_API_HASH, TG_USER_SESSION
 * Настройка: my.telegram.org → API development tools → scripts/tg-auth.ts
 */

import { getMTProtoClient, isMTProtoConfigured } from '@/lib/telegram/mtproto-client';
import { callAIFast } from '@/lib/ai/providers';
import { pool } from '@/lib/db-pool';
import type { ChatMessage } from '@/lib/ai/prompts';

// ── Уведомление владельцу ────────────────────────────────────────────────────

async function notifyOwner(text: string): Promise<void> {
  const token   = process.env.TELEGRAM_BOT_TOKEN;
  const ownerId = process.env.TELEGRAM_OWNER_ID ?? '171286547';
  if (!token) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id:    ownerId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  }).catch(() => {});
}

export interface AvailabilitySignal {
  tour_type: string;
  date?: string;
  price?: number;
  slots_available?: number;
  contact?: string;
  raw_text: string;
  confidence: number;
  message_date: Date;
  group_username: string;
}

export interface GroupScanResult {
  group: string;
  messages_read: number;
  signals_found: number;
  signals: AvailabilitySignal[];
  error?: string;
}

// ── AI-извлечение сигналов из пачки сообщений ────────────────────────────────

async function extractSignals(
  messages: Array<{ text: string; date: Date }>,
  groupUsername: string,
): Promise<AvailabilitySignal[]> {
  if (messages.length === 0) return [];

  const msgText = messages
    .slice(0, 50) // max 50 сообщений за раз
    .map(m => `[${m.date.toLocaleDateString('ru-RU')}] ${m.text}`)
    .join('\n---\n');

  const prompt: ChatMessage[] = [
    {
      role: 'system',
      content: `Ты анализируешь сообщения из Telegram-группы туроператора Камчатки.
Найди объявления о СВОБОДНЫХ МЕСТАХ на туры.

Верни JSON-массив объектов (пустой массив если ничего не найдено):
[
  {
    "tour_type": "Вилючинский",
    "date": "2026-08-04",
    "price": 5000,
    "slots_available": 3,
    "contact": "@username или телефон",
    "raw_text": "первые 100 символов исходного сообщения",
    "confidence": 0.9
  }
]

Правила:
- date в формате YYYY-MM-DD (null если не указана)
- price в рублях (null если не указана)
- slots_available (null если не указано)
- confidence от 0 до 1 (1 = явное объявление о местах)
- Игнорируй вопросы, жалобы, общение — только объявления операторов
- Включай только сигналы с confidence >= 0.6`,
    },
    {
      role: 'user',
      content: `Сообщения из ${groupUsername}:\n\n${msgText}`,
    },
  ];

  try {
    const raw = await callAIFast(prompt);
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]) as Array<{
      tour_type: string;
      date?: string | null;
      price?: number | null;
      slots_available?: number | null;
      contact?: string | null;
      raw_text: string;
      confidence: number;
    }>;

    return parsed
      .filter(s => s.confidence >= 0.6 && s.tour_type)
      .map(s => ({
        tour_type: s.tour_type,
        date: s.date ?? undefined,
        price: s.price ?? undefined,
        slots_available: s.slots_available ?? undefined,
        contact: s.contact ?? undefined,
        raw_text: s.raw_text ?? '',
        confidence: s.confidence,
        message_date: new Date(),
        group_username: groupUsername,
      }));
  } catch {
    return [];
  }
}

// ── Сохранение сигналов в agent_memory ───────────────────────────────────────

async function saveSignals(signals: AvailabilitySignal[], groupUsername: string): Promise<void> {
  if (signals.length === 0) return;

  const dateKey = new Date().toISOString().slice(0, 10);
  const key = `tg_avail_${groupUsername.replace(/[^a-z0-9]/gi, '_')}_${dateKey}`;

  await pool.query(
    `INSERT INTO agent_memory (agent_id, memory_type, key, value, confidence, source, expires_at)
     VALUES ('kuzmich', 'availability', $1, $2, 0.8, 'tg_group_scan', NOW() + INTERVAL '24 hours')
     ON CONFLICT (agent_id, key)
     DO UPDATE SET value = $2, confidence = 0.8, expires_at = NOW() + INTERVAL '24 hours', updated_at = NOW()`,
    [key, JSON.stringify({ group: groupUsername, signals, scanned_at: new Date().toISOString() })],
  );
}

// ── Чтение группы через MTProto ───────────────────────────────────────────────

export async function fetchGroupAvailability(
  groupUsername: string,
  hoursBack = 72,
): Promise<GroupScanResult> {
  const result: GroupScanResult = {
    group: groupUsername,
    messages_read: 0,
    signals_found: 0,
    signals: [],
  };

  if (!isMTProtoConfigured()) {
    result.error = 'MTProto не настроен: нужны TG_API_ID, TG_API_HASH, TG_USER_SESSION';
    return result;
  }

  try {
    const client = await getMTProtoClient();
    const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000);

    // Получаем сообщения через gramjs
    const entity = await client.getEntity(groupUsername);
    const messages: Array<{ text: string; date: Date }> = [];

    const iter = client.iterMessages(entity, { limit: 200 });
    for await (const msg of iter) {
      const msgDate = new Date((msg.date as number) * 1000);
      if (msgDate < since) break;
      const text = (msg.text as string | undefined)?.trim() ?? '';
      if (text.length > 20) {
        messages.push({ text: text.slice(0, 500), date: msgDate });
      }
    }

    result.messages_read = messages.length;

    if (messages.length > 0) {
      const signals = await extractSignals(messages, groupUsername);
      result.signals = signals;
      result.signals_found = signals.length;
      await saveSignals(signals, groupUsername);
    }
  } catch (e) {
    result.error = (e as Error).message;
  }

  return result;
}

// ── Сканирование всех групп операторов из БД ─────────────────────────────────

export async function scanAllOperatorGroups(hoursBack = 72): Promise<{
  groups_scanned: number;
  total_signals: number;
  errors: string[];
  results: GroupScanResult[];
}> {
  const { rows } = await pool.query<{ telegram_group_url: string; company_name: string }>(
    `SELECT telegram_group_url, company_name
     FROM partners
     WHERE telegram_group_url IS NOT NULL
       AND external_source = 'visitkamchatka'
     ORDER BY company_name`,
  );

  const summary = {
    groups_scanned: 0,
    total_signals: 0,
    errors: [] as string[],
    results: [] as GroupScanResult[],
  };

  for (const row of rows) {
    const username = row.telegram_group_url.replace('https://t.me/', '').replace('t.me/', '');
    const r = await fetchGroupAvailability(`@${username}`, hoursBack);
    summary.groups_scanned++;
    summary.total_signals += r.signals_found;
    summary.results.push(r);
    if (r.error) summary.errors.push(`${row.company_name}: ${r.error}`);
    // Пауза между запросами чтобы не получить rate-limit
    await new Promise(res => setTimeout(res, 1500));
  }

  // Уведомление владельцу если нашли что-то интересное
  if (summary.total_signals > 0) {
    const lines = summary.results
      .filter(r => r.signals_found > 0)
      .map(r => {
        const top = r.signals.slice(0, 3).map(s => {
          const parts = [`• <b>${s.tour_type}</b>`];
          if (s.date) parts.push(s.date);
          if (s.price) parts.push(`${s.price.toLocaleString('ru-RU')} ₽`);
          if (s.slots_available) parts.push(`${s.slots_available} мест`);
          if (s.contact) parts.push(`→ ${s.contact}`);
          return parts.join(' | ');
        });
        return `<b>${r.group}</b>\n${top.join('\n')}`;
      });

    await notifyOwner(
      `<b>Наличие мест у операторов</b>\n\n${lines.join('\n\n')}\n\n` +
      `Всего сигналов: ${summary.total_signals} в ${summary.groups_scanned} группах`,
    );
  }

  return summary;
}

// ── Поиск доступности для Кузьмича ───────────────────────────────────────────

export async function searchOperatorAvailability(query: string): Promise<string> {
  if (!query || query.length < 3) return '';

  try {
    // Читаем кешированные сигналы из agent_memory
    const { rows } = await pool.query<{ value: unknown; key: string }>(
      `SELECT key, value FROM agent_memory
       WHERE agent_id = 'kuzmich'
         AND memory_type = 'availability'
         AND key LIKE 'tg_avail_%'
         AND expires_at > NOW()
       ORDER BY updated_at DESC
       LIMIT 20`,
    );

    if (rows.length === 0) {
      // Fallback: ищем по tour_availability в БД
      const { rows: dbSlots } = await pool.query<{
        title: string;
        date: string;
        available_slots: number;
        company_name: string;
      }>(
        `SELECT ot.title, ta.date::text, ta.available_slots, p.company_name
         FROM tour_availability ta
         JOIN operator_tours ot ON ot.id = ta.operator_tour_id
         JOIN partners p ON p.id = ot.operator_id
         WHERE ta.date >= CURRENT_DATE
           AND ta.available_slots > 0
           AND ta.is_cancelled = false
         ORDER BY ta.date ASC
         LIMIT 10`,
      );

      if (dbSlots.length === 0) return '';

      const lines = dbSlots.map(r =>
        `${r.title} — ${r.date} — ${r.available_slots} мест (${r.company_name})`
      );
      return `=== Свободные места (из базы) ===\n${lines.join('\n')}`;
    }

    // Собираем все сигналы из кеша, фильтруем по запросу
    const queryLower = query.toLowerCase();
    const allSignals: AvailabilitySignal[] = [];

    for (const row of rows) {
      const data = row.value as { signals?: AvailabilitySignal[] };
      if (data?.signals) {
        const relevant = data.signals.filter(s =>
          queryLower.split(/\s+/).some(word =>
            word.length > 3 && s.tour_type.toLowerCase().includes(word)
          )
        );
        allSignals.push(...relevant);
      }
    }

    if (allSignals.length === 0) return '';

    const lines = allSignals.slice(0, 8).map(s => {
      const parts = [`${s.tour_type}`];
      if (s.date) parts.push(s.date);
      if (s.price) parts.push(`${s.price.toLocaleString('ru-RU')} ₽`);
      if (s.slots_available) parts.push(`${s.slots_available} мест`);
      if (s.contact) parts.push(`→ ${s.contact}`);
      return parts.join(' | ');
    });

    return `=== Наличие мест у операторов (из TG) ===\n${lines.join('\n')}`.slice(0, 1500);
  } catch {
    return '';
  }
}
