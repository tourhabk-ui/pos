/**
 * Сторож доставки ключа брони (#1889).
 *
 * ── Что случилось ─────────────────────────────────────────────────────────
 *
 * `operator_bookings.access_token` (миграция 943) выдаётся ОДИН раз и живёт
 * только в ссылке `?t=`. Это сделано намеренно: `id` у брони BIGSERIAL, и до
 * ключа перебор 1, 2, 3 отдавал имя туриста, дату и статус оплаты чужой
 * заявки, а вместе с ними PDF с чужими телефоном и почтой.
 *
 * Цена намеренного решения — у ключа обязан быть носитель. Носитель был
 * ОДИН: письмо, и только когда почта есть. Перепись клиентов
 * `POST /api/hub/bookings/create` 14.09 показала, что двое не доставляли
 * ключ НИКУДА — они читали из ответа только `id` (или только `error`), а
 * остальное выбрасывали:
 *
 *   `/p/[code]`       — поля почты в форме нет вовсе, то есть письма не было
 *                       никогда: доступ терялся ВСЕГДА, а не в краевом случае;
 *   `/kuzmich` (web)  — вдобавок писал «проверьте детали на странице
 *                       бронирования» про страницу, ключ от которой выкинул.
 *
 * ── Что держит этот сторож ────────────────────────────────────────────────
 *
 * Связку, а не половину (правило 10.09): у каждого клиента эндпоинта обязан
 * быть НАЗВАННЫЙ носитель ключа, и новый клиент, не внесённый в реестр,
 * краснеет. Молчание не ответ: клиент, про который ничего не сказано, — это
 * ровно тот случай, который уже стоил двум поверхностям потери доступа.
 *
 * Реестр самоустаревающий в обе стороны: исчез клиент — тест требует убрать
 * запись, появился — требует внести и назвать способ.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

// `-c color.ui=false` — общее правило вызовов git из тестов: без него вывод
// приходит с ANSI-кодами и пути не совпадают со строками.
function git(...args: string[]): string {
  return execFileSync('git', ['-c', 'color.ui=false', ...args], {
    cwd: ROOT, encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024,
  });
}

/** Исходник без комментариев: иначе упоминание пути в шапке считается вызовом. */
function code(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}

const ENDPOINT = '/api/hub/bookings/create';

/**
 * Чем клиент доставляет ключ туристу. Значение — не ярлык, а то, что
 * проверяется ниже по коду самого файла.
 */
type Carrier =
  /** Уводит на `/booking-success/<id>?t=<ключ>` — ключ остаётся в адресе. */
  | 'redirect'
  /** Показывает ссылку с ключом прямо на экране (BookingAccessLink). */
  | 'on-screen';

const CLIENTS: Record<string, Carrier> = {
  'components/marketplace/BookingFormClient.tsx':        'redirect',
  'app/hub/tourist/cart/checkout/_CheckoutClient.tsx':   'redirect',
  'app/kuzmich/_KuzmichClient.tsx':                      'on-screen',
  'app/p/[code]/_SelectionClient.tsx':                   'on-screen',
  'components/kuzmich/KuzmichWidget.tsx':                'on-screen',
};

/** Файлы репозитория, которые реально зовут эндпоинт (а не упоминают в тексте). */
function findClients(): string[] {
  const files = git('ls-files', '*.ts', '*.tsx').split('\n').filter(Boolean);
  return files.filter((f) => {
    if (f === 'app/api/hub/bookings/create/route.ts') return false;
    if (f.startsWith('tests/')) return false;
    let src: string;
    try { src = code(f); } catch { return false; }
    // ВЫЗОВ, а не упоминание. Путь в кавычках сам по себе не годится: его
    // держат и реестры — список публичных роутов (`lib/auth/public-api-routes.ts`)
    // и перепись брошенных попыток (`app/api/cron/booking-attempts`). Ключ им
    // не нужен: они не создают бронь и ответа не читают.
    return new RegExp(`fetch\\(\\s*['"\`]${ENDPOINT.replace(/\//g, '\\/')}['"\`]`).test(src);
  });
}

describe('реестр клиентов эндпоинта полон', () => {
  const found = findClients();

  it('каждый вызывающий файл назван в реестре', () => {
    const unknown = found.filter((f) => !(f in CLIENTS));
    expect(unknown, `новый клиент ${ENDPOINT} без названного носителя ключа`).toEqual([]);
  });

  it('в реестре нет исчезнувших файлов', () => {
    const stale = Object.keys(CLIENTS).filter((f) => !found.includes(f));
    expect(stale, 'запись в реестре пережила свой файл').toEqual([]);
  });

  it('клиентов не меньше, чем известно на 14.09', () => {
    // Падение числа само по себе не ошибка, но требует взгляда: клиент мог
    // исчезнуть, а мог перестать опознаваться этим поиском.
    expect(found.length).toBeGreaterThanOrEqual(5);
  });
});

describe('каждый клиент читает ключ из ответа и доносит его', () => {
  for (const [file, carrier] of Object.entries(CLIENTS)) {
    it(`${file} — ${carrier}`, () => {
      const src = code(file);

      // Общее для обоих носителей: ключ обязан быть ПРОЧИТАН из ответа.
      // Именно этого не делали `/p/[code]` и `/kuzmich`.
      expect(src, 'ключ не читается из ответа эндпоинта').toMatch(/access_token/);

      if (carrier === 'redirect') {
        // Ключ уходит в адрес страницы подтверждения.
        expect(src).toMatch(/booking-success\/\$\{[^}]+\}\?t=/);
      } else {
        // Ключ показывается человеку общим блоком — своей копии текста
        // «сохраните ссылку» быть не должно: копии расходятся.
        expect(src).toMatch(/BookingAccessLink/);
      }
    });
  }
});

describe('блок ссылки не выдумывает ссылку, когда ключа нет', () => {
  const BLOCK = code('components/bookings/BookingAccessLink.tsx');

  it('без ключа не рисуется вовсе', () => {
    // Ссылка без `?t=` отвечает 404 и учит туриста, что ссылки платформы не
    // работают. Пустой блок честнее (§4.0).
    expect(BLOCK).toMatch(/if \(!accessToken\) return null;/);
  });

  it('ключ уходит в адрес закодированным', () => {
    expect(BLOCK).toMatch(/encodeURIComponent\(accessToken\)/);
  });
});

describe('второй носитель ключа — канал, который турист выбрал сам', () => {
  const NOTIFY = code('lib/telegram/booking-notify.ts');
  const CREATE = code('app/api/hub/bookings/create/route.ts');

  it('сообщение о созданной брони несёт ссылку с ключом', () => {
    const fn = NOTIFY.slice(NOTIFY.indexOf('export function notifyTouristBookingCreated'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toMatch(/booking-success\/\$\{booking\.id\}\?t=/);
    expect(body).toMatch(/encodeURIComponent\(booking\.accessToken\)/);
  });

  it('ключа нет — ссылки нет, а не ссылка с пустым `t=`', () => {
    const fn = NOTIFY.slice(NOTIFY.indexOf('export function notifyTouristBookingCreated'));
    expect(fn.slice(0, fn.indexOf('\n}\n'))).toMatch(/booking\.accessToken\s*\n?\s*\?/);
  });

  it('роут действительно передаёт ключ в уведомление', () => {
    // Поле, объявленное в типе и не переданное вызывающим, — то самое
    // «объявление без источника» (правило 10.09): тип обещает доставку,
    // которой нет.
    const call = CREATE.slice(CREATE.indexOf('notifyTouristBookingCreated('));
    expect(call.slice(0, 600)).toMatch(/accessToken:\s*result\.accessToken/);
  });

  it('персональные данные в зарубежный канал по-прежнему не идут', () => {
    // Ключ — не ПД; телефон и почта туриста в сообщение не добавлялись и не
    // должны (см. notifyTouristDocumentExpiring в том же файле).
    const fn = NOTIFY.slice(NOTIFY.indexOf('export function notifyTouristBookingCreated'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).not.toMatch(/touristPhone|touristEmail|tourist_phone|tourist_email/);
  });
});
