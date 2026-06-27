/**
 * lib/telegram/group-monitor.ts
 *
 * Мониторинг туристических Telegram-групп:
 * — Тихо собирает сообщения (бот молчит, если не @упомянут)
 * — Батчевый AI-анализ: маршруты, цены, условия, советы, конкуренты
 * — Сохраняет в agent_memory (evo, intelligence) → автоматически читается Советом директоров
 * — Ключевые советы по маршрутам → agent_route_knowledge (база знаний)
 * — Реестр групп → agent_memory ключ 'tg_monitored_groups'
 *
 * Trigger: каждые 20 сообщений ИЛИ каждые 15 мин (whichever first)
 */

import { pool } from '@/lib/db-pool';
import { agentMemory } from '@/lib/agents/memory/agent-memory';
import { callAIFast } from '@/lib/ai/providers';
import type { ChatMessage } from '@/lib/ai/prompts';

// ── Типы ──────────────────────────────────────────────────────────────────────

interface GroupMessage {
  from: string;
  text: string;
  ts: string; // ISO
}

interface GroupBuffer {
  title: string;
  messages: GroupMessage[];
  lastAnalyzedAt: number;
  totalAnalyzed: number;
}

interface GroupIntel {
  routes_mentioned: string[];
  prices: Array<{ service: string; price: number | null; currency?: string; context: string }>;
  conditions: string[];          // погода, дороги, перевалы
  traveler_tips: string[];
  competitor_mentions: string[];
  demand_signals: string[];      // «ищу тур», «кто везёт», «сколько стоит»
  availability_signals: string[]; // оператор объявляет свободные места: маршрут + дата + кол-во
  sentiment: 'positive' | 'neutral' | 'negative';
  hot_signals: string[];         // срочное / важное для безопасности и бизнеса
  key_insights: string[];
}

interface MonitoredGroup {
  id: string;
  title: string;
  joinedAt: string;
  totalMessages: number;
  lastActivityAt: string;
}

// ── Константы ─────────────────────────────────────────────────────────────────

const BATCH_SIZE      = 20;    // сообщений до анализа
const BATCH_INTERVAL  = 15 * 60 * 1000; // 15 минут

// ── Сервис ────────────────────────────────────────────────────────────────────

class GroupMonitorService {
  /** Буферы сообщений по group chat ID */
  private buffers = new Map<string, GroupBuffer>();

  constructor() {
    // Периодически флашим старые буферы (>15 мин без активности)
    setInterval(() => this.flushStale(), 5 * 60 * 1000);
  }

  // ── Публичный API ────────────────────────────────────────────────────────────

  /**
   * Вызывается из webhook для каждого входящего сообщения в группе.
   * Не блокирует: анализ запускается асинхронно.
   */
  processMessage(chatId: string, chatTitle: string, fromName: string, text: string): void {
    if (!text || text.trim().length < 3) return;
    // Фильтр: пропускаем служебные, очень короткие, пересланные команды
    if (text.startsWith('/') || text.length < 10) return;

    let buf = this.buffers.get(chatId);
    if (!buf) {
      buf = { title: chatTitle, messages: [], lastAnalyzedAt: 0, totalAnalyzed: 0 };
      this.buffers.set(chatId, buf);
      // Регистрируем новую группу
      void this.registerGroup(chatId, chatTitle);
    }

    buf.messages.push({ from: fromName, text: text.slice(0, 400), ts: new Date().toISOString() });
    // Ограничиваем размер буфера в памяти
    if (buf.messages.length > 100) buf.messages = buf.messages.slice(-100);

    const shouldFlush =
      buf.messages.length >= BATCH_SIZE ||
      (buf.messages.length >= 5 && Date.now() - buf.lastAnalyzedAt > BATCH_INTERVAL);

    if (shouldFlush) {
      const batch = buf.messages.splice(0); // забираем все
      buf.lastAnalyzedAt = Date.now();
      buf.totalAnalyzed += batch.length;
      void this.analyzeAndStore(chatId, buf.title, batch, buf.totalAnalyzed);
    }
  }

  /**
   * Возвращает реестр мониторируемых групп из agent_memory.
   */
  async getMonitoredGroups(): Promise<MonitoredGroup[]> {
    try {
      const { rows } = await pool.query<{ value: unknown }>(
        `SELECT value FROM agent_memory WHERE agent_id = 'evo' AND key = 'tg_monitored_groups' LIMIT 1`
      );
      const val = rows[0]?.value as { groups?: MonitoredGroup[] } | undefined;
      return val?.groups ?? [];
    } catch { return []; }
  }

  /**
   * Возвращает последние intel-записи из групп (для дашборда / совета директоров).
   */
  async getRecentIntel(limit = 20): Promise<Array<{ group: string; date: string; intel: GroupIntel; messages: number }>> {
    try {
      const { rows } = await pool.query<{ key: string; value: unknown; created_at: string }>(
        `SELECT key, value, created_at FROM agent_memory
         WHERE agent_id = 'evo' AND memory_type = 'intelligence' AND key LIKE 'tg_group_intel_%'
         ORDER BY created_at DESC LIMIT $1`,
        [limit]
      );
      return rows.map(r => {
        const v = r.value as {
          group_title?: string; messages_analyzed?: number; intel?: GroupIntel
        };
        return {
          group:    v.group_title ?? r.key,
          date:     r.created_at,
          intel:    (v.intel ?? {}) as GroupIntel,
          messages: v.messages_analyzed ?? 0,
        };
      });
    } catch { return []; }
  }

  // ── Внутренние методы ────────────────────────────────────────────────────────

  private async analyzeAndStore(
    chatId: string,
    chatTitle: string,
    messages: GroupMessage[],
    totalSoFar: number,
  ): Promise<void> {
    try {
      const intel = await this.extractIntel(messages);
      if (!intel) return;

      const dateKey  = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH
      const memKey   = `tg_group_intel_${chatId}_${dateKey}`;

      // 1. Сохраняем в agent_memory → автоматически попадает в разведку Совета директоров
      await agentMemory.remember({
        agent_id:    'evo',
        memory_type: 'intelligence',
        key:         memKey,
        value: {
          source:            'telegram_group_monitor',
          group_id:          chatId,
          group_title:       chatTitle,
          messages_analyzed: messages.length,
          total_analyzed:    totalSoFar,
          intel,
          sample_messages:   messages.slice(0, 3).map(m => ({ from: m.from, text: m.text.slice(0, 120) })),
          analyzed_at:       new Date().toISOString(),
        },
        confidence: 0.85,
        source:     'telegram_group',
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      });

      // 2. Горячие сигналы → немедленно в отдельную запись с высоким приоритетом
      if (intel.hot_signals.length > 0) {
        await agentMemory.remember({
          agent_id:    'evo',
          memory_type: 'intelligence',
          key:         `tg_hot_signal_${chatId}_${Date.now()}`,
          value: {
            source:      'telegram_group_hot',
            group_title: chatTitle,
            signals:     intel.hot_signals,
            context:     messages.slice(-5).map(m => `${m.from}: ${m.text}`).join('\n'),
            timestamp:   new Date().toISOString(),
          },
          confidence: 0.95,
          source:     'telegram_group',
          expires_at: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
        });
      }

      // 3. Советы по маршрутам → база знаний
      if (intel.routes_mentioned.length > 0 && intel.traveler_tips.length > 0) {
        await this.saveToKnowledgeBase(chatId, chatTitle, intel, messages);
      }

      // 4. Обновляем счётчик группы
      await this.updateGroupStats(chatId, chatTitle, messages.length);

    } catch (err) {
      // Тихая ошибка — мониторинг не должен ронять webhook
    }
  }

  private async extractIntel(messages: GroupMessage[]): Promise<GroupIntel | null> {
    const rawText = messages
      .map(m => `[${m.from}]: ${m.text}`)
      .join('\n')
      .slice(0, 4000);

    const prompt: ChatMessage[] = [
      {
        role: 'system',
        content:
          'Ты — аналитик безопасности и рынка туризма Камчатки для платформы TourHab. ' +
          'Анализируешь переписку из Telegram-группы туристов и операторов. ' +
          'Главный приоритет платформы — БЕЗОПАСНОСТЬ туристов, затем бизнес-разведка.\n\n' +
          'ЖЕЛЕЗНЫЕ ПРАВИЛА:\n' +
          '1. Извлекай ТОЛЬКО то, что ЯВНО написано в тексте. Запрещено домысливать, обобщать или добавлять знания извне.\n' +
          '2. Если данных для поля нет — пустой массив []. Никогда не выдумывай маршрут, цену или компанию.\n' +
          '3. Маршрут/локация Камчатки — это реальный топоним: вулкан (Вилючинский, Мутновский, Толбачик, Авачинский, Корякский), ' +
          'озеро, источник, парк (Налычево, Ключевской), бухта. НЕ путай топоним с названием турфирмы.\n' +
          '4. Цену указывай как ЧИСЛО в рублях. «5 тыс»/«5к»/«5000р»/«от 5000» → 5000. Диапазон «5-7к» → нижняя граница 5000. Нет числа → не добавляй запись.\n' +
          '5. hot_signals — ТОЛЬКО про безопасность и срочную угрозу: ЧС, авария/травма, пропавшие туристы, ' +
          'закрытие маршрута/парка, извержение, лавинная опасность, штормовое предупреждение, отмена тура оператором. ' +
          'Жалоба на сервис без угрозы безопасности сюда НЕ входит.\n' +
          'Отвечай ТОЛЬКО валидным JSON, без markdown-блоков, без текста до или после.',
      },
      {
        role: 'user',
        content:
          `Переписка из туристической группы (формат [Автор]: текст):\n\n${rawText}\n\n` +
          'Верни JSON строго по схеме (значения только из текста выше):\n' +
          '{\n' +
          '  "routes_mentioned": ["точное название упомянутого маршрута/локации Камчатки"],\n' +
          '  "prices": [{"service": "за что цена", "price": 5000, "currency": "RUB", "context": "цитата"}],\n' +
          '  "conditions": ["условия на маршруте: погода, состояние дороги, снег, доступность перевала"],\n' +
          '  "traveler_tips": ["конкретный практический совет, сказанный туристом"],\n' +
          '  "competitor_mentions": ["название турфирмы/платформы-конкурента из текста"],\n' +
          '  "demand_signals": ["запрос туриста: ищет тур / спрашивает цену / ищет попутчиков"],\n' +
          '  "availability_signals": ["оператор объявляет СВОБОДНЫЕ МЕСТА: маршрут + дата + кол-во если есть"],\n' +
          '  "hot_signals": ["ЧС/безопасность/срочная угроза — см. правило 5"],\n' +
          '  "key_insights": ["ключевой вывод, прямо следующий из переписки"],\n' +
          '  "sentiment": "positive|neutral|negative"\n' +
          '}\n' +
          'Если категория пустая — []. Максимум 5 элементов на категорию. ' +
          'sentiment — общее настроение про туры/операторов (не про погоду).',
      },
    ];

    try {
      const raw = await callAIFast(prompt);
      // Пробуем вытащить JSON даже если AI добавил текст вокруг
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return null;
      return JSON.parse(match[0]) as GroupIntel;
    } catch {
      return null;
    }
  }

  private async saveToKnowledgeBase(
    chatId: string,
    chatTitle: string,
    intel: GroupIntel,
    messages: GroupMessage[],
  ): Promise<void> {
    const date = new Date().toISOString().slice(0, 10);

    for (const routeName of intel.routes_mentioned.slice(0, 3)) {
      const tips = intel.traveler_tips.slice(0, 5).join(' ');
      const conditions = intel.conditions.slice(0, 3).join(' ');
      const combined = [tips, conditions].filter(Boolean).join(' ').slice(0, 600);
      if (!combined) continue;

      const dedupe = `tg_tip_${chatId}_${routeName.toLowerCase().replace(/\s+/g, '_')}_${date}`;

      const slug = dedupe.replace(/[^a-z0-9-]+/g, '-');
      try {
        await pool.query(
          `INSERT INTO kamchatka_routes
             (dedupe_key, slug, title, description, category, source_name, source_url, metadata, is_visible, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, true, NOW(), NOW())
           ON CONFLICT (dedupe_key) DO UPDATE SET
             description = EXCLUDED.description,
             metadata    = EXCLUDED.metadata,
             updated_at  = NOW()`,
          [
            dedupe,
            slug,
            `${routeName} — советы туристов (${chatTitle})`,
            combined,
            'tourist_tip',
            chatTitle,
            `tg://group/${chatId}`,
            JSON.stringify({
              source:        'telegram_group',
              group_id:      chatId,
              group_title:   chatTitle,
              routes:        intel.routes_mentioned,
              conditions:    intel.conditions,
              tips:          intel.traveler_tips,
              sample:        messages.slice(-3).map(m => `${m.from}: ${m.text.slice(0, 100)}`),
              collected_at:  new Date().toISOString(),
            }),
          ]
        );
      } catch { /* конфликт или ошибка схемы — продолжаем */ }
    }
  }

  private async registerGroup(chatId: string, chatTitle: string): Promise<void> {
    try {
      const groups = await this.getMonitoredGroups();
      const existing = groups.find(g => g.id === chatId);
      if (!existing) {
        groups.push({
          id:            chatId,
          title:         chatTitle,
          joinedAt:      new Date().toISOString(),
          totalMessages: 0,
          lastActivityAt: new Date().toISOString(),
        });
        await agentMemory.remember({
          agent_id:    'evo',
          memory_type: 'intelligence',
          key:         'tg_monitored_groups',
          value:       { groups },
          confidence:  1.0,
          source:      'telegram_group',
          expires_at:  new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 год
        });
      }
    } catch { /* тихая ошибка */ }
  }

  private async updateGroupStats(chatId: string, chatTitle: string, newMessages: number): Promise<void> {
    try {
      const groups = await this.getMonitoredGroups();
      const g = groups.find(g => g.id === chatId);
      if (g) {
        g.totalMessages += newMessages;
        g.lastActivityAt = new Date().toISOString();
        g.title = chatTitle; // обновляем название если изменилось
        await agentMemory.remember({
          agent_id:    'evo',
          memory_type: 'intelligence',
          key:         'tg_monitored_groups',
          value:       { groups },
          confidence:  1.0,
          source:      'telegram_group',
          expires_at:  new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        });
      }
    } catch { /* тихая ошибка */ }
  }

  private flushStale(): void {
    const now = Date.now();
    for (const [chatId, buf] of this.buffers) {
      if (buf.messages.length === 0) continue;
      const age = now - (buf.lastAnalyzedAt || 0);
      if (age > BATCH_INTERVAL && buf.messages.length >= 3) {
        const batch = buf.messages.splice(0);
        buf.lastAnalyzedAt = now;
        buf.totalAnalyzed += batch.length;
        void this.analyzeAndStore(chatId, buf.title, batch, buf.totalAnalyzed);
      }
    }
  }
}

export const groupMonitor = new GroupMonitorService();
