/**
 * Точка — приём оплаты по QR-коду СБП.
 * Документация: https://developers.tochka.com/docs/tochka-api/
 *
 * ПЕРЕПИСАНО 23.08.2026 после сверки с песочницей Точки. Прежняя версия не
 * работала целиком, и это не гипотеза: каждый пункт ниже — ответ живого
 * сервера, снятый с раннера (пробы 109-121).
 *
 * 1. АВТОРИЗАЦИЯ БЫЛА НЕ ТА. Код ходил за токеном по `client_credentials` на
 *    /connect/token. У Точки способов два, и они для разных случаев:
 *      — JWT-ключ: «самый быстрый путь, если интеграция нужна только вашей
 *        компании». Ключ генерируется в интернет-банке ОДИН раз и дальше
 *        просто кладётся в заголовок. Это наш случай.
 *      — OAuth 2.0: «нужен, если вы делаете сервис для других компаний и
 *        обращаетесь к API от их имени», и это не два поля, а три запроса с
 *        согласием клиента (consent_id) и обменом кода.
 *    То есть мы просили у банка поток, предназначенный для чужих клиентов,
 *    вдвое сложнее нужного, и всё равно не тем способом. Теперь — один
 *    статический ключ.
 *
 * 2. АДРЕСА БЫЛИ НЕ ТЕ. Проверено песочницей поимённо:
 *      выпуск QR   .../qr-code/merchant/{m}/account/{a} → 400 «Field accountId
 *                  : Value error, invalid»
 *                  .../qr-code/merchant/{m}/{a}         → 200, настоящий qrcId
 *      статус      .../qr-code/merchant/{m}/payment-status/{qr} → 501 Not
 *                  Implemented
 *                  .../qr-codes/{qrcIds}/payment-status → 200, и Links.self
 *                  сам называет боевой адрес
 *    Лишнее слово `account` в пути и устаревший метод статуса — две причины,
 *    по которым оплата не прошла бы, даже будь переменные заведены.
 *
 * 3. ФОРМЫ ОТВЕТОВ БЫЛИ НЕ ТЕ. Точка заворачивает всё в конверт `Data`, а
 *    прежний разбор читал поля с корня: `data.image.content` на живом ответе
 *    дал бы TypeError, то есть функция вернула бы null при успешном выпуске
 *    QR. Статус приходит СПИСКОМ `Data.paymentList[]` — метод спрашивает
 *    сразу несколько QR, — а читался как один объект.
 *
 * ЧТО ОСТАЛОСЬ НЕИЗВЕСТНЫМ И ПОЧЕМУ ЭТО НЕ ЗАКРЫТО ДОГАДКОЙ. Какое значение
 * `status` означает «оплачено». Песочница отдаёт заготовленные ответы и в них
 * встречаются только `NotStarted` и `InProgress`; машинной спецификации у неё
 * нет (501 и 404), страницы методов рисуются скриптом. Придумать значение
 * здесь — худшее, что можно сделать: ошибись в одну сторону, и бронь
 * подтвердится без денег; ошибись в другую — деньги придут, а бронь останется
 * неоплаченной. Поэтому знание разделено на три состояния (CLAUDE.md §4.0):
 * известные «ещё не оплачено», известные отказы и ВСЁ ОСТАЛЬНОЕ — «не
 * выяснили». Последнее возвращается как `null`, а `null` у нас уже означает
 * «спросить банк не удалось»: приёмник просит повтор вебхука и ничего не
 * подтверждает. Заодно неизвестное значение пишется в лог дословно — первая
 * же настоящая оплата назовёт его сама, и тогда оно вносится в PAID_STATUSES
 * как факт, а не как предположение.
 *
 * ПЕСОЧНИЦА. `TOCHKA_SANDBOX=1` переключает базовый адрес и токен на
 * опубликованные тестовые. Ответы там фиксированные и от параметров не
 * зависят: песочница доказывает ФОРМУ запроса и существование адреса, но
 * никогда — оплату. Ею проверяется интеграция, не деньги.
 *
 * Переменные окружения (Timeweb):
 *   TOCHKA_JWT_TOKEN   — ключ из интернет-банка, раздел «Интеграции и API»
 *   TOCHKA_MERCHANT_ID — ID торговой точки в СБП
 *   TOCHKA_ACCOUNT_ID  — счёт и БИК одной строкой: "40702810XXXXXXXXXX/044525104"
 *   TOCHKA_SANDBOX     — «1» переключает на песочницу (тогда первые три не нужны)
 */

const PROD_BASE = 'https://enter.tochka.com/uapi';
/** Песочница: адрес и токен опубликованы в документации, общие для всех. */
const SANDBOX_BASE = 'https://enter.tochka.com/sandbox/v2';
const SANDBOX_TOKEN = 'sandbox.jwt.token';
const SANDBOX_MERCHANT = '200000000001097';
const SANDBOX_ACCOUNT = '12345123451234512345/044525104';

function isSandbox(): boolean {
  return process.env.TOCHKA_SANDBOX === '1';
}

function baseUrl(): string {
  return isSandbox() ? SANDBOX_BASE : PROD_BASE;
}

/**
 * Ключ доступа. В отличие от прежней версии здесь нет ни запроса за токеном,
 * ни кэша с истечением: JWT-ключ статический, живёт в переменной окружения и
 * обновляется человеком в интернет-банке.
 */
function accessToken(): string | null {
  if (isSandbox()) return SANDBOX_TOKEN;
  const token = process.env.TOCHKA_JWT_TOKEN;
  if (!token) {
    console.error('[tochka] TOCHKA_JWT_TOKEN не задан: ключ генерируется в интернет-банке');
    return null;
  }
  return token;
}

function merchantId(): string | null {
  return isSandbox() ? SANDBOX_MERCHANT : (process.env.TOCHKA_MERCHANT_ID ?? null);
}

function accountId(): string | null {
  return isSandbox() ? SANDBOX_ACCOUNT : (process.env.TOCHKA_ACCOUNT_ID ?? null);
}

// ── Типы ───────────────────────────────────────────────────────────

export interface TochkaQRResult {
  qrId:      string;   // qrcId — им же приходит вебхук
  qrCode:    string;   // base64 PNG
  qrLink:    string;   // ссылка qr.nspk.ru для открытия в приложении банка
  payload:   string;   // строка СБП
  expiresAt: Date;
}

export interface TochkaPaymentStatus {
  qrId:    string;
  status:  'pending' | 'paid' | 'expired' | 'cancelled';
  /** Значение банка дословно. Нужно, чтобы разбор расхождений не гадал. */
  raw:     string;
  amount?: number;
  paidAt?: Date;
}

/** Конверт, в который Точка заворачивает ЛЮБОЙ успешный ответ. */
interface Envelope<T> { Data?: T }

// ── Общий запрос ───────────────────────────────────────────────────

/**
 * Один вызов к API. Тело ошибки печатается ЦЕЛИКОМ и намеренно: у Точки в нём
 * лежит имя поля, на котором запрос не прошёл («Field accountId : Value error»),
 * и это единственный способ узнать форму запроса, которого нет в открытой
 * документации. Обрезанное сообщение стоило бы дня разбора.
 */
async function call<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T | null> {
  const token = accessToken();
  if (!token) return null;

  try {
    const res = await fetch(`${baseUrl()}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`[tochka] ${method} ${path} → ${res.status}: ${err}`);
      return null;
    }

    const json = await res.json() as Envelope<T>;
    if (!json?.Data) {
      // Двухсотый без конверта — не успех, а неузнанный ответ. Молча вернуть
      // undefined значило бы выдать непонимание за отсутствие данных.
      console.error(`[tochka] ${method} ${path}: ответ 200 без конверта Data`);
      return null;
    }
    return json.Data;
  } catch (err) {
    console.error(`[tochka] ${method} ${path} не выполнен:`,
      err instanceof Error ? err.message : err);
    return null;
  }
}

// ── Выпуск QR ──────────────────────────────────────────────────────

interface QrRegisterResponse {
  qrcId:    string;
  payload:  string;
  image?:   { content?: string };
}

/**
 * Динамический QR на сумму брони.
 *
 * ФОРМА ТЕЛА НЕ ПОДТВЕРЖДЕНА. Песочница отдаёт заготовленный ответ независимо
 * от того, что послано, поэтому её «200» доказывает адрес, но не имена полей.
 * Имена ниже — из документации по памяти, и это записано вслух, чтобы никто не
 * принял их за проверенные. Ошибка здесь безопасна и самодиагностируема: Точка
 * ответит 400 и НАЗОВЁТ поле, а тело ошибки печатается целиком (см. `call`).
 * Это ровно противоположно ошибке в словаре статусов, которая была бы тихой.
 */
export async function createSBPQR(opts: {
  amountRub:   number;
  description: string;
  ttlMinutes?: number;
  bookingId?:  number;
}): Promise<TochkaQRResult | null> {
  const merchant = merchantId();
  const account  = accountId();
  if (!merchant || !account) {
    console.error('[tochka] TOCHKA_MERCHANT_ID / TOCHKA_ACCOUNT_ID не заданы');
    return null;
  }

  const ttl = opts.ttlMinutes ?? 60;

  // Слова `account` в пути НЕТ. С ним песочница отвечает 400 «Field accountId
  // : Value error, invalid» — лишний сегмент съедает значение параметра.
  const path = `/sbp/v1.0/qr-code/merchant/${encodeURIComponent(merchant)}/${encodeURIComponent(account)}`;

  const data = await call<QrRegisterResponse>('POST', path, {
    Data: {
      amount:         Math.round(opts.amountRub * 100), // копейки
      currency:       'RUB',
      paymentPurpose: opts.description.slice(0, 140),
      qrcType:        '02',                             // динамический
      ttl,
      ...(opts.bookingId ? { sourceName: String(opts.bookingId) } : {}),
    },
  });

  if (!data?.qrcId || !data.payload) {
    if (data) console.error('[tochka] выпуск QR: в ответе нет qrcId или payload');
    return null;
  }

  // Картинка необязательна: QR можно построить из payload на нашей стороне.
  // Отсутствие изображения — не повод терять уже выпущенный QR.
  const image = data.image?.content ?? '';
  if (!image) console.error(`[tochka] выпуск QR ${data.qrcId}: банк не вернул изображение`);

  return {
    qrId:      data.qrcId,
    qrCode:    image,
    qrLink:    `https://qr.nspk.ru/${data.qrcId}`,
    payload:   data.payload,
    expiresAt: new Date(Date.now() + ttl * 60 * 1000),
  };
}

// ── Статус платежа ─────────────────────────────────────────────────

interface PaymentStatusItem {
  qrcId:    string;
  code?:    string;
  status?:  string;
  message?: string;
  trxId?:   string;
}

/**
 * Словари статусов. Здесь только то, что ВИДЕЛИ, и ничего сверх.
 *
 * `PAID_STATUSES` пуст намеренно и это не забывчивость: значение, означающее
 * «оплачено», нам неизвестно (см. шапку файла). Пустой список честнее
 * правдоподобного: он не подтвердит бронь без денег, а неизвестное значение
 * уйдёт в «не выяснили» и в лог. Пополнять его можно только фактом — строкой,
 * пришедшей от банка при настоящей оплате, или строкой из документации,
 * прочитанной глазами.
 */
const PAID_STATUSES = new Set<string>();
/** Платёж ещё не состоялся. Эти два значения отдаёт песочница. */
const PENDING_STATUSES = new Set(['NotStarted', 'InProgress']);
/** QR с таким идентификатором банк не знает. */
const NOT_FOUND_CODE = 'RQ05014';

/**
 * Статус оплаты по QR.
 *
 * `null` означает «не выяснили» — это же значение возвращается при недоступном
 * банке, и приёмник вебхука уже трактует его как «просить повтор». Три случая
 * приводят сюда: банк не ответил, QR ему неизвестен, статус не опознан. Ни в
 * одном из них нельзя сказать «не оплачено».
 */
export async function getSBPPaymentStatus(qrId: string): Promise<TochkaPaymentStatus | null> {
  // Метод спрашивает сразу НЕСКОЛЬКО QR и возвращает список — прежняя версия
  // читала его как один объект.
  const path = `/sbp/v1.0/qr-codes/${encodeURIComponent(qrId)}/payment-status`;
  const data = await call<{ paymentList?: PaymentStatusItem[] }>('GET', path);
  if (!data) return null;

  const list = Array.isArray(data.paymentList) ? data.paymentList : [];
  // Спрашивали про один QR, но отвечают списком: берём СВОЙ, а не первый.
  const item = list.find((p) => p.qrcId === qrId) ?? (list.length === 1 ? list[0] : undefined);

  if (!item) {
    console.error(`[tochka] статус ${qrId}: банк не вернул строку по этому QR (строк: ${list.length})`);
    return null;
  }

  if (item.code === NOT_FOUND_CODE) {
    console.error(`[tochka] статус ${qrId}: банк не знает такой QR — ${item.message ?? ''}`);
    return null;
  }

  const raw = (item.status ?? '').trim();

  if (PAID_STATUSES.has(raw)) {
    return { qrId, status: 'paid', raw };
  }
  if (PENDING_STATUSES.has(raw)) {
    return { qrId, status: 'pending', raw };
  }

  // Третье состояние. Значение банка идёт в лог ДОСЛОВНО: это единственный
  // способ узнать словарь, которого нет ни в песочнице, ни в открытой
  // документации. Увидев его здесь — вносим в PAID_STATUSES или в
  // PENDING_STATUSES как факт.
  console.error(
    `[tochka] статус ${qrId}: значение «${raw || 'пусто'}» не опознано — считаем НЕ ВЫЯСНЕННЫМ, ` +
    `не «не оплачено». Внести в словарь lib/payments/tochka.ts после проверки.`,
  );
  return null;
}

// ── Готовность к работе ────────────────────────────────────────────

/**
 * Есть ли чем работать. Полей стало три вместо четырёх: пара
 * client_id/client_secret ушла вместе с потоком OAuth, который был не для
 * нашего случая.
 */
export function isTochkaConfigured(): boolean {
  if (isSandbox()) return true;
  return Boolean(
    process.env.TOCHKA_JWT_TOKEN &&
    process.env.TOCHKA_MERCHANT_ID &&
    process.env.TOCHKA_ACCOUNT_ID,
  );
}

/** Чего именно не хватает — для страницы здоровья, чтобы не гадать по 503. */
export function tochkaMissingEnv(): string[] {
  if (isSandbox()) return [];
  return ['TOCHKA_JWT_TOKEN', 'TOCHKA_MERCHANT_ID', 'TOCHKA_ACCOUNT_ID']
    .filter((k) => !process.env[k]);
}
