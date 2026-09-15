/**
 * Сторож доставки ключа брони: перепись клиентов, а не проверка одного файла
 * (#1889).
 *
 * ── Что случилось ─────────────────────────────────────────────────────────
 *
 * `operator_bookings.access_token` (миграция 943) выдаётся ОДИН раз и живёт
 * только в ссылке `?t=`. Это сделано намеренно: `id` у брони BIGSERIAL, и до
 * ключа перебор 1, 2, 3 отдавал имя туриста, дату и статус оплаты чужой
 * заявки, а вместе с ними PDF с чужими телефоном и почтой.
 *
 * Цена намеренного решения — у ключа обязан быть носитель. Носитель был
 * ОДИН: письмо, и только когда почта есть. Перепись всех клиентов
 * `POST /api/hub/bookings/create` 14.09 нашла троих, у которых ключ не
 * доходил никуда: `/p/[code]` (поля почты в форме нет вовсе — письма не было
 * НИКОГДА), `/kuzmich` на сайте (читал из ответа только `id`, а следом писал
 * «проверьте детали на странице бронирования» — про страницу, ключ от которой
 * сам же и выбросил) и виджет на чужом сайте (ссылка была, сохранить её было
 * нечем).
 *
 * ── Что держит этот сторож ────────────────────────────────────────────────
 *
 * Не «на экране N есть кнопка» — это проверяют соседние тесты
 * (`booking-link-recovery`, `booking-notify-access-link`). Здесь СВЯЗКА
 * (правило 10.09): у КАЖДОГО клиента эндпоинта обязан быть названный
 * носитель ключа, и клиент, не внесённый в реестр, краснеет. Молчание не
 * ответ — именно молчанием трое выше и дожили до сегодня.
 *
 * Реестр самоустаревающий в обе стороны: исчез клиент — тест требует убрать
 * запись, появился — внести и назвать способ.
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
 * Чем клиент доставляет ключ туристу — проверяется по коду самого файла:
 *
 * `redirect`  — уводит на `/booking-success/<id>?t=<ключ>`, ключ остаётся в
 *               адресной строке (и там же его подхватывает предупреждение на
 *               самой странице подтверждения);
 * `on-screen` — показывает ссылку с ключом и даёт её скопировать, потому
 *               что уводить некуда: чужой сайт, чат, форма без почты.
 */
type Carrier = 'redirect' | 'on-screen';

const CLIENTS: Record<string, Carrier> = {
  'components/marketplace/BookingFormClient.tsx':      'redirect',
  'app/hub/tourist/cart/checkout/_CheckoutClient.tsx': 'redirect',
  'app/kuzmich/_KuzmichClient.tsx':                    'on-screen',
  'app/p/[code]/_SelectionClient.tsx':                 'on-screen',
  'components/kuzmich/KuzmichWidget.tsx':              'on-screen',
};

/**
 * Поверхности, у которых блок «сохрани ссылку» написан СВОЙ, а не взят из
 * `components/bookings/BookingAccessLink.tsx`.
 *
 * Список ведётся вслух, потому что четыре копии одного текста о доступе
 * разойдутся — репозиторий уже платил за это трижды реализованным правилом
 * вида линии (§12). Копии появились не по недосмотру: три поверхности
 * закрыты отдельным PR #1891, и переписывать вмёрженное ради единообразия
 * дороже, чем назвать долг. Сведение к общему блоку — отдельная правка;
 * запись тогда уйдёт отсюда сама.
 */
const KNOWN_OWN_COPY: Record<string, string> = {
  'app/p/[code]/_SelectionClient.tsx':
    'свой блок из PR #1891; строит ссылку из ответа, почты у формы нет вовсе',
  'components/kuzmich/KuzmichWidget.tsx':
    'свой блок из PR #1891; в виджете мало места, предупреждение только когда почты нет',
  'app/booking-success/[id]/_BookingSuccessClient.tsx':
    'свой блок из PR #1891; копирует window.location.href и смотрит на has_email',
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

  it('клиентов не меньше, чем насчитано 14.09', () => {
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
        expect(src, 'ключ не уходит в адрес страницы подтверждения')
          .toMatch(/booking-success\/\$\{[^}]+\}\?t=/);
      } else {
        // Ссылка с ключом на экране: либо общий блок, либо своя копия —
        // но тогда она названа в KNOWN_OWN_COPY, а не заведена молча.
        const shared = /BookingAccessLink/.test(src);
        const own = /\?t=\$\{encodeURIComponent\(/.test(src);
        expect(shared || own, 'ключ не показывается человеку').toBe(true);
        if (!shared) {
          expect(Object.keys(KNOWN_OWN_COPY), `${file}: своя копия блока не названа`)
            .toContain(file);
          // Своя копия обязана давать СОХРАНИТЬ ссылку, а не только перейти
          // по ней: вкладка закроется, и перейти будет уже неоткуда.
          expect(src, `${file}: ссылку нечем сохранить`).toMatch(/clipboard\.writeText/);
        }
      }
    });
  }
});

describe('долг по копиям блока назван и не растёт молча', () => {
  it('каждая запись указывает на существующий файл', () => {
    for (const file of Object.keys(KNOWN_OWN_COPY)) {
      expect(() => code(file), `запись пережила файл: ${file}`).not.toThrow();
    }
  });

  it('запись снимается, когда поверхность перешла на общий блок', () => {
    // Самоустаревание: реестр в markdown такого не умеет — он сам стал бы
    // объявлением без источника (правило 10.09).
    const stillOwn = Object.keys(KNOWN_OWN_COPY)
      .filter((f) => !/BookingAccessLink/.test(code(f)));
    expect(Object.keys(KNOWN_OWN_COPY).sort()).toEqual(stillOwn.sort());
  });

  it('у каждой записи есть причина, а не пустая строка', () => {
    for (const [file, reason] of Object.entries(KNOWN_OWN_COPY)) {
      expect(reason.trim().length, `${file}: причина не названа`).toBeGreaterThan(20);
    }
  });
});

describe('общий блок не выдумывает ссылку, когда ключа нет', () => {
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
