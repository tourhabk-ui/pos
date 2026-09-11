/**
 * Каждый, кто трогает статус брони, отвечает: возвращает ли он места.
 *
 * ── Чем это оплачено (#1816) ──────────────────────────────────────────────
 *
 * 11.09 счётчик `tour_availability.booked_slots` сделали двусторонним: до того
 * он умел только расти, и ОДНОГО цикла «дату выкупили — дату отменили»
 * хватало, чтобы эта дата тура больше не приняла ни одной оплаты (CHECK
 * `booked_valid` роняет транзакцию платежа изнутри).
 *
 * Первый заход подключил вычитание к ДВУМ путям — тем, что нашлись глазами.
 * Перепись нашла ещё один живой (`/api/operator/bookings/[id]`: отменял без
 * возврата мест, без `cancelled_at` и вообще без транзакции) и ЧЕТВЁРТУЮ,
 * ничейную реализацию отмены (`bookingService.cancel()`) с выдуманным
 * `refundAmount: 0` внутри. Правило, которое держится на том, что автор
 * вспомнил все места, ломается на пятом.
 *
 * Она же нашла и мою ошибку в обратную сторону: я подключил вычитание к
 * OCTO — и был неправ. Там контракт «счётчик не трогаем» заморожен отдельно и
 * раньше (#336, `octo-no-counter-writes`), потому что канал пишет ХОЛДЫ, а
 * счётчик несёт смысл «оплаченные участники». Вызов был холостым по
 * построению и молча переезжал чужое обдуманное решение; чужой сторож меня и
 * поймал. Посылка теперь не в памяти, а строкой в реестре — вместе с
 * условием, при котором её придётся пересмотреть.
 *
 * ── Почему реестр широкий, а не умный регексп ─────────────────────────────
 *
 * Первая версия этого сторожа искала писателей регекспом и МОЛЧА пропускала
 * два самых важных роута: `\$` внутри двойных кавычек доезжал до grep как
 * якорь конца строки, и `booking_status = $` не находилось нигде. Сторож при
 * этом был зелёным — то есть ровно тот дефект, ради которого он писался:
 * проверка, которая выглядит работающей и не работает.
 *
 * Вторая версия читала контекст `SET` — и пропускала уже другое: два роута
 * собирают `SET ${updateFields.join(', ')}` шаблоном, и слова
 * `booking_status` в тексте запроса нет вовсе.
 *
 * Оба промаха — один урок, записанный в CLAUDE.md ценой 42P08: **статикой
 * судить нельзя**. Поэтому сеть здесь нарочно широкая (файл трогает
 * `operator_bookings` и упоминает `booking_status`), а решение принимает
 * человек и записывает строкой. Лишняя запись стоит одной строки; пропущенный
 * писатель стоит мёртвой даты тура.
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (f: string) => readFileSync(join(ROOT, f), 'utf-8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

/**
 * Ответ каждого файла, который трогает статус брони.
 *
 * `releases` — зовёт вычитание, проверяется по коду.
 * Остальные — причина, почему вычитать нечего. Причина обязана быть
 * ПРОВЕРЯЕМОЙ по коду рядом, а не «кажется, тут не бывает оплаченных».
 */
const ANSWERS: Record<string, 'releases' | string> = {
  // ── Возвращают места ────────────────────────────────────────────────────
  'app/api/bookings/[id]/cancel/route.ts': 'releases',
  'app/api/hub/operator/bookings/[id]/route.ts': 'releases',
  'app/api/operator/bookings/[id]/route.ts': 'releases',
  // cancelBooking() здесь же чинит #1814 (писала в чужую таблицу bookings) и
  // сразу вызывает releaseSlotsForCancelledBooking — иначе фикс сам открыл бы
  // #1816 заново для этого пути (Telegram-кнопки оператора, /api/bookings/[id]).
  'lib/bookings/booking.service.ts': 'releases',

  // ── Пишут отмену, но вычитать нечего ────────────────────────────────────
  'app/api/cron/abandoned-bookings/route.ts':
    'отменяет только pending_payment при paid_at IS NULL и payment_status <> paid — счётчик наполняет платёжный вебхук, у неоплаченной брони в нём ничего нет',
  'app/api/cron/health/route.ts':
    'гасит истёкшие OCTO-холды в статусе new: по построению не были оплачены',
  'app/api/hub/operator/payments/webhook/route.ts':
    'handleFailed ставит cancelled при ОТКЛОНЁННОМ платеже — инкремента не было; инкремент в этом же файле идёт по успешной оплате и к отмене отношения не имеет',
  'lib/octo/service.ts':
    'канал пишет ХОЛДЫ, а счётчик несёт смысл «оплаченные участники»: инкремента на этих бронях нет по построению. Контракт заморожен отдельно и раньше — #336, сторож tests/unit/octo-no-counter-writes.test.ts. ' +
    'ПЕРЕСМОТРЕТЬ, если канальная бронь начнёт доходить до оплаты на нашей стороне: тогда инкремент появится, и вычитание станет обязательным',

  // ── Пишут статус, но никогда не отменённый ──────────────────────────────
  'app/api/payments/webhook/route.ts':
    'пишет только confirmed при успешной оплате (§7, не трогать)',
  'app/api/payments/tochka/webhook/route.ts': 'пишет только confirmed по оплате СБП',
  'app/api/payments/tochka/qr/route.ts': 'пишет pending_payment при выдаче QR',
  'app/api/octo/bookings/[uuid]/status/route.ts':
    'переводит confirmed → redeemed | no_show и проверяет это явно; отмену не пишет',

  // ── Статус только читают, а пишут другое ────────────────────────────────
  'app/api/cron/tour-review-request/route.ts': 'читает booking_status = completed в WHERE',
  'lib/agents/execution/initiative-executor.ts': 'читает booking_status = confirmed в WHERE',
  'app/api/cron/tour-reminder/route.ts':
    'пишет только флаг reminder_sent_24h; статус читает в отборе',
  'app/api/cron/payment-test-setup/route.ts':
    'снос обвязки проверки оплаты: пишет deleted_at служебным броням, статуса не меняет',

  // ── Ловушка на будущее, названная вслух ─────────────────────────────────
  'lib/services/tours/booking.service.ts':
    'СИРОТА: bookingService не импортирует никто, кроме барреля lib/services/index.ts. ' +
    'Его updateBooking умеет писать ЛЮБОЙ статус через COALESCE($2, booking_status), ' +
    'то есть и cancelled. Пока у сервиса нет потребителя, вычитать нечего; в день, ' +
    'когда его позовут, сюда обязан прийти releaseSlotsForCancelledBooking — иначе ' +
    'вернётся ровно #1816. Его cancel() уже удалён 11.09 как расходящийся дубль',
};

/** Широкая сеть: файл трогает брони И упоминает их статус. */
function statusTouchers(): string[] {
  return execSync(
    'grep -rl "operator_bookings" app lib --include=*.ts || true',
    { cwd: ROOT, encoding: 'utf-8' },
  ).trim().split('\n').filter(Boolean)
    .filter((f) => {
      const c = strip(read(f));
      return /UPDATE\s+operator_bookings/i.test(c) && /booking_status/.test(c);
    });
}

describe('отмена возвращает места — и это держит перепись, а не память', () => {
  it('каждый файл, трогающий статус брони, есть в реестре', () => {
    const files = statusTouchers();
    expect(files.length, 'перепись ничего не нашла — сломался сам поиск').toBeGreaterThan(8);

    const unanswered = files.filter((f) => !(f in ANSWERS));
    expect(
      unanswered,
      'Файл меняет брони и знает про booking_status, но не сказал, возвращает ли места.\n' +
      'Без вычитания счётчик booked_slots умеет только расти, и одного цикла ' +
      '«выкупили — отменили» хватает, чтобы дата тура перестала принимать оплату (#1816).\n' +
      'Внеси в ANSWERS: "releases" — если зовёт releaseSlotsForCancelledBooking, ' +
      `иначе причину, проверяемую по коду рядом.\n${unanswered.join('\n')}`,
    ).toEqual([]);
  });

  it('кто объявлен «releases» — действительно вычитает, и в чужой транзакции', () => {
    const broken: string[] = [];
    for (const [f, answer] of Object.entries(ANSWERS)) {
      if (answer !== 'releases') continue;
      const code = strip(read(f));
      if (!/releaseSlotsForCancelledBooking\(\s*client/.test(code)) {
        broken.push(`${f}: объявлен как возвращающий места, а вызова с client нет`);
      }
    }
    expect(broken, broken.join('\n')).toEqual([]);
  });

  it('кто объявлен «вычитать нечего» — не вычитает: иначе причина устарела', () => {
    const contradicting = Object.entries(ANSWERS)
      .filter(([f, a]) => a !== 'releases' && /releaseSlotsForCancelledBooking/.test(strip(read(f))))
      .map(([f]) => f);
    expect(
      contradicting,
      'файл значится как «вычитать нечего», но вычитает — причина в реестре больше не верна:\n'
      + contradicting.join('\n'),
    ).toEqual([]);
  });

  it('реестр самоустаревающий: записи про несуществующий файл нет', () => {
    const stale = Object.keys(ANSWERS).filter((f) => !existsSync(join(ROOT, f)));
    expect(stale, `запись про несуществующий файл:\n${stale.join('\n')}`).toEqual([]);
  });
});

describe('четвёртой реализации отмены больше нет', () => {
  const SRC = read('lib/services/tours/booking.service.ts');

  it('bookingService.cancel() удалён вместе с выдуманным refundAmount', () => {
    const code = strip(SRC);
    expect(code, 'ничейная копия отмены вернулась').not.toMatch(/async cancel\(/);
    expect(code, 'выдуманный ноль возврата вернулся').not.toMatch(/refundAmount: 0/);
  });

  it('причина удаления записана рядом — иначе её вернут первым же «а где отмена?»', () => {
    expect(SRC).toMatch(/#1816/);
    expect(SRC).toMatch(/#1813/);
  });
});
