/**
 * Сторож согласия на обработку ПД: где оно живёт и доходит ли до базы.
 *
 * Повод — замер 14.09. Компонент `PdConsentCheckbox` стоит на ДЕВЯТИ
 * поверхностях и не стоит ровно на одной: в форме заявки на тур
 * (`components/marketplace/BookingFormClient.tsx`), которая собирает имя,
 * телефон и email гостя. Гостевая бронь через `/api/hub/bookings/create` —
 * единственный путь, которым платформа берёт ПД человека БЕЗ аккаунта
 * (у `/api/bookings/tour` стоит `requireAuth`, там согласие дано при
 * регистрации). То есть дыра была одна, зато в самом людном месте.
 *
 * Сторож держит три связки, и ни одна не проверяет «компонент отрисован» —
 * этого мало. Галочка, которая никуда не уходит, ничем не лучше её отсутствия:
 * человек нажимает, а доказательства не остаётся (§4.0, правило 10.09 —
 * объявленный исход без источника).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

/* ─── 1. Где живёт согласие ────────────────────────────────────────────────── */

/**
 * Реестр хранилищ согласия. Может ТОЛЬКО СОКРАЩАТЬСЯ.
 *
 * Три копии одной идеи, и это записано вслух, потому что две из них УЖЕ
 * разошлись: у `users` есть только `pd_consent_at` и `pd_consent_ip`, без
 * `source` и `version`, — то есть у пользователей платформы согласие записано
 * хуже, чем у лидов, и никто этого не заметил, пока не полезли за третьей.
 *
 * Единая таблица согласий честнее по замыслу, но пока leads и users не
 * переехали, она дала бы не одно место, а ЧЕТВЁРТЫЙ способ. Реестр существует
 * ровно затем, чтобы четвёртая копия не завелась молча.
 */
const CONSENT_HOMES: Record<string, { fields: string[]; note: string }> = {
  users: {
    fields: ['pd_consent_at', 'pd_consent_ip'],
    note: 'неполно: нет source и version — под какой формулировкой согласились, не докажем',
  },
  leads: {
    fields: ['pd_consent_at', 'pd_consent_ip', 'pd_consent_source', 'pd_consent_version'],
    note: 'миграция 911, полный набор',
  },
  operator_bookings: {
    fields: ['pd_consent_at', 'pd_consent_ip', 'pd_consent_source', 'pd_consent_version'],
    note: 'миграция 969, третья копия — типы взяты у 911 дословно',
  },
};

describe('где живёт согласие', () => {
  it('четвёртая копия не заводится молча', () => {
    // Ищем ALTER/CREATE с колонкой согласия и вытаскиваем имя таблицы.
    const dir = join(ROOT, 'migrations');
    const tables = new Set<string>();
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql'))) {
      const sql = readFileSync(join(dir, f), 'utf-8');
      if (!/pd_consent_at/i.test(sql)) continue;
      for (const m of sql.matchAll(/(?:ALTER TABLE|CREATE TABLE(?: IF NOT EXISTS)?)\s+([a-z_]+)/gi)) {
        const table = m[1].toLowerCase();
        // Таблица попадает в счёт, только если колонка согласия объявлена
        // ИМЕННО у неё: в одной миграции бывает несколько ALTER подряд.
        const after = sql.slice(m.index ?? 0, (m.index ?? 0) + 900);
        if (/pd_consent_at/i.test(after)) tables.add(table);
      }
    }
    const unknown = [...tables].filter((t) => !(t in CONSENT_HOMES));
    expect(unknown, 'новое хранилище согласия — внести в реестр с причиной или не заводить').toEqual([]);
  });

  it('реестр не указывает на то, чего в миграциях нет', () => {
    // Самоустаревание в обратную сторону: запись, под которой нет колонок,
    // — обещание без источника.
    const all = readdirSync(join(ROOT, 'migrations'))
      .filter((n) => n.endsWith('.sql'))
      .map((n) => readFileSync(join(ROOT, 'migrations', n), 'utf-8'))
      .join('\n');
    for (const [table, { fields }] of Object.entries(CONSENT_HOMES)) {
      for (const field of fields) {
        expect(all, `${table}.${field} в реестре есть, в миграциях нет`).toContain(field);
      }
    }
    expect(all).toContain('ALTER TABLE operator_bookings');
  });

  it('формулировка и её версия — в одном месте, не в формах', () => {
    const src = read('lib/legal/pd-consent.ts');
    expect(src).toContain('PD_CONSENT_VERSION');
    expect(src).toContain('PD_CONSENT_TEXT');
    // Текст согласия не дублируется в форме брони — иначе версии разойдутся.
    expect(read('components/marketplace/BookingFormClient.tsx'))
      .not.toContain('Согласен на обработку персональных данных');
  });
});

/* ─── 2. Проводка формы: галочка → состояние → тело запроса ────────────────── */

/** Все поверхности с галочкой. Новая форма без записи здесь — красный. */
const CONSENT_FORMS = [
  'app/_home/_HomeV8Client.tsx',
  'app/contact/_ContactClient.tsx',
  'app/hub/tourist/trips/[id]/_TripDetailClient.tsx',
  'app/planner/_PlannerClient.tsx',
  'app/request/_RequestClient.tsx',
  'app/widget/lead-form/[slug]/page.tsx',
  'components/routes/LeadModal.tsx',
  'components/shared/StickyLeadButton.tsx',
  'components/marketplace/BookingFormClient.tsx',
];

/**
 * Долг: формы, шлющие `pd_consent: true` ЛИТЕРАЛОМ, а не состоянием галочки.
 *
 * Сейчас это работает — запрос без галочки не уходит. Но связь держится
 * гейтом формы, а не типом: у большинства это `disabled` кнопки, у главной
 * (с 24.09, аудит #3/#5) — проверка `!pdConsent` в `submitLead`: бледная
 * выключенная кнопка молчала о причине, теперь кнопка активна, а обработчик
 * показывает ошибку у галочки и переводит на неё фокус. Снимет кто-нибудь
 * гейт при правке — и согласие уедет без галочки, а сервер этого не отличит:
 * `z.literal(true)` проверяет, ЧТО пришло, а не что человек нажимал.
 * Наличие гейта у каждой формы держит lead-pd-consent.test.ts (`!pdConsent`).
 *
 * Список самоустаревающий: форма начала слать состояние — запись обязана уйти.
 * Чинить девять форм в PR про одну галочку было бы расширением; долг записан,
 * чтобы он был видимым и убывающим, а не строчкой в памяти.
 */
const KNOWN_LITERAL_CONSENT = new Set([
  'app/_home/_HomeV8Client.tsx',
  'app/contact/_ContactClient.tsx',
  'app/hub/tourist/trips/[id]/_TripDetailClient.tsx',
  'app/planner/_PlannerClient.tsx',
  'app/request/_RequestClient.tsx',
  'app/widget/lead-form/[slug]/page.tsx',
  'components/routes/LeadModal.tsx',
  'components/shared/StickyLeadButton.tsx',
]);

describe('проводка согласия в формах', () => {
  it('у каждой формы с галочкой согласие уходит на сервер', () => {
    for (const f of CONSENT_FORMS) {
      const src = read(f);
      expect(src, `${f}: галочка есть`).toContain('PdConsentCheckbox');
      expect(src, `${f}: согласие показано, но в запрос не уходит`).toMatch(/pd_consent\s*:/);
    }
  });

  it('долг по литералам только сокращается', () => {
    const stillLiteral = CONSENT_FORMS.filter((f) => /pd_consent:\s*true\b/.test(read(f)));
    const extra = stillLiteral.filter((f) => !KNOWN_LITERAL_CONSENT.has(f));
    expect(extra, 'новая форма шлёт литерал вместо состояния галочки').toEqual([]);
    const fixed = [...KNOWN_LITERAL_CONSENT].filter((f) => !stillLiteral.includes(f));
    expect(fixed, 'форма уже шлёт состояние — снять её из KNOWN_LITERAL_CONSENT').toEqual([]);
  });

  it('форма брони шлёт СОСТОЯНИЕ галочки и не отправляется без неё', () => {
    const src = read('components/marketplace/BookingFormClient.tsx');
    // Не литерал: значение берётся из состояния.
    expect(src).toMatch(/pd_consent:\s*pdConsent/);
    expect(src).not.toMatch(/pd_consent:\s*true/);
    // Гейт отправки — по тому же состоянию, а не «на глаз».
    expect(src).toMatch(/disabled=\{[^}]*!pdConsent/);
  });
});

/* ─── 3. Сервер: принял согласие — обязан записать ─────────────────────────── */

/**
 * Реестр «кто принимает согласие». Проверяется не факт приёма, а ЗАПИСЬ:
 * роут, забравший галочку и не положивший её в базу, — худший из исходов,
 * потому что снаружи он выглядит правильным.
 */
const CONSENT_ENDPOINTS = [
  'app/api/leads/route.ts',
  'app/api/auth/register/route.ts',
  'app/api/auth/register-operator/route.ts',
  'app/api/hub/bookings/create/route.ts',
];

describe('сервер записывает согласие, а не только принимает', () => {
  it('каждый принимающий роут доводит согласие до базы', () => {
    for (const f of CONSENT_ENDPOINTS) {
      const src = read(f);
      expect(src, `${f}: не принимает pd_consent`).toContain('pd_consent');
      const records = /buildConsentRecord/.test(src) || /pd_consent_at/.test(src);
      expect(records, `${f}: согласие принято и НЕ записано — галочка уходит в никуда`).toBe(true);
    }
  });

  it('бронь: согласие опционально на сервере — «не спрашивали» ≠ «отказано»', () => {
    const src = read('app/api/hub/bookings/create/route.ts');
    // Жёсткое z.literal(true) сломало бы Кузьмича, виджет, корзину и /p/[code]
    // — четыре из пяти клиентов эндпоинта, где формы с галочкой нет вовсе.
    expect(src).not.toMatch(/pd_consent:\s*z\.literal\(true\)/);
    expect(src).toMatch(/pd_consent:\s*z\.boolean\(\)\.optional\(\)/);
    expect(src).toContain('buildConsentRecord');
  });

  it('согласие пишется В ТОЙ ЖЕ вставке, что бронь', () => {
    // Отдельный UPDATE после INSERT — окно, в котором бронь есть, а записи
    // согласия нет. Ровно тот класс, что вчера чинили в дедупе алертов.
    const src = read('lib/bookings/reserve.ts');
    expect(src).toContain('pd_consent_at');
    expect(src).toMatch(/INSERT INTO operator_bookings[\s\S]{0,600}pd_consent_at/);
    expect(src, 'согласие дописывается вторым запросом — так нельзя')
      .not.toMatch(/UPDATE operator_bookings[\s\S]{0,200}pd_consent/);
  });
});
