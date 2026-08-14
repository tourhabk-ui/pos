/**
 * Регистрация МЧС из плана («Мой план 2.0», C-7; план согласован владельцем
 * 08.08: «делай»).
 *
 * Контур самостоятельной регистрации существовал целиком (/register →
 * POST /api/safety/register → route_registrations + PDF-заявление в ГУ МЧС),
 * но турист с готовым планом перенабирал маршрут и даты руками. C-7 — только
 * мост: /register учится предзаполнению из query, план даёт кнопку с готовыми
 * данными. Границы, ради которых план шёл на согласование:
 *   - app/api/safety/* не меняется ни на строку;
 *   - в query — только маршрут, дни и даты, НИКАКИХ ПД (имена/телефоны
 *     группы турист вводит сам — Compliance Sentinel, 152-ФЗ);
 *   - автоотправки в МЧС от имени туриста нет — подтверждает человек.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const REGISTER = readFileSync(join(ROOT, 'app/register/page.tsx'), 'utf-8');
const SHARE_UI = readFileSync(join(ROOT, 'app/trip/[token]/_TripShareClient.tsx'), 'utf-8');

describe('C-7: /register умеет предзаполнение', () => {
  it('читает name/desc/start/end из window.location, не через useSearchParams', () => {
    // useSearchParams потребовал бы Suspense-обвязку; приём тот же, что у
    // формы брони (?date=, B-3) — window.location на клиенте.
    expect(REGISTER).toMatch(/new URLSearchParams\(window\.location\.search\)/);
    expect(REGISTER).not.toMatch(/useSearchParams/);
  });

  it('даты валидируются, длины ограничены лимитами Zod-схемы API', () => {
    expect(REGISTER).toMatch(/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$/);
    expect(REGISTER).toMatch(/\.slice\(0, 200\)/);
    expect(REGISTER).toMatch(/\.slice\(0, 2000\)/);
  });

  it('поле поиска по базе не предзаполняется — дропдаун не выпадает поверх формы', () => {
    const prefill = REGISTER.slice(REGISTER.indexOf('window.location.search'));
    const effectEnd = prefill.indexOf('}, []);');
    expect(prefill.slice(0, effectEnd)).not.toMatch(/setRouteQuery\(/);
  });

  it('страница осталась force-dynamic', () => {
    expect(REGISTER).toMatch(/export const dynamic = 'force-dynamic'/);
  });
});

describe('C-7: план ведёт к регистрации', () => {
  it('кнопка «Зарегистрировать маршрут» несёт название, дни и даты плана', () => {
    expect(SHARE_UI).toMatch(/\/register\?\$\{mchsQuery\}/);
    expect(SHARE_UI).toMatch(/q\.set\('name', trip\.title/);
    expect(SHARE_UI).toMatch(/q\.set\('desc', desc\)/);
    expect(SHARE_UI).toMatch(/q\.set\('start', trip\.arrival_date\)/);
    expect(SHARE_UI).toMatch(/q\.set\('end', trip\.departure_date\)/);
  });

  it('в query нет ПД: ни телефонов, ни имён людей', () => {
    const block = SHARE_UI.slice(SHARE_UI.indexOf('const mchsQuery'), SHARE_UI.indexOf('return q.toString()'));
    expect(block).not.toMatch(/phone|leader|member|email/i);
  });

  it('официальная форма МЧС остаётся альтернативой рядом', () => {
    // Проверка держалась за литерал URL и упала, когда адрес переехал в
    // lib/safety/mchs-registration. Сторожить надо свойство — «рядом есть
    // прямая ссылка на официальную форму», — а не строку: сам адрес
    // проверяется там, где он единственный раз и записан.
    expect(SHARE_UI).toMatch(/MCHS_ONLINE_FORM_URL/);
    expect(SHARE_UI).toMatch(/from '@\/lib\/safety\/mchs-registration'/);
  });

  it('план называет срок подачи — здесь до выхода ещё есть время', () => {
    // План составляют заранее; карточку маршрута часто открывают накануне.
    // Значит именно здесь срок в 10 рабочих дней меняет поведение.
    expect(SHARE_UI).toMatch(/MCHS_DEADLINE_SHORT/);
  });
});

describe('C-7: границы согласованного плана', () => {
  it('нет автоотправки в МЧС: план только ссылается на форму, POST жмёт человек', () => {
    // Мост — это UI-wiring: страница плана не зовёт safety-эндпоинты сама.
    // Единственный путь регистрации — человек заполняет форму на /register.
    expect(SHARE_UI).not.toMatch(/api\/safety/);
    expect(SHARE_UI).not.toMatch(/api\/operator\/mchs/);
  });
});
