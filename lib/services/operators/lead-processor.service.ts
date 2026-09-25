/**
 * LeadProcessorService — AI Lead Processor
 *
 * Пайплайн:
 *   1. Достаём лид из БД
 *   2. AI-квалификация: извлекаем намерение (бюджет, активность, даты, группа)
 *   3. Подбираем до 3 подходящих туров из каталога
 *   4. Генерируем персональное предложение (headline + summary + highlights)
 *   5. Сохраняем lead_proposal, обновляем статус лида
 *   6. Возвращаем предложение для последующей отправки и PDF-генерации
 *
 * Используем callAIFast (DeepSeek via OpenRouter) — быстрый, точный для JSON
 */

import { pool } from '@/lib/db-pool';
import { callAIFast } from '@/lib/ai/providers';
import { redactPII } from '@/lib/security/pii-redact';

// ── Типы ──────────────────────────────────────────────────────────────────────

export interface LeadIntent {
  activity_types: string[];      // ['trekking', 'volcano', 'fishing']
  group_size: number;
  budget_rub: number | null;
  desired_dates: string | null;  // свободный текст
  duration_days: number | null;
  interests: string[];           // ['медведи', 'вулканы', 'термальные источники']
  urgency: 'low' | 'medium' | 'high';
  qualification_notes: string;
}

export interface MatchedTour {
  id: string;
  title: string;
  price: number;
  duration_days: number;
  activity_type: string;
  description: string;
  match_reason: string;
}

export interface AdversarialVerdict {
  bullSignals: string[];
  bearRisks: string[];
  /**
   * Вероятность оплаты по оценке Arbiter, 0-100. NULL — Arbiter не ответил
   * (ИИ недоступен, ответ не разобрался): честное «не оценено». Раньше на
   * этом месте стояла заглушка 50, и лид получал ai_score ~50 «из воздуха».
   */
  conversionProb: number | null;
  recommendedAction: 'call_immediately' | 'send_proposal' | 'nurture' | 'skip';
  callStrategy: string;
  urgency: 'hot' | 'warm' | 'cold';
}

export interface LeadProposalData {
  lead_id: string;
  proposal_id: string;
  headline: string;
  summary: string;
  highlights: string[];
  price_from: number | null;
  price_to: number | null;
  duration_days: number | null;
  primary_tour: MatchedTour | null;
  alt_tours: MatchedTour[];
  /** 0-100; NULL — лид не оценён (ИИ был недоступен или запись старая). */
  ai_score: number | null;
  intent: LeadIntent;
  generation_ms: number;
  adversarial?: AdversarialVerdict;
}

/**
 * Результат process(): предложение, по которому оценка ЕСТЬ. Когда Arbiter
 * не ответил, process() не выдумывает число, а бросает LeadNotScoredError —
 * лид остаётся «новым» с ai_score NULL, его подхватит повтор крона или
 * человек (Watchdog «лид без реакции > 2 ч»).
 */
export interface ProcessedLeadProposal extends LeadProposalData {
  ai_score: number;
}

/** ИИ не дал оценку лида — «не оценено», а не заглушка. */
export class LeadNotScoredError extends Error {
  constructor() {
    super('ИИ недоступен: лид не оценён. Статус возвращён в «Новый» — повторите обработку позже или свяжитесь с клиентом сами.');
    this.name = 'LeadNotScoredError';
  }
}

interface LeadRow {
  id: string;
  /** partners.id оператора лида; NULL — лид платформы, ничей. */
  operator_id: string | null;
  name: string;
  phone: string;
  email: string | null;
  comment: string | null;
  route_title: string | null;
  source_data: Record<string, unknown> | null;
  group_size: number | null;
  budget_rub: number | null;
  desired_dates: string | null;
  status: string;
}

interface TourRow {
  id: string;
  title: string;
  price: number;
  duration_days: number | null;
  activity_type: string | null;
  description: string | null;
}

// ── Утилиты ───────────────────────────────────────────────────────────────────

/**
 * Разбор JSON-ответа ИИ. При неудаче отдаёт `fallback` — заглушку, от
 * настоящего ответа неотличимую снаружи (score/вердикт/текст предложения
 * выглядят как обычные, посчитанные). Поэтому падение обязано быть видно
 * хоть где-то: `callAIFast` при отказе ВСЕХ провайдеров не бросает, а
 * возвращает `AI_FAST_UNAVAILABLE` строкой — она не парсится как JSON и
 * молча падает сюда же. Без лога «лид слабый» и «ИИ был недоступен, когда
 * лид обрабатывался» неразличимы: score занижен, но причина потеряна, и
 * никто не узнает, что нужно перепроверить лидов за окно простоя.
 */
export function safeJSON<T>(text: string, fallback: T, label: string): T {
  const match = text.match(/```json\s*([\s\S]*?)```/) ??
                text.match(/\{[\s\S]*\}/) ??
                text.match(/\[[\s\S]*\]/);
  const raw = match ? (match[1] ?? match[0]) : text.trim();
  try {
    return JSON.parse(raw) as T;
  } catch {
    console.error(`[lead-processor] ${label}: ответ ИИ не распарсился, взята заглушка:`, text.slice(0, 200));
    return fallback;
  }
}

// ── Основной класс ────────────────────────────────────────────────────────────

export class LeadProcessorService {

  /**
   * Полный пайплайн обработки лида.
   * Бросает Error если лид не найден или уже обработан.
   */
  async process(leadId: string): Promise<ProcessedLeadProposal> {
    const start = Date.now();

    // 1. Загружаем лид
    const lead = await this.getLead(leadId);
    if (!lead) throw new Error('Лид не найден');
    if (lead.status === 'ai_processing') throw new Error('Лид уже обрабатывается');
    if (lead.status === 'proposal_sent' || lead.status === 'converted') {
      throw new Error('Лид уже имеет предложение');
    }

    // 2. Ставим статус "в обработке"
    await pool.query(
      `UPDATE leads SET status = 'ai_processing', updated_at = NOW() WHERE id = $1`,
      [leadId]
    );
    await this.logActivity(leadId, 'ai', 'processing_started', {});

    try {
      // 3. AI-квалификация
      const intent = await this.qualifyLead(lead);

      // 4. Подбираем туры — только оператора лида, если он есть
      const tours = await this.matchTours(intent, lead.route_title ?? null, lead.operator_id);

      // 4.5. Adversarial analysis: Bull + Bear параллельно → Arbiter
      const verdict = await this.runAdversarialAnalysis(lead, intent, tours);

      // Arbiter не ответил — оценки нет. Не сохраняем предложение с
      // выдуманным числом: catch ниже вернёт лид в «new», ai_score останется
      // NULL («не оценено»).
      if (verdict.conversionProb === null) {
        throw new LeadNotScoredError();
      }

      // 5. Генерируем предложение (с учётом возражений Bear-агента)
      const proposal = await this.generateProposal(lead, intent, tours, verdict);

      // 6. Считаем AI-score (на основе verdict.conversionProb)
      const aiScore = this.computeScore(intent, tours, verdict.conversionProb);

      // 7. Сохраняем в БД
      const proposalId = await this.saveProposal({
        leadId,
        primaryTour: tours[0] ?? null,
        altTours: tours.slice(1),
        headline: proposal.headline,
        summary: proposal.summary,
        highlights: proposal.highlights,
        priceFrom: tours[0]?.price ?? null,
        priceTo: tours[tours.length - 1]?.price ?? null,
        durationDays: intent.duration_days ?? tours[0]?.duration_days ?? null,
        generationMs: Date.now() - start,
        verdict,
      });

      // 8. Обновляем лид
      await pool.query(
        `UPDATE leads
         SET status = 'ai_qualified',
             ai_score = $1,
             ai_summary = $2,
             ai_intent = $3,
             matched_tour_ids = $4,
             proposal_id = $5,
             processed_at = NOW(),
             updated_at = NOW()
         WHERE id = $6`,
        [
          aiScore,
          proposal.summary.slice(0, 500),
          JSON.stringify(intent),
          tours.map(t => t.id),
          proposalId,
          leadId,
        ]
      );

      await this.logActivity(leadId, 'ai', 'processing_complete', {
        score: aiScore,
        tours_matched: tours.length,
        proposal_id: proposalId,
      });

      return {
        lead_id:      leadId,
        proposal_id:  proposalId,
        headline:     proposal.headline,
        summary:      proposal.summary,
        highlights:   proposal.highlights,
        price_from:   tours[0]?.price ?? null,
        price_to:     tours[tours.length - 1]?.price ?? null,
        duration_days: intent.duration_days ?? tours[0]?.duration_days ?? null,
        primary_tour: tours[0] ?? null,
        alt_tours:    tours.slice(1),
        ai_score:     aiScore,
        intent,
        generation_ms: Date.now() - start,
        adversarial:  verdict,
      };
    } catch (err) {
      // При ошибке — снимаем статус
      await pool.query(
        `UPDATE leads SET status = 'new', updated_at = NOW() WHERE id = $1`,
        [leadId]
      );
      await this.logActivity(leadId, 'system', 'processing_error', {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  // ── Вспомогательные методы ─────────────────────────────────────────────────

  private async getLead(id: string): Promise<LeadRow | null> {
    const { rows } = await pool.query<LeadRow>(
      `SELECT id, operator_id::text AS operator_id, name, phone, email, comment, route_title, source_data,
              group_size, budget_rub, desired_dates, status
       FROM leads WHERE id = $1`,
      [id]
    );
    return rows[0] ?? null;
  }

  private async qualifyLead(lead: LeadRow): Promise<LeadIntent> {
    const prompt = `Ты — AI-квалификатор входящих заявок туристической платформы по Камчатке.
Задача — извлечь СТРУКТУРИРОВАННОЕ намерение из текста заявки. Ты НЕ продаёшь и НЕ советуешь.

ЖЕЛЕЗНЫЕ ПРАВИЛА (нарушение = брак):
1. Бери ТОЛЬКО факты, явно присутствующие в заявке. Нет данных — null (или 1 для группы). НЕ додумывай бюджет, даты, длительность.
2. activity_types и interests — ТОЛЬКО из перечисленных значений, массивом. Не изобретай новые. Активность не ясна — пустой массив [].
3. budget_rub — число в рублях как указал клиент ("100к" → 100000). Расплывчатое ("недорого") → null.
4. duration_days — только если назван срок ("на неделю" → 7). Иначе null. Не выводи из дат.
5. qualification_notes — сухая выжимка фактов для менеджера, без приукрашивания.

КОНТЕКСТ КАМЧАТКИ (для оценки реалистичности и urgency):
- Вертолётка и Долина гейзеров: июнь–сентябрь. Восхождения на вулканы: июль–сентябрь. Ски-тур/снегоходы: декабрь–апрель. Рыбалка (лосось): июль–сентябрь.
- Бронируют за 1–4 месяца. Если запрошенные даты конфликтуют с сезоном активности — отметь это в qualification_notes.

КРИТЕРИИ urgency:
- "high": конкретные близкие даты (≤6 недель) ИЛИ явная срочность/готовность платить.
- "medium": конкретный запрос (активность/маршрут/период) без жёстких сроков.
- "low": общий интерес без конкретики.

Заявка (152-ФЗ: имя/телефон туриста в модель не передаём):
- Комментарий: ${redactPII(lead.comment) || 'не указан'}
- Интересующий маршрут: ${lead.route_title ?? 'не указан'}
- Размер группы: ${lead.group_size ?? 'не указан'}
- Бюджет (руб): ${lead.budget_rub ?? 'не указан'}
- Желаемые даты: ${lead.desired_dates ?? 'не указаны'}
- Доп. данные: ${redactPII(JSON.stringify(lead.source_data ?? {}))}

Верни ТОЛЬКО валидный JSON без markdown и комментариев:
{
  "activity_types": ["trekking"|"volcano"|"fishing"|"thermal"|"helicopter"|"boat_trip"|"snowmobile"|"skiing"|"diving"|"kayak"|"horseback"|"birdwatching"|"photography"],
  "group_size": <целое число, 1 если неизвестно>,
  "budget_rub": <целое число рублей или null>,
  "desired_dates": "<дословно как в заявке, или null>",
  "duration_days": <целое число или null>,
  "interests": ["медведи"|"вулканы"|"гейзеры"|"рыбалка"|"термальные источники"|"океан"|"фотоохота"],
  "urgency": "low"|"medium"|"high",
  "qualification_notes": "<2-3 сухих факта для менеджера, включая конфликт дат с сезоном если есть>"
}`;

    const raw = await callAIFast([
      { role: 'system', content: 'Ты строгий парсер. Возвращай ОДИН валидный JSON-объект и ничего кроме него: без markdown-ограждений, без пояснений. Не выдумывай факты, которых нет во входных данных — используй null.' },
      { role: 'user', content: prompt },
    ]);

    return safeJSON<LeadIntent>(raw, {
      activity_types: [],
      group_size: lead.group_size ?? 1,
      budget_rub: lead.budget_rub ?? null,
      desired_dates: lead.desired_dates ?? null,
      duration_days: null,
      interests: [],
      urgency: 'medium',
      qualification_notes: lead.comment ?? 'Нет данных',
    }, 'qualify_intent');
  }

  /**
   * Подбор туров под намерение лида.
   *
   * Лид оператора получает ТОЛЬКО туры этого оператора: раньше подбор шёл по
   * всему каталогу, и предложение, которое оператор отправлял клиенту от
   * своего имени, могло рекламировать туры конкурента. Лид платформы
   * (operator_id NULL) — весь каталог.
   *
   * Пустой подбор — честно пустой. Раньше при нуле совпадений подставлялись
   * «любые активные туры» ORDER BY RANDOM() с подписью «рекомендован по
   * популярности» — популярность никто не считал, это была лотерея.
   */
  private async matchTours(
    intent: LeadIntent,
    routeTitle: string | null,
    operatorId: string | null,
  ): Promise<MatchedTour[]> {
    const params: unknown[] = [];
    const filters: string[] = [];

    if (intent.activity_types.length > 0) {
      const keywords = [...intent.interests, ...(routeTitle ? [routeTitle] : [])];
      const keywordFilter = keywords.map(k => `%${k}%`);
      params.push(intent.activity_types);
      params.push(keywordFilter.length > 0 ? keywordFilter : ['%%']);
      filters.push(`AND (activity_type = ANY($${params.length - 1}) OR title ILIKE ANY($${params.length}))`);
    }

    if (intent.budget_rub) {
      params.push(Math.round(Number(intent.budget_rub) * 1.2));
      filters.push(`AND base_price <= $${params.length}`);
    }

    if (operatorId) {
      params.push(operatorId);
      filters.push(`AND operator_id = $${params.length}::uuid`);
    }

    const { rows } = await pool.query<TourRow>(
      `SELECT id::text, title, ROUND(base_price)::int AS price,
              CEIL(COALESCE(duration_hours, 8) / 8.0)::int AS duration_days,
              activity_type, description
       FROM operator_tours
       WHERE is_active = true AND deleted_at IS NULL
         ${filters.join('\n         ')}
       ORDER BY id DESC
       LIMIT 30`,
      params
    );

    return this.rankTours(rows, intent).slice(0, 3);
  }

  private rankTours(tours: TourRow[], intent: LeadIntent): MatchedTour[] {
    return tours
      .map(t => {
        let score = 0;
        if (intent.activity_types.includes(t.activity_type ?? '')) score += 30;
        if (intent.budget_rub && t.price <= intent.budget_rub) score += 20;
        if (intent.duration_days && t.duration_days === intent.duration_days) score += 15;
        const titleLower = t.title.toLowerCase();
        for (const interest of intent.interests) {
          if (titleLower.includes(interest.toLowerCase())) score += 10;
        }
        return { ...t, score };
      })
      .sort((a, b) => b.score - a.score)
      .map(t => ({
        id:            t.id,
        title:         t.title,
        price:         t.price,
        duration_days: t.duration_days ?? 1,
        activity_type: t.activity_type ?? 'other',
        description:   (t.description ?? '').slice(0, 300),
        match_reason:  this.buildMatchReason(t, intent),
      }));
  }

  private buildMatchReason(
    tour: TourRow & { score?: number },
    intent: LeadIntent
  ): string {
    const reasons: string[] = [];
    if (intent.activity_types.includes(tour.activity_type ?? '')) {
      reasons.push('соответствует запрошенной активности');
    }
    if (intent.budget_rub && tour.price <= intent.budget_rub) {
      reasons.push('укладывается в бюджет');
    }
    // Популярность никто не считал — не пишем её. Если совпадений нет,
    // так и говорим: тур из каталога без прямого совпадения с запросом.
    if (reasons.length === 0) reasons.push('активный тур каталога, прямых совпадений с запросом нет');
    return reasons.join(', ');
  }

  // ── Adversarial Analysis ──────────────────────────────────────────────────

  /**
   * Запускает Bull + Bear агентов параллельно, затем Arbiter синтезирует вердикт.
   */
  private async runAdversarialAnalysis(
    lead: LeadRow,
    intent: LeadIntent,
    tours: MatchedTour[]
  ): Promise<AdversarialVerdict> {
    const context = `
Лид: ${redactPII(lead.comment) || 'нет комментария'}
Группа: ${intent.group_size} чел. | Бюджет: ${intent.budget_rub ? intent.budget_rub.toLocaleString('ru-RU') + ' ₽' : 'не указан'}
Активности: ${intent.activity_types.join(', ') || 'не указаны'}
Даты: ${intent.desired_dates ?? 'не указаны'}
Туры: ${tours.map(t => `"${t.title}" ${t.price.toLocaleString('ru-RU')} ₽`).join(', ') || 'нет подходящих'}
    `.trim();

    const bullPrompt = `Ты — Bull-агент в adversarial-анализе лида. Выдели РЕАЛЬНЫЕ сигналы готовности купить тур, опираясь ИСКЛЮЧИТЕЛЬНО на данные ниже.
${context}
Правила:
- Сигнал = конкретный факт из данных (назван бюджет, конкретные даты, размер группы, явный интерес к активности, совпадение запроса с подобранными турами).
- НЕ выдумывай эмоции и намерения, которых нет в тексте. "Клиент заинтересован" — не сигнал.
- Мало сильных сигналов — верни меньше. Лучше 1 честный, чем 5 натянутых.
- Каждый сигнал помечай силой: (сильный)/(средний)/(слабый).
Верни ТОЛЬКО JSON без markdown: { "signals": ["(сильный) ...", "(средний) ..."] } — от 1 до 5 сигналов.`;

    const bearPrompt = `Ты — Bear-агент в adversarial-анализе лида. Выдели РЕАЛЬНЫЕ причины и возражения, по которым турист НЕ купит, опираясь ТОЛЬКО на данные ниже.
${context}
Типы рисков для проверки:
- Бюджет не покрывает подобранные туры (вертолётные/Долина гейзеров — дорогие).
- Запрошенные даты вне сезона активности (вертолётка/гейзеры — лето; ски-тур/снегоходы — зима).
- Нет конкретики (ни дат, ни активности, ни бюджета) — холодный интерес.
- Большая группа без подтверждённого бюджета. Нет подходящих туров под запрос.
Правила:
- Каждый риск конкретный и по возможности СНИМАЕМЫЙ менеджером в разговоре (их дальше нейтрализуют).
- Не сгущай краски и не выдумывай. Рисков мало — верни меньше.
Верни ТОЛЬКО JSON без markdown: { "risks": ["...", "..."] } — от 1 до 5 рисков.`;

    const [bullRaw, bearRaw] = await Promise.all([
      callAIFast([
        { role: 'system', content: 'Отвечай только валидным JSON.' },
        { role: 'user', content: bullPrompt },
      ]).catch(() => '{"signals":[]}'),
      callAIFast([
        { role: 'system', content: 'Отвечай только валидным JSON.' },
        { role: 'user', content: bearPrompt },
      ]).catch(() => '{"risks":[]}'),
    ]);

    const bull = safeJSON<{ signals: string[] }>(bullRaw, { signals: [] }, 'bull');
    const bear = safeJSON<{ risks: string[] }>(bearRaw, { risks: [] }, 'bear');

    const arbiterPrompt = `Ты — Arbiter в adversarial-анализе лида. Bull привёл сигналы покупки, Bear — риски. Вынеси трезвый вердикт по их силе и фактам лида. Не подыгрывай ни одной стороне.

Bull нашёл:
${bull.signals.map((s, i) => `${i + 1}. ${s}`).join('\n') || 'нет сигналов'}

Bear нашёл:
${bear.risks.map((r, i) => `${i + 1}. ${r}`).join('\n') || 'нет рисков'}

${context}

ШКАЛА conversion_prob (вероятность дойти до оплаты):
- 75-95: бюджет + конкретные даты в сезоне + чёткая активность + есть подходящий тур, мало рисков.
- 50-74: 2+ сильных сигнала, риски снимаемы в разговоре.
- 25-49: один сигнал или общий интерес, серьёзные риски (несезон, бюджет не бьётся).
- 5-24: почти нет конкретики ИЛИ блокирующий риск.
- Если Bull и Bear пусты — не выдумывай: ставь 30-40 и action "nurture".

КРИТЕРИИ recommended_action:
- "call_immediately": conversion_prob ≥ 70 ИЛИ высокая срочность с конкретными датами.
- "send_proposal": conversion_prob 45-69, есть подходящие туры.
- "nurture": conversion_prob 20-44 или нет конкретики.
- "skip": нерелевантный/спам/нереализуемый запрос (зимняя вертолётка без альтернатив).
urgency: "hot" если call_immediately; "warm" если send_proposal; "cold" если nurture/skip.

Верни ТОЛЬКО JSON без markdown:
{
  "conversion_prob": <целое 0-100 по шкале выше>,
  "recommended_action": "call_immediately"|"send_proposal"|"nurture"|"skip",
  "call_strategy": "<одно конкретное предложение: с какой фразы начать звонок, чтобы снять ГЛАВНЫЙ риск Bear>",
  "urgency": "hot"|"warm"|"cold"
}`;

    const arbiterRaw = await callAIFast([
      { role: 'system', content: 'Отвечай только валидным JSON.' },
      { role: 'user', content: arbiterPrompt },
    ]).catch(() => '{}');

    const arbiter = safeJSON<{
      conversion_prob: number | null;
      recommended_action: string;
      call_strategy: string;
      urgency: string;
    }>(arbiterRaw, {
      // NULL, а не 50: Arbiter не ответил — оценки нет (§4.0).
      conversion_prob: null,
      recommended_action: 'send_proposal',
      call_strategy: 'Уточните детали поездки и предложите лучший тур.',
      urgency: 'warm',
    }, 'arbiter');

    return {
      bullSignals:        bull.signals.slice(0, 5),
      bearRisks:          bear.risks.slice(0, 5),
      conversionProb:     typeof arbiter.conversion_prob === 'number' && Number.isFinite(arbiter.conversion_prob)
                            ? Math.round(Math.max(0, Math.min(100, arbiter.conversion_prob)))
                            : null,
      recommendedAction:  (['call_immediately', 'send_proposal', 'nurture', 'skip'] as const)
                            .includes(arbiter.recommended_action as 'call_immediately')
                            ? arbiter.recommended_action as AdversarialVerdict['recommendedAction']
                            : 'send_proposal',
      callStrategy:       arbiter.call_strategy ?? '',
      urgency:            (['hot', 'warm', 'cold'] as const).includes(arbiter.urgency as 'hot')
                            ? arbiter.urgency as AdversarialVerdict['urgency']
                            : 'warm',
    };
  }

  private async generateProposal(
    lead: LeadRow,
    intent: LeadIntent,
    tours: MatchedTour[],
    verdict: AdversarialVerdict
  ): Promise<{ headline: string; summary: string; highlights: string[] }> {
    const toursText = tours.length > 0
      ? tours.map((t, i) =>
          `${i + 1}. "${t.title}" — ${t.price.toLocaleString('ru-RU')} ₽/чел, ${t.duration_days} дн. (${t.activity_type})`
        ).join('\n')
      : 'Туры подбираются индивидуально';

    const bearContext = verdict.bearRisks.length > 0
      ? `\nГлавные возражения клиента (нейтрализуй их в тексте):\n${verdict.bearRisks.slice(0, 3).map((r, i) => `${i + 1}. ${r}`).join('\n')}`
      : '';

    const prompt = `Ты — менеджер платформы TourHab по турам на Камчатку. Составь персональное, честное коммерческое предложение.

АНТИ-ГАЛЛЮЦИНАЦИИ (критично — текст уйдёт клиенту в PDF):
- Пиши ТОЛЬКО о турах из списка ниже и о фактах из запроса клиента.
- НЕ придумывай: цены кроме указанных, скидки, акции, "перелёт включён", трансферы, состав программы, конкретные даты заездов, наличие мест.
- НЕ давай обещаний-гарантий ("гарантия лучшей цены", "лучшие гиды") — это непроверяемо.
- Подходящих туров нет — честно предложи подобрать индивидуально, без выдуманной конкретики.

ТОН: тёплый, экспертный, про безопасность и природу Камчатки, без давления и рекламных штампов.

ПРИВЕТСТВИЕ: используй РОВНО плейсхолдер {name} (имя подставим сами, тебе оно не передаётся) — не выдумывай имя.

Запрос: ${redactPII(lead.comment) || intent.qualification_notes}
Группа: ${intent.group_size} чел.
Активности: ${intent.activity_types.join(', ') || 'любые'}
Интересы: ${intent.interests.join(', ') || 'не указаны'}
Бюджет: ${intent.budget_rub ? intent.budget_rub.toLocaleString('ru-RU') + ' ₽' : 'не указан'}
Даты: ${intent.desired_dates ?? 'гибкие'}
${bearContext}

Подобранные туры (используй ТОЛЬКО их названия, цены и длительность):
${toursText}

Если туры дороже бюджета — мягко обозначь диапазон цен честно, не выдумывай скидку.

Верни ТОЛЬКО валидный JSON без markdown:
{
  "headline": "<заголовок до 80 символов, конкретный, без штампов>",
  "summary": "<приветствие по имени + предложение на основе подобранных туров, 150-200 слов по-русски, мягко снимающее главное возражение>",
  "highlights": ["<фишка на основе конкретного тура или интереса клиента>", "<...>", "<...>", "<...>"]
}`;

    const raw = await callAIFast([
      { role: 'system', content: 'Ты строгий генератор. Возвращай ОДИН валидный JSON-объект, без markdown и пояснений. Не выдумывай цен, скидок и обещаний, которых нет во входных данных.' },
      { role: 'user', content: prompt },
    ]);

    const parsed = safeJSON(raw, {
      headline: `Подбор тура на Камчатку для {name}`,
      summary: `Здравствуйте, {name}! Мы получили ваш запрос и подберём подходящие туры на Камчатке с учётом ваших интересов и дат. Менеджер свяжется с вами, уточнит детали и поможет с организацией поездки, включая регистрацию в МЧС на серьёзных маршрутах.`,
      highlights: [
        'Подбор тура под ваш запрос',
        'Прямой контакт с проверенным оператором',
        'Сопровождение от заявки до выезда',
        'Помощь с регистрацией в МЧС',
      ],
    }, 'proposal');

    // Имя подставляем ЛОКАЛЬНО (в модель оно не уходило) — плейсхолдер {name}.
    const withName = (s: string): string => (s ?? '').split('{name}').join(lead.name);
    return {
      headline: withName(parsed.headline),
      summary: withName(parsed.summary),
      highlights: Array.isArray(parsed.highlights) ? parsed.highlights.map(withName) : [],
    };
  }

  /**
   * AI-score лида: Arbiter первичен (70%), эвристика по фактам — вторична (30%).
   * Без оценки Arbiter числа нет — process() до сюда не доходит.
   */
  private computeScore(intent: LeadIntent, tours: MatchedTour[], conversionProb: number): number {
    let heuristic = 30;
    if (intent.activity_types.length > 0) heuristic += 5;
    if (intent.budget_rub) heuristic += 5;
    if (intent.desired_dates) heuristic += 5;
    if (intent.urgency === 'high') heuristic += 5;
    if (tours.length > 0) heuristic += 5;
    heuristic = Math.min(25, heuristic - 30); // нормируем добавку
    return Math.min(100, Math.round(conversionProb * 0.7 + (50 + heuristic) * 0.3));
  }

  private async saveProposal(data: {
    leadId: string;
    primaryTour: MatchedTour | null;
    altTours: MatchedTour[];
    headline: string;
    summary: string;
    highlights: string[];
    priceFrom: number | null;
    priceTo: number | null;
    durationDays: number | null;
    generationMs: number;
    verdict?: AdversarialVerdict;
  }): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO lead_proposals
         (lead_id, primary_tour_id, alt_tour_ids, headline, summary, highlights,
          price_from, price_to, duration_days, generation_ms,
          bull_signals, bear_risks, conversion_prob,
          recommended_action, call_strategy, verdict_urgency)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING id`,
      [
        data.leadId,
        data.primaryTour?.id ?? null,
        data.altTours.map(t => t.id),
        data.headline,
        data.summary,
        JSON.stringify(data.highlights),
        // price_* — INTEGER: округляем на случай NUMERIC-источника («5000.00»)
        data.priceFrom == null ? null : Math.round(Number(data.priceFrom)),
        data.priceTo == null ? null : Math.round(Number(data.priceTo)),
        data.durationDays,
        data.generationMs,
        JSON.stringify(data.verdict?.bullSignals ?? []),
        JSON.stringify(data.verdict?.bearRisks ?? []),
        data.verdict?.conversionProb ?? null,
        data.verdict?.recommendedAction ?? null,
        data.verdict?.callStrategy ?? null,
        data.verdict?.urgency ?? null,
      ]
    );
    return rows[0].id;
  }

  private async logActivity(
    leadId: string,
    actor: string,
    action: string,
    details: Record<string, unknown>
  ): Promise<void> {
    await pool.query(
      `INSERT INTO lead_activity_log (lead_id, actor, action, details) VALUES ($1, $2, $3, $4)`,
      [leadId, actor, action, JSON.stringify(details)]
    );
  }

  /**
   * Получить предложение с полными данными тура
   */
  async getProposal(proposalId: string): Promise<LeadProposalData | null> {
    const { rows } = await pool.query(
      `SELECT
         lp.*,
         l.name       AS lead_name,
         l.phone      AS lead_phone,
         l.email      AS lead_email,
         l.comment    AS lead_comment,
         l.group_size AS lead_group_size,
         l.ai_score,
         l.ai_intent,
         t.title      AS tour_title,
         t.base_price AS tour_price,
         CEIL(COALESCE(t.duration_hours, 8) / 8.0)::int AS tour_duration_days,
         t.activity_type    AS tour_activity_type,
         t.description      AS tour_description
       FROM lead_proposals lp
       JOIN leads l ON l.id = lp.lead_id
       LEFT JOIN operator_tours t ON t.id::text = lp.primary_tour_id
       WHERE lp.id = $1`,
      [proposalId]
    );

    if (!rows[0]) return null;
    const r = rows[0];

    const primaryTour: MatchedTour | null = r.tour_title ? {
      id:            r.primary_tour_id,
      title:         r.tour_title,
      price:         Number(r.tour_price),
      duration_days: r.tour_duration_days ?? 1,
      activity_type: r.tour_activity_type ?? 'other',
      description:   r.tour_description ?? '',
      match_reason:  '',
    } : null;

    // Альтернативные туры — из alt_tour_ids предложения. Раньше отдавался
    // пустой массив, и ни экран лида, ни PDF альтернатив не показывали.
    const altIds: string[] = Array.isArray(r.alt_tour_ids)
      ? (r.alt_tour_ids as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];
    let altTours: MatchedTour[] = [];
    if (altIds.length > 0) {
      const { rows: altRows } = await pool.query<TourRow>(
        `SELECT id::text, title, ROUND(base_price)::int AS price,
                CEIL(COALESCE(duration_hours, 8) / 8.0)::int AS duration_days,
                activity_type, description
           FROM operator_tours
          WHERE id::text = ANY($1::text[])`,
        [altIds]
      );
      const byId = new Map(altRows.map(t => [t.id, t]));
      altTours = altIds
        .map(id => byId.get(id))
        .filter((t): t is TourRow => t !== undefined)
        .map(t => ({
          id:            t.id,
          title:         t.title,
          price:         Number(t.price),
          duration_days: t.duration_days ?? 1,
          activity_type: t.activity_type ?? 'other',
          description:   (t.description ?? '').slice(0, 300),
          match_reason:  '',
        }));
    }

    return {
      lead_id:      r.lead_id,
      proposal_id:  r.id,
      headline:     r.headline,
      summary:      r.summary,
      highlights:   Array.isArray(r.highlights) ? r.highlights : JSON.parse(r.highlights ?? '[]'),
      price_from:   r.price_from ? Number(r.price_from) : null,
      price_to:     r.price_to ? Number(r.price_to) : null,
      duration_days: r.duration_days ? Number(r.duration_days) : null,
      primary_tour: primaryTour,
      alt_tours:    altTours,
      // NULL — «не оценено», а не 0: ноль читался как «безнадёжный лид».
      ai_score:     typeof r.ai_score === 'number' ? r.ai_score : null,
      intent:       typeof r.ai_intent === 'string' ? JSON.parse(r.ai_intent) : (r.ai_intent ?? {}),
      generation_ms: r.generation_ms ?? 0,
      adversarial:  verdictFromRow(r),
    };
  }

  /**
   * Пометить предложение как отправленное + обновить статус лида
   */
  async markProposalSent(proposalId: string, leadId: string): Promise<void> {
    await Promise.all([
      pool.query(
        `UPDATE lead_proposals SET status = 'sent', sent_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [proposalId]
      ),
      pool.query(
        `UPDATE leads SET status = 'proposal_sent', updated_at = NOW() WHERE id = $1`,
        [leadId]
      ),
    ]);
    await this.logActivity(leadId, 'system', 'proposal_sent', { proposal_id: proposalId });
  }
}

export const leadProcessor = new LeadProcessorService();

const ACTIONS: readonly AdversarialVerdict['recommendedAction'][] = ['call_immediately', 'send_proposal', 'nurture', 'skip'];
const URGENCIES: readonly AdversarialVerdict['urgency'][] = ['hot', 'warm', 'cold'];

function jsonStringArray(v: unknown): string[] {
  const arr: unknown = typeof v === 'string' ? (() => { try { return JSON.parse(v); } catch { return []; } })() : v;
  return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * Разбор adversarial-анализа из строки lead_proposals. Предложения до
 * появления разбора (все поля пусты) — undefined: блока нет, а не пустой.
 * conversion_prob хранится в процентах 0-100 (CHECK в схеме).
 */
export function verdictFromRow(r: Record<string, unknown>): AdversarialVerdict | undefined {
  const action = r.recommended_action;
  const urgency = r.verdict_urgency;
  const bull = jsonStringArray(r.bull_signals);
  const bear = jsonStringArray(r.bear_risks);
  const prob = r.conversion_prob === null || r.conversion_prob === undefined ? null : Number(r.conversion_prob);
  const hasAny = bull.length > 0 || bear.length > 0 || prob !== null
    || typeof action === 'string' || typeof r.call_strategy === 'string';
  if (!hasAny) return undefined;
  return {
    bullSignals: bull,
    bearRisks: bear,
    conversionProb: prob !== null && Number.isFinite(prob) ? prob : null,
    recommendedAction: ACTIONS.includes(action as AdversarialVerdict['recommendedAction'])
      ? (action as AdversarialVerdict['recommendedAction']) : 'send_proposal',
    callStrategy: typeof r.call_strategy === 'string' ? r.call_strategy : '',
    urgency: URGENCIES.includes(urgency as AdversarialVerdict['urgency'])
      ? (urgency as AdversarialVerdict['urgency']) : 'warm',
  };
}

/** Convenience wrapper for batch routes — fetches lead from DB by ID */
export async function processSingleLead(leadId: string, _data?: unknown): Promise<void> {
  await leadProcessor.process(leadId);
}
