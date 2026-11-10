import { NextRequest, NextResponse } from 'next/server';
import { kamchatkaWallTime } from '@/lib/safety/checkin-escalation';
import { kamchatkaDate } from '@/lib/analytics/kamchatka-day';
import { createRateLimiter, getClientIp } from '@/lib/rate-limit';
import { z } from 'zod';
import { createTripWatchOnce, submitKeyHash } from '@/lib/safety/trip-watch';
import { verifyAuth } from '@/lib/auth';
import { generateMchsStatementPDF } from '@/lib/pdf/mchs-statement';
import { SUBMIT_KEY, TELEGRAM_CHAT_ID } from '@/lib/safety/register-submit';

export const dynamic = 'force-dynamic';

/** День существует в календаре: «2031-02-30» по виду дата, а базе не годится. */
function isRealDay(ymd: string): boolean {
  const d = new Date(`${ymd}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === ymd;
}
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isRealDay, 'Такой даты нет в календаре');

const RegistrationSchema = z.object({
  route_name: z.string().min(1).max(200),
  route_description: z.string().max(2000).optional(),
  start_date: Day,
  end_date: Day,
  expected_return_time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  region: z.string().max(200).default('Камчатский край'),
  group_size: z.number().int().min(1).max(30),
  group_members: z.array(z.object({
    name: z.string().max(120),
    phone: z.string().max(30).optional(),
    birth_year: z.number().int().optional(),
  })).max(30, 'В составе группы не больше 30 человек').optional(),
  leader_name: z.string().min(1).max(120),
  leader_phone: z.string().min(5).max(30),
  leader_email: z.string().email().optional().or(z.literal('')),
  emergency_contact_name: z.string().min(1).max(120),
  emergency_contact_phone: z.string().min(5).max(30),
  emergency_contact_relation: z.string().max(60).optional(),
  // Колонка — bigint. Имя с «@» раньше доходило до базы и возвращалось пустой
  // ошибкой; повтор не помогал никогда, а поле не называлось.
  emergency_contact_telegram_chat_id: z.string()
    .regex(TELEGRAM_CHAT_ID, 'Telegram chat_id — только цифры. Не знаете его — оставьте поле пустым.')
    .optional(),
  emergency_contact_email: z.string().email().optional().or(z.literal('')),
  emergency_contact_consent: z.boolean().default(false),
  accepted_disclaimer: z.literal(true, {
    message: 'Необходимо принять условия',
  }),
  // Ключ повтора: по нему, а не по одним данным, форма узнаёт свою запись
  // (lib/safety/trip-watch, SAME_OPEN_WATCH_SQL). Старая форма его не шлёт.
  submit_key: z.string().regex(SUBMIT_KEY, 'Ключ формы записан не по форме — обновите страницу и отправьте снова.').optional(),
});

/**
 * POST /api/safety/register
 *
 * Без `?pdf` — включает контроль возвращения и отвечает номером записи.
 * С `?pdf` (или `Accept: application/pdf`) — только собирает лист с данными
 * группы из тела запроса и НИЧЕГО не записывает.
 *
 * До 10.11 запись создавалась на любой запрос, а форма слала их два — на один
 * выход выходило два контроля, и второй никто не закрывал
 * (docs/safety/MCHS_PLAN.md, С1). Повтор той же формы теперь узнаёт свою
 * запись: `createTripWatchOnce`. Своя — по входу в аккаунт или по ключу
 * повтора `submit_key`; одних совпавших данных мало, иначе номер чужой записи
 * получил бы всякий, кто знает её поля.
 */
// Регистрация открыта без входа — предел на адрес, иначе поток выдуманных
// контролей завалил бы дежурного тревогами.
const limiter = createRateLimiter({ windowMs: 60_000, max: 5 });

export async function POST(request: NextRequest) {
  if (!limiter.check(getClientIp(request.headers))) {
    return NextResponse.json({ success: false, error: 'Слишком часто — подождите минуту' }, { status: 429 });
  }
  const auth = await verifyAuth(request).catch(() => ({
    isAuthenticated: false,
    userId: null,
    role: null,
  }));
  const userId = auth.isAuthenticated ? auth.userId : null;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const validation = RegistrationSchema.safeParse(rawBody);
  if (!validation.success) {
    return NextResponse.json(
      { success: false, error: validation.error.issues[0]?.message },
      { status: 400 }
    );
  }

  const data = validation.data;

  // Срок в прошлом — это не контроль, а мгновенная МЧС-тревога дежурному:
  // сто таких запросов за минуту ослепляли сторожа (разбор противником, 30.09).
  const today = kamchatkaDate(new Date());
  if (data.end_date < today || data.start_date > data.end_date) {
    return NextResponse.json(
      { success: false, error: 'Проверьте даты: окончание не раньше сегодняшнего дня и не раньше начала.' },
      { status: 400 },
    );
  }

  // Лист с данными — без записи. Проверки выше общие: лист на прошедшие даты
  // так же не нужен, как контроль на них.
  const acceptHeader = request.headers.get('accept') || '';
  const wantPdf = acceptHeader.includes('application/pdf') ||
    request.nextUrl.searchParams.has('pdf');

  if (wantPdf) {
    const pdfBuffer = await generateMchsStatementPDF({
      routeName: data.route_name,
      routeDescription: data.route_description ?? null,
      region: data.region,
      startDate: data.start_date,
      endDate: data.end_date,
      leaderName: data.leader_name,
      leaderPhone: data.leader_phone,
      leaderEmail: data.leader_email || null,
      groupSize: data.group_size,
      members: (data.group_members ?? []).filter((m) => m.name.trim()),
      contactName: data.emergency_contact_name,
      contactPhone: data.emergency_contact_phone,
      contactRelation: data.emergency_contact_relation ?? null,
    });
    // Uint8Array: с TS 5.9 Buffer не проходит в BodyInit без каста.
    return new NextResponse(new Uint8Array(pdfBuffer), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'attachment; filename="vedar-mchs-dannye-gruppy.pdf"',
      },
    });
  }

  // Сохраняем в БД
  // Строим expected_return_at из end_date + expected_return_time (если задано)
  // Время на стене — камчатское: без явного пояса `new Date('…T19:00:00')`
  // читался по часам Node (UTC) и отодвигал тревогу на 12 часов (30.09).
  const expectedReturnAt = data.expected_return_time
    ? kamchatkaWallTime(data.end_date, data.expected_return_time)
    : null;

  // Одна запись на все пути создания — lib/safety/trip-watch.ts (манифест, правило 1).
  // И одна запись на выход: повтор той же формы возвращает прежний номер.
  let registrationId: string;
  try {
    const watch = await createTripWatchOnce({
      source: 'form',
      userId,
      routeName: data.route_name,
      routeDescription: data.route_description ?? null,
      startDate: data.start_date,
      endDate: data.end_date,
      expectedReturnAt,
      region: data.region,
      groupSize: data.group_size,
      groupMembers: data.group_members ?? null,
      leaderName: data.leader_name,
      leaderPhone: data.leader_phone,
      leaderEmail: data.leader_email || null,
      contactName: data.emergency_contact_name,
      contactPhone: data.emergency_contact_phone,
      contactRelation: data.emergency_contact_relation ?? null,
      contactTelegramChatId: data.emergency_contact_telegram_chat_id || null,
      contactEmail: data.emergency_contact_email || null,
      contactConsent: data.emergency_contact_consent,
      touristChat: null,
      submitKeyHash: data.submit_key ? submitKeyHash(data.submit_key) : null,
    });
    registrationId = watch.id;
  } catch (err) {
    // Контроль НЕ включён — и человек обязан это услышать словами, а не
    // пустым 500, который форма читала как «ошибка сети».
    const e = err as { code?: string; message?: string };
    const code = typeof e.code === 'string' ? e.code : '';
    // В лог — код базы; без него — род отказа, а не текст: в тексте ошибки
    // базы бывает введённое человеком значение.
    const kind = code || (/timeout exceeded when trying to connect/i.test(e.message ?? '') ? 'нет свободного соединения' : 'нет SQLSTATE');
    console.error('[safety/register] контроль не записан:', kind);
    // Класс 22 — база не приняла значение поля. Это не наш сбой, и повтор его
    // не вылечит: сказать «повторите через минуту» значило бы соврать о лекарстве.
    if (code.startsWith('22')) {
      return NextResponse.json(
        { success: false, error: 'Контроль возвращения не включён: одно из полей записано в непригодном виде. Проверьте даты и числа и отправьте снова.' },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { success: false, error: 'Контроль возвращения не включён: сбой на нашей стороне. Повторите через минуту.' },
      { status: 503 },
    );
  }

  return NextResponse.json({
    success: true,
    registration_id: registrationId,
    message: 'Контроль возвращения включён. Заявку в МЧС подаёте вы — Ведар её не отправляет.',
  });
}
