/**
 * POST /api/partner-applications — заявка на подключение со страницы /partner.
 *
 * Слово владельца (23.10): «давай сделаем форму принятия заявки на
 * подключение … я опубликую в истории в тг … для потенциальных партнеров кто
 * в турбизнесе».
 *
 * Пишем в partner_prospects (миграция 816): у заявителя нет ни партнёра, ни
 * аккаунта, а operator_applications требует оба. По той же причине нет и
 * записи в crm_events — там partner_id NOT NULL. Заявка — заметка отдела
 * продаж, договорённость подтверждает человек.
 *
 * ПД (контактное лицо, телефон) уходят только в MAX через sendPdAlert;
 * в Telegram — заглушка без ПД.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/database';
import { createRateLimiter, getTrustedClientIp } from '@/lib/rate-limit';
import { buildConsentRecord } from '@/lib/legal/pd-consent';
import { sendPdAlert } from '@/lib/notifications/pd-alert';
import { getPublicBaseUrl } from '@/lib/config';
import { BUSINESS_TYPES, BUSINESS_TYPE_KEYS } from '@/lib/partners/application';

export const dynamic = 'force-dynamic';

const limiter = createRateLimiter({ windowMs: 10 * 60_000, max: 3 });


const Schema = z.object({
  company: z.string().trim().min(2, 'Укажите название').max(200),
  business_type: z.enum(BUSINESS_TYPE_KEYS, { message: 'Выберите вид деятельности' }),
  contact_name: z.string().trim().min(2, 'Укажите контактное лицо').max(120),
  contact: z.string().trim().min(5, 'Укажите телефон, MAX или Telegram').max(120),
  wants: z.string().trim().max(1000).optional(),
  utm: z.record(z.string(), z.string().max(100)).optional(),
  website: z.string().max(200).optional(), // honeypot
  pd_consent: z.literal(true, { message: 'Необходимо согласие на обработку персональных данных' }),
});

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function POST(req: NextRequest) {
  const ip = getTrustedClientIp(req.headers);
  if (!limiter.check(ip)) {
    return NextResponse.json({ success: false, error: 'Слишком много заявок. Попробуйте позже.' }, { status: 429 });
  }
  const body = await req.json().catch(() => null);
  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message ?? 'Проверьте поля' }, { status: 422 });
  }
  const d = parsed.data;
  // Бот заполнил скрытое поле — отвечаем «принято», ничего не пишем.
  if (d.website) return NextResponse.json({ success: true });

  const utm = Object.fromEntries(
    Object.entries(d.utm ?? {}).filter(([k]) => /^utm_(source|medium|campaign|content|term)$/.test(k)),
  );
  // Пометка теста: utm_source=test. Такие заявки удаляются руками после проверки.
  const isTest = utm.utm_source === 'test';
  const application = {
    at: new Date().toISOString(),
    business_type: d.business_type,
    contact_name: d.contact_name,
    contact: d.contact,
    wants: d.wants ?? null,
    utm,
    test: isTest,
    pd_consent: buildConsentRecord(true, ip, 'partner-form', 'partner-apply'),
  };

  let id: string;
  try {
    const res = await query<{ id: string; repeat: boolean }>(
      `INSERT INTO partner_prospects (name, source, details, status)
       VALUES ($1, 'Форма /partner', jsonb_build_object('applications', jsonb_build_array($2::jsonb)), 'new')
       ON CONFLICT (LOWER(name)) DO UPDATE
         SET details = jsonb_set(partner_prospects.details, '{applications}',
               COALESCE(partner_prospects.details->'applications', '[]'::jsonb) || jsonb_build_array($2::jsonb)),
             updated_at = NOW()
       RETURNING id::text, (xmax <> 0) AS repeat`,
      [d.company, JSON.stringify(application)],
    );
    id = res.rows[0].id;
  } catch (e) {
    console.error('[partner-applications] запись не удалась:', (e as { code?: string })?.code ?? e);
    return NextResponse.json({ success: false, error: 'Ошибка сервера. Попробуйте позже.' }, { status: 500 });
  }

  const type = BUSINESS_TYPES[d.business_type];
  const admin = `${getPublicBaseUrl()}/hub/admin/partner-applications`;
  const src = utm.utm_source ? ` · ${esc(utm.utm_source)}` : '';
  void sendPdAlert({
    text: [
      `<b>${isTest ? '[ТЕСТ] ' : ''}Заявка на подключение</b>`,
      `<b>${esc(d.company)}</b> — ${type}${src}`,
      `Контакт: ${esc(d.contact_name)}, ${esc(d.contact)}`,
      d.wants ? `Что подключить: ${esc(d.wants)}` : '',
    ].filter(Boolean).join('\n'),
    stub: `<b>${isTest ? '[ТЕСТ] ' : ''}Заявка на подключение</b>\n${type}${src}\nКонтакты — в MAX и в админке.`,
    buttons: [{ text: 'Открыть заявки', url: admin }],
  }).catch((e: unknown) => console.error('[partner-applications] уведомление:', e instanceof Error ? e.message : e));

  return NextResponse.json({ success: true, id }, { status: 201 });
}
