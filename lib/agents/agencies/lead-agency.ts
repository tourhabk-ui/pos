import { z } from 'zod';
import { callAIWithModel } from '@/lib/ai/providers';
import { query } from '@/lib/database';
import type { ChatMessage } from '@/lib/ai/prompts';
import { getModelForAgent } from '@/lib/ai/agent-models';
import { redactPII } from '@/lib/security/pii-redact';

export interface LeadContext {
  leadId?: string;
  limit?: number;
}

export interface LeadData {
  id: string;
  name: string;
  phone: string;
  comment?: string;
  source_data?: { source?: string; [key: string]: unknown };
  status: string;
}

export class LeadAgency {
  async qualifyLeads(ctx: LeadContext) {
    const limit = ctx.limit ?? 10;
    const res = await query(
      `SELECT id, name, phone, comment, source_data, status
       FROM leads WHERE status = 'new' LIMIT $1`,
      [limit]
    );

    const leads = res.rows as unknown as LeadData[];
    if (!leads.length) {
      return { analyzed: 0, qualified: 0, details: 'Нет новых лидов' };
    }

    // 152-ФЗ: имя/телефон туриста НЕ отправляем в (зарубежный) LLM. Лиды идут
    // по индексу, комментарий чистим от телефонов/почты. Маппинг обратно — по index.
    const prompt = `
Проанализируй эти лиды туристических туров и определи качество каждого.
Выдай оценку от 1-10 и тип путешествия (fishing, trekking, thermal, boat_trip, helicopter).

Лиды (по номеру):
${leads.map((l, i) => `${i + 1}. "${redactPII(l.comment || 'без комментария')}"`).join('\n')}

Ответь в JSON формате:
{
  "analysis": [
    { "lead": 1, "score": 8, "intent": "fishing", "reason": "..." }
  ],
  "recommendation": "контактировать top-3 высокого качества"
}
    `;

    const { text: response } = await callAIWithModel([{ role: 'user', content: prompt }] as ChatMessage[], getModelForAgent('legal'));

    try {
      const parsed = JSON.parse(response);
      const qualified = (parsed.analysis as Array<{ score: number; lead: number; intent: string }> || []).filter((a) => a.score >= 7);

      // Обновим статусы в БД — лид по номеру из промпта (1-based)
      for (const item of qualified) {
        const lead = leads[(Number(item.lead) || 0) - 1];
        if (lead) {
          await query(
            `UPDATE leads SET status = 'qualified', notes = $1 WHERE id = $2`,
            [
              `Квалификация: ${item.score}/10, интерес к ${item.intent}`,
              lead.id,
            ]
          );
        }
      }

      return {
        analyzed: leads.length,
        qualified: qualified.length,
        details: parsed.recommendation,
      };
    } catch {
      return {
        analyzed: leads.length,
        qualified: 0,
        details: 'Ошибка парсинга AI ответа',
      };
    }
  }

  async suggestTours(leadId: string) {
    const res = await query(
      `SELECT id, comment, source_data FROM leads WHERE id = $1`,
      [leadId]
    );

    const rows = res.rows as unknown as LeadData[];
    if (!rows.length) {
      return { success: false, error: 'Лид не найден' };
    }

    const leadData = rows[0];
    const sourceInfo = leadData.source_data as { source?: string } | undefined;
    const prompt = `
Туристу интересно: "${redactPII(leadData.comment) || 'неизвестно'}"
Источник: ${sourceInfo?.source || 'неизвестно'}

Рекомендуй топ-3 тура с объяснением почему каждый подходит.
Ответь JSON: { "tours": [{ "type": "fishing|trekking|...", "reason": "..." }] }
    `;

    const { text: response } = await callAIWithModel([{ role: 'user', content: prompt }] as ChatMessage[], getModelForAgent('legal'));
    try {
      const parsed = JSON.parse(response);
      return { success: true, suggestions: parsed.tours };
    } catch {
      return { success: false, error: 'Ошибка analysys' };
    }
  }
}
