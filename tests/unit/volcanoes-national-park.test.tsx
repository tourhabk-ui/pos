/**
 * «Ключевской» и «Южно-Камчатский» — национальный парк (постановление
 * Правительства России, сообщение правительства Камчатского края 14.10.2026;
 * владелец прислал новость в тот же день). Миграция 1245.
 *
 * Держится то, что делает правку правдой и не делает её выдумкой:
 *  - справочник называет оба участка национальным парком, но без имени и
 *    номера постановления, которых в источнике нет;
 *  - про разрешения сказано «не объявлено», прежние способы КГБУ не стёрты;
 *  - режим «Национальный парк» получают только места внутри контура OSM и
 *    только поверх прежнего режима природного парка, заказника, «нет» или
 *    ЮНЕСКО — заповедник и памятник природы не перетираются;
 *  - запись «Природный парк Южно-Камчатский», чьё описание рассказывает о
 *    федеральном заказнике, не трогается;
 *  - на карточке маршрута оговорка стоит у «Ключевского» и «Южно-Камчатского»
 *    и не стоит у Налычево и у федерального «Южно-Камчатского заказника».
 * Экран судится рендером, миграция — по смыслу операторов.
 */
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import PlaceEco from '@/components/places/PlaceEco';
import ParkPermitAction from '@/components/safety/ParkPermitAction';
import { parkKindLabel } from '@/lib/parks/park-kind';
import { federalizedPark } from '@/lib/safety/park-permit';
import { descriptionVoice } from '@/lib/places/description-voice';
import { composeAccessText } from '@/lib/places/access-text';

afterEach(cleanup);

const SQL = readFileSync(join(process.cwd(), 'migrations/1245_volcanoes_national_park.sql'), 'utf-8');
/** Тело миграции без комментариев — судим то, что исполнится. */
const BODY = SQL.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
const STATEMENTS = BODY.split(/;\s*\n/);

/** Склеенное значение `field = '…' || E'\n' || '…'` из оператора. */
function literalOf(stmt: string, field: string): string {
  const part = stmt.split(new RegExp(`${field}\\s*=`))[1].split(/,\s*\n\s*[a-z_]+\s*=|\n\s*WHERE|\n\s*FROM/)[0];
  return [...part.matchAll(/E'\\n'|'((?:[^']|'')*)'/g)]
    .map((m) => (m[0] === "E'\\n'" ? '\n' : m[1].replace(/''/g, "'")))
    .join('');
}

const parkUpdates = STATEMENTS.filter((s) => /UPDATE parks/.test(s));
const placesUpdate = STATEMENTS.find((s) => /UPDATE places p/.test(s))!;
const RULES = literalOf(placesUpdate, 'eco_rules');
const MEMBERS = [...placesUpdate.matchAll(/\('([0-9a-f-]{36})', '((?:[^']|'')*)'\)/g)].map((m) => ({ id: m[1], name: m[2] }));

describe('справочник парков', () => {
  it('оба участка — «Национальный парк», переименование только поверх прежнего имени', () => {
    const kl = parkUpdates.find((s) => s.includes("slug = 'klyuchevskoy'"))!;
    const yk = parkUpdates.find((s) => s.includes("slug = 'yuzhno-kamchatsky'"))!;
    expect(kl).toMatch(/AND display_name = 'Природный парк «Ключевской»'/);
    expect(yk).toMatch(/AND display_name = 'Южно-Камчатский природный парк'/);
    expect(parkKindLabel(literalOf(kl, 'display_name'))).toBe('Национальный парк');
    expect(parkKindLabel(literalOf(yk, 'display_name'))).toBe('Национальный парк');
  });

  it('про разрешения — «не объявлено», источник и дата названы; номера постановления нет — его нет в источнике', () => {
    for (const s of parkUpdates) {
      const d = literalOf(s, 'description');
      expect(d).toMatch(/ещё не объявлено/);
      expect(d).toContain('сообщение правительства Камчатского края, 14.10.2026');
      expect(descriptionVoice(d).voice).toBe('plain');
    }
    expect(BODY).not.toMatch(/постановлени[ея]\s+(Правительства[^.]*?)?№\s*\d/);
    // Ссылку разрешения КГБУ у «Ключевского» не стираем: действует ли она, не известно.
    for (const s of parkUpdates) expect(s).not.toMatch(/permit_url\s*=/);
  });
});

describe('места внутри контуров', () => {
  it('47 мест: 40 «Ключевского» и 7 «Южно-Камчатского»; запись о заказнике-тёзке не тронута', () => {
    expect(MEMBERS).toHaveLength(47);
    expect(new Set(MEMBERS.map((m) => m.id)).size).toBe(47);
    expect(MEMBERS.map((m) => m.name)).toEqual(expect.arrayContaining(['Вулкан Ключевская сопка', 'Вулкан Толбачик', 'Вулкан Мутновский', 'Вулкан Горелый']));
    expect(MEMBERS.map((m) => m.id)).not.toContain('d9059e8a-4c59-4baf-9be5-cae2fa33f810');
  });

  it('режим ложится только поверх природного парка, заказника, «нет», ЮНЕСКО или пустоты', () => {
    expect(placesUpdate).toMatch(/eco_zone = 'national_park'/);
    expect(placesUpdate).toMatch(/eco_permit_required = TRUE/);
    expect(placesUpdate).toMatch(/eco_permit_url = NULL/);
    expect(placesUpdate).toMatch(/AND \(p\.eco_zone IS NULL OR p\.eco_zone IN \('none', 'natural_park', 'zakaznik', 'UNESCO'\)\)/);
    expect(placesUpdate).not.toMatch(/'federal_reserve'|'nature_monument'/);
  });

  it('блок режима: «Национальный парк», две строки фактов, без чужого заповедника и без «пропуска онлайн»', () => {
    render(<PlaceEco eco={{ zone: 'national_park', permitRequired: true, rules: RULES, permitUrl: null }} placeName="Вулкан Ключевская сопка" />);
    expect(screen.getByText('Национальный парк')).toBeTruthy();
    const items = screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
    expect(items).toHaveLength(2);
    expect(items[0]).toMatch(/^С октября 2026 года — национальный парк в ведении Минприроды России/);
    expect(items[1]).toMatch(/ещё не объявлено/);
    expect(document.body.textContent).not.toMatch(/Кроноцк|Как получить разрешение/);
    expect(descriptionVoice(RULES).voice).toBe('plain');
  });

  it('«Как добраться» называет разрешение национального парка', () => {
    const lines = composeAccessText({
      name: 'Вулкан Толбачик', lat: 55.818, lng: 160.39, district: null, zone: null, accessInfo: null,
      routes: [], registrationRequired: false, eco: { zone: 'national_park', permitRequired: true }, toursCount: 0,
    });
    expect(lines).toContain('Посещение — по разрешению дирекции национального парка.');
  });
});

describe('карточка маршрута: оговорка о переходе', () => {
  it('маршрут «Ключевского» — оговорка со ссылкой на источник, прежние способы остаются', () => {
    // 1250: имя парка и дата постановления стали известны (проба 874) —
    // оговорка называет их, а порядок разрешений по-прежнему «не объявлен».
    render(<ParkPermitAction title="Вулкан Ключевская сопка" parkName="Ключевской" />);
    expect(document.body.textContent).toMatch(/С октября 2026 года «Ключевской» — часть национального парка «Вулканы Камчатки» в ведении Минприроды России/);
    expect(document.body.textContent).toMatch(/Как теперь выдаются разрешения, ещё не объявлено/);
    expect(document.body.textContent).toMatch(/положение о парке Минприроды должно утвердить в течение шести месяцев/);
    expect(screen.getByRole('link', { name: /постановление Правительства России от 9 октября 2026 года/ }).getAttribute('href'))
      .toBe('https://www.interfax.ru/russia/1121613');
    expect(screen.getAllByRole('link', { name: /Android/ }).length).toBeGreaterThan(0);
  });

  it('Налычево и федеральный заказник-тёзка — без оговорки', () => {
    expect(federalizedPark('Налычево', 'Долина Налычево')).toBeNull();
    expect(federalizedPark(null, 'Курильское озеро (Южно-Камчатский заказник)')).toBeNull();
    expect(federalizedPark(null, 'Природный парк Южно-Камчатский')?.name).toBe('«Южно-Камчатский»');
    render(<ParkPermitAction title="Долина Налычево" parkName="Налычево" />);
    expect(document.body.textContent).not.toMatch(/национальный парк/i);
  });
});
