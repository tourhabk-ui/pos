import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { telegramService } from '@/lib/notifications/telegram';
import { requireRole } from '@/lib/auth/middleware';
import type { JWTPayload } from '@/lib/auth/jwt';
import { notifyOperatorNewLead, notifyPartnerNewLeadPersonally } from '@/lib/notifications/lead-notify';
import { recordPartnerDelivery } from '@/lib/leads/delivery-outcome';
import { createRateLimiter, getTrustedClientIp } from '@/lib/rate-limit';
import { leadProcessor } from '@/lib/services/operators/lead-processor.service';
import { createLeadDetailed } from '@/lib/leads/create';
import { LEAD_FORM_KEY_NAME, issueRequestKey, requestPageLinks } from '@/lib/mcp/request-status';
import { isSelfVisit } from '@/lib/analytics/self-visit';
import { attachMcpAttribution, MCP_ATTRIBUTION } from '@/lib/mcp/handoff';
import { buildConsentRecord } from '@/lib/legal/pd-consent';
import { sendPdAlert } from '@/lib/notifications/pd-alert';
import { getPublicBaseUrl } from '@/lib/config';
import { leadOwnershipCond } from '@/lib/leads/ownership';
import { LEADS_PAGE_MAX } from '@/lib/leads/list-page';
import { logSwallowedFailure } from '@/lib/observability/swallowed';
import { LeadIsVehicleOrderError } from '@/lib/leads/vehicle-order';
import { widgetOrigin } from '@/lib/embed/widget-origin';

const leadLimiter = createRateLimiter({ windowMs: 60_000, max: 5 }); // 5 заявок/мин с одного IP

const LeadSchema = z.object({
  name:         z.string().min(2, 'Укажите имя').max(120),
  phone:        z.string().min(7, 'Укажите телефон').max(30),
  comment:      z.string().max(1000).optional(),
  route_id:     z.string().uuid().optional(),
  route_title:  z.string().max(255).optional(),
  source_url:   z.string().max(500).optional(),
  source_data:  z.record(z.string(), z.unknown()).optional(),
  partner_slug: z.string().max(100).optional(), // widget embed: resolve to operator_id
  // Согласие на обработку ПД. Обязательно и обязано быть именно true: форма
  // собирает имя и телефон, и право их собирать доказывается здесь, а не
  // галочкой, которая жила только в браузере (замер 23.08 — она приходила
  // на сервер ровно ниоткуда).
  pd_consent: z.literal(true, { message: 'Необходимо согласие на обработку персональных данных' }),
});

const ListSchema = z.object({
  status: z.enum([
    'new', 'ai_processing', 'ai_qualified', 'proposal_sent',
    'awaiting_confirm', 'contacted', 'qualified', 'converted', 'lost', 'all',
  ]).optional().default('all'),
  // Потолок общий с канбаном (lib/leads/list-page.ts): доска читает страницами.
  limit:  z.coerce.number().min(1).max(LEADS_PAGE_MAX).optional().default(50),
  offset: z.coerce.number().min(0).optional().default(0),
});

export async function GET(req: NextRequest) {
  const authResult = await requireRole(req, ['admin', 'operator']);
  if (authResult instanceof NextResponse) return authResult;

  const user = authResult as JWTPayload;

  const { searchParams } = new URL(req.url);
  const parse = ListSchema.safeParse(Object.fromEntries(searchParams));
  if (!parse.success) return NextResponse.json({ error: 'Неверные параметры' }, { status: 400 });

  const { status, limit, offset } = parse.data;

  const conditions: string[] = [];
  const vals: unknown[] = [];

  if (status !== 'all') {
    vals.push(status);
    conditions.push(`status = $${vals.length}`);
  }
  // Скоуп — единая формула lib/leads/ownership: свои и ничейные, а у
  // оператора без партнёрской записи — только ничейные. До 25.09 список
  // считал скоуп сам и при отсутствии записи не ставил фильтра вовсе:
  // оператор видел ВСЕ лиды платформы с именами и телефонами.
  const scope = await leadOwnershipCond(user, vals.length + 1);
  if (scope.cond) {
    conditions.push(scope.cond.replace(/^ AND /, ''));
    vals.push(...scope.vals);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const lIdx = vals.length + 1;
  const oIdx = lIdx + 1;
  vals.push(limit, offset);

  const [rows, cnt] = await Promise.all([
    pool.query(
      `SELECT id, name, phone, email, comment, route_id, route_title, source_url, source_data,
              group_size, budget_rub, desired_dates,
              status, notes,
              ai_score, ai_summary, ai_intent, matched_tour_ids, proposal_id, processed_at,
              operator_id, created_at, updated_at
       FROM leads ${where} ORDER BY created_at DESC LIMIT $${lIdx} OFFSET $${oIdx}`,
      vals
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total FROM leads ${where}`,
      vals.slice(0, -2)
    ),
  ]);

  return NextResponse.json({ leads: rows.rows, total: cnt.rows[0].total });
}

export async function POST(req: NextRequest) {
  const ip = getTrustedClientIp(req.headers);
  const allowed = leadLimiter.check(ip);
  if (!allowed) {
    return NextResponse.json(
      { success: false, error: 'Слишком много запросов. Попробуйте через минуту.' },
      { status: 429 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Неверный формат запроса' }, { status: 400 });
  }

  const parse = LeadSchema.safeParse(body);
  if (!parse.success) {
    return NextResponse.json(
      { success: false, error: parse.error.issues[0]?.message ?? 'Ошибка валидации' },
      { status: 422 }
    );
  }

  const { name, phone, comment, route_id, route_title, source_url, source_data, partner_slug } = parse.data;

  // Если пришёл partner_slug — резолвим operator_id. Форма виджета до 29.09
  // клала slug только в source_data, и лид вставал без оператора: в пул и в
  // рабочий чат платформы вместо партнёра. Закэшированная у посетителя
  // старая форма шлёт так и сейчас — поэтому запасной путь, а не только
  // правка формы.
  const embeddedSlug = typeof source_data?.partner_slug === 'string' ? source_data.partner_slug : undefined;
  const widgetSlug = partner_slug ?? (embeddedSlug && embeddedSlug.length <= 100 ? embeddedSlug : undefined);
  // Виджет на сайте партнёра — по включённому виджету; форма на странице
  // оператора на Ведаре (vedarai.ru/<slug>, #2414) — по публичности карточки:
  // та же граница, что показывает саму страницу. До 13.10 стоял только первый
  // гейт, и заявка со страницы оператора без виджета вставала без оператора —
  // в пул, а не в его кабинет, вопреки тексту над формой.
  let operator: { id: string; name: string | null; widget_domains?: string[] | null } | null = null;
  if (widgetSlug) {
    const pRes = await pool.query<{ id: string; name: string | null; widget_domains: string[] | null }>(
      `SELECT id, name, widget_domains FROM partners WHERE slug = $1 AND (widget_enabled = true OR is_public = true) LIMIT 1`,
      [widgetSlug]
    );
    operator = pRes.rows[0] ?? null;
  }
  const operatorId = operator?.id ?? null;

  // Заявка с формы виджета: откуда пришёл человек (аудит 15.10, WID-measure).
  // Хост и путь присылает форма из адреса своего окна; сервер чистит их и
  // САМ ставит исход сверки со списком доменов партнёра — listed / unlisted /
  // not_sent. Присланный клиентом исход не принимается ни у какой формы.
  // Хост подделывается: это сигнал для счёта, а не замок — от него не зависит
  // ни адресат заявки, ни её приём.
  let leadSourceData = source_data;
  if (leadSourceData && 'widget_origin' in leadSourceData) {
    const { widget_origin: sent, ...rest } = leadSourceData;
    leadSourceData = rest;
    if (rest.source === 'partner_widget') {
      const o = (sent && typeof sent === 'object' ? sent : {}) as { host?: unknown; path?: unknown };
      leadSourceData = { ...rest, widget_origin: widgetOrigin(o.host, o.path, operator?.widget_domains) };
    }
  } else if (leadSourceData?.source === 'partner_widget') {
    leadSourceData = { ...leadSourceData, widget_origin: widgetOrigin(null, null, operator?.widget_domains) };
  }

  // Атрибуция MCP-handoff: подписанная HttpOnly-cookie после перехода по
  // /mcp/h/<token>. В source_data попадает только UUID handoff-а — ни
  // телефона, ни имени, ни аргументов инструмента (чертёж 15.08).
  const mcpHandoffId = await attachMcpAttribution(
    req.cookies.get(MCP_ATTRIBUTION.cookieName)?.value,
    'lead_created',
  );

  // Единый путь: скоринг → INSERT → уведомление админу
  const isSelf = isSelfVisit(req.headers.get('cookie'));
  const created = await createLeadDetailed({
    name, phone, comment, route_id, route_title, source_url,
    pd_consent: buildConsentRecord(true, getTrustedClientIp(req.headers), widgetSlug ? 'widget' : 'web-form'),
    source_data: mcpHandoffId ? { ...(leadSourceData ?? {}), mcp_handoff_id: mcpHandoffId } : leadSourceData,
    operator_id: operatorId,
    // Свой заход (cookie владельца) — лид с пометкой, вне счёта спроса (1145).
    is_self: isSelf,
  });

  if (!created) {
    return NextResponse.json({ success: false, error: 'Ошибка сервера. Попробуйте позже.' }, { status: 500 });
  }
  const leadId = created.id;

  // Telegram — LEADS_CHAT_ID (старый канал, параллельно с admin-чатом).
  // ПД сюда больше не уходят (решение владельца 23.08): имя, телефон и
  // комментарий идут в MAX через sendPdAlert, а этот канал остаётся сигналом
  // «заявка пришла». Это ТРЕТЬЯ копия уведомления об одном лиде — две другие
  // идут через createLead → notifyAdminNewLead и notifyOperatorNewLead; канал
  // можно выключить, убрав TELEGRAM_LEADS_CHAT_ID.
  const chatId = process.env.TELEGRAM_LEADS_CHAT_ID;
  if (chatId) {
    const lines = [
      '<b>Новая заявка с сайта</b>',
      '',
      `Заявка <code>${leadId}</code> принята.`,
    ];
    if (route_title) lines.push(`<b>Маршрут:</b> ${escHtml(route_title)}`);
    if (source_url) lines.push(`<b>Страница:</b> <a href="${escHtml(source_url)}">${escHtml(source_url)}</a>`);
    if (source_data) {
      const sd = source_data as Record<string, string | undefined>;
      if (sd.utm_source) lines.push(`<b>UTM:</b> ${escHtml(sd.utm_source)}${sd.utm_medium ? ` / ${escHtml(sd.utm_medium)}` : ''}${sd.utm_campaign ? ` / ${escHtml(sd.utm_campaign)}` : ''}`);
      if (sd.referrer) lines.push(`<b>Referrer:</b> ${escHtml(sd.referrer)}`);
    }
    lines.push('', 'Имя и телефон — в MAX и в кабинете.');

    telegramService.sendMessage({ chatId, text: lines.join('\n'), parseMode: 'HTML' })
      .catch(() => null);
  }

  // Уведомления: лично оператору, которому заявка адресована (если он
  // привязан к MAX/Telegram), затем рабочему чату платформы — с исходом личной
  // доставки. Ответ туристу их не ждёт; отказ — в лог, не в тишину.
  const sourceKind = typeof source_data?.source === 'string' ? source_data.source : '';
  const origin = sourceKind === 'operator_page'
    ? 'форма на вашей странице на Ведаре'
    : sourceKind === 'partner_widget' ? 'виджет на вашем сайте'
      : sourceKind === 'partner_site' ? 'форма на вашем сайте' : 'форма на Ведаре';
  const partner = operator;
  void (async () => {
    const personal = partner
      ? await notifyPartnerNewLeadPersonally({
          operatorId: partner.id, leadId, name, phone, comment,
          routeTitle: route_title, origin, sourceUrl: source_url,
          // Своя проба (1145) — без переписки: партнёру некому отвечать.
          chat: !isSelf,
        })
      : null;
    // Итог личной доставки — в журнал заявки: «дошла ли до оператора» должно
    // отвечаться данными, а не вопросом оператору (владелец 15.10).
    if (partner && personal) await recordPartnerDelivery(leadId, partner.id, personal);
    await notifyOperatorNewLead({
      leadId,
      name,
      phone,
      comment:    comment,
      routeTitle: route_title,
      forPartner: partner ? { name: partner.name ?? widgetSlug ?? partner.id, outcome: personal } : undefined,
    });
  })().catch((e: unknown) => {
    console.error(`[leads] уведомления о заявке ${leadId} не отправлены:`, e instanceof Error ? e.message : e);
  });

  // AI обработка — fire-and-forget, не блокирует ответ туристу
  void autoProcessLead(leadId, name);

  // Заявка компании (страница, её сайт, виджет) — страница заявки с перепиской
  // и ссылка подключить MAX (1350). Ключ выдаётся и повтору (ответ тот же), но
  // переписку открывает только ключ новой заявки. Заявка без компании — менеджеру
  // Ведара: переписки с адресатом у неё нет, ключа тоже.
  const key = partner
    ? await issueRequestKey({ leadId }, LEAD_FORM_KEY_NAME, { opensChat: created.created && !isSelf })
    : null;
  return NextResponse.json({ success: true, id: leadId, ...(partner ? requestPageLinks(key) : {}) }, { status: 201 });
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Авто-обработка лида: AI квалифицирует + подбирает туры + уведомляет ──────
async function autoProcessLead(leadId: string, leadName: string): Promise<void> {
  try {
    const proposal = await leadProcessor.process(leadId);

    // Уведомление о результате AI содержит ПД: имя туриста стоит в самом
    // тексте и, кроме того, подставляется локально в proposal.headline
    // (lead-processor.service, withName). Значит — в MAX, не в Telegram.
    const scoreBar = '█'.repeat(Math.round(proposal.ai_score / 10)) + '░'.repeat(10 - Math.round(proposal.ai_score / 10));
    const urgencyLabel: Record<string, string> = { high: 'СРОЧНО', medium: 'Стандарт', low: 'Низкий приоритет' };
    const baseUrl = getPublicBaseUrl();

    const common = [
      `Скор: <code>${scoreBar}</code> ${proposal.ai_score}/100`,
      `Приоритет: ${urgencyLabel[proposal.intent.urgency] ?? proposal.intent.urgency}`,
      proposal.intent.activity_types.length > 0
        ? `Активности: ${proposal.intent.activity_types.join(', ')}`
        : '',
      (proposal.intent.group_size ?? 0) > 1 ? `Группа: ${proposal.intent.group_size} чел.` : '',
      proposal.intent.budget_rub ? `Бюджет: ${proposal.intent.budget_rub.toLocaleString('ru-RU')} руб` : '',
      proposal.intent.desired_dates ? `Даты: ${proposal.intent.desired_dates}` : '',
      ``,
      proposal.primary_tour
        ? `Рекомендован тур: <b>${escHtml(proposal.primary_tour.title)}</b> — ${proposal.primary_tour.price.toLocaleString('ru-RU')} руб/чел`
        : 'Подходящих туров не найдено',
    ].filter(Boolean);

    const text = [
      `AI обработал лид: <b>${escHtml(leadName)}</b>`,
      ``,
      `<b>${escHtml(proposal.headline)}</b>`,
      ``,
      ...common,
      ``,
      `<i>${escHtml(proposal.intent.qualification_notes)}</i>`,
      ``,
      `<code>${leadId}</code>`,
    ].join('\n');

    const stub = [
      `AI обработал заявку <code>${leadId}</code>`,
      ``,
      ...common,
      ``,
      'Имя и заголовок предложения — в MAX и в кабинете.',
    ].join('\n');

    const res = await sendPdAlert({
      text,
      stub,
      buttons: [
        { text: 'Связался', payload: `lead_contacted:${leadId}` },
        { text: 'Квалифицирован', payload: `lead_qualified:${leadId}` },
        { text: 'Конвертирован', payload: `lead_converted:${leadId}` },
        { text: 'Открыть лид', url: `${baseUrl}/hub/operator/leads/${leadId}` },
      ],
    });
    if (!res.delivered) {
      console.error(`[autoProcessLead] уведомление с ПД не доставлено: ${res.channel} — ${res.reason}`);
    }

    // Планируем follow-up напоминания (fire-and-forget)
    void scheduleFollowups(leadId, leadName, proposal.ai_score);

  } catch (err) {
    // Туриста отказ не касается — ответ ему уже ушёл. Но разбор лида —
    // единственный путь коммерции до сезона, и пустой catch выдавал отказ
    // всего конвейера (квалификация, подбор, уведомление) за «лид создан»
    // (аудит 15.10, P4-03, п. 1.12): ловить можно, молчать нельзя (§4.0).
    // Заявка на машину — не отказ, а решение не подбирать тур: процессор
    // записал его в журнал заявки (skipped_vehicle_order), будить лог нечем.
    if (err instanceof LeadIsVehicleOrderError) return;
    logSwallowedFailure('leads', `AI-разбор заявки ${leadId}`, err);
  }
}

// ── Follow-up расписание: Day+1, Day+2, Day+5 ────────────────────────────────
async function scheduleFollowups(
  leadId: string,
  leadName: string,
  aiScore: number,
): Promise<void> {
  const urgencyDays = aiScore >= 70 ? [1, 2, 4] : [1, 3, 7]; // горячие лиды — чаще
  const types = ['day1', 'day2', 'day5'] as const;

  const messages = [
    `Первый follow-up: ${leadName} оставил заявку вчера. Скор ${aiScore}/100. Позвоните сегодня.`,
    `Второй follow-up: ${leadName} ждёт уже ${urgencyDays[1]} дня. Не упустите клиента.`,
    `Последний шанс: ${leadName} — заявка без ответа ${urgencyDays[2]} дней. Закройте или отметьте как отказ.`,
  ];

  const now = new Date();
  for (let i = 0; i < 3; i++) {
    const scheduledAt = new Date(now.getTime() + urgencyDays[i] * 24 * 60 * 60 * 1000);
    await pool.query(
      `INSERT INTO lead_followups (lead_id, followup_type, scheduled_at, message_text)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [leadId, types[i], scheduledAt.toISOString(), messages[i]]
    ).catch(() => {});
  }
}
