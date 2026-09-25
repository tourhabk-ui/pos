/**
 * Разрешение парка — не то же, что регистрация в МЧС.
 *
 * Решение владельца 19.09: «на места, где нужна регистрация, нужно добавить
 * „Зелёную кнопку“». Сторож держит три вещи, каждая из которых уже ломалась
 * в этом репозитории по-своему:
 *
 * 1. ФАКТЫ ИЗ ИСТОЧНИКА. Адреса, часы и способы взяты со страницы КГБУ
 *    «Природный парк „Вулканы Камчатки“» (проба 543), адреса приложения —
 *    проверены ответом магазина (проба 544). Ссылка, собранная по шаблону
 *    «наверное, так», — это объявленный исход без источника.
 *
 * 2. ДВЕ ОБЯЗАННОСТИ НЕ СЛИВАЮТСЯ В ОДНУ. МЧС — спасателям сведения о
 *    группе, парк — право находиться на территории ООПТ. Турист, сделавший
 *    только первое, узнаёт о втором от инспектора на кордоне.
 *
 * 3. ОДНО ДЕЙСТВИЕ — ОДНА КНОПКА. Ссылка «согласование с парком» убрана из
 *    блока МЧС: две кнопки одного действия в соседних блоках расходятся
 *    поведением, и это в проекте уже стоило разбора (SOS, #887).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PARK_PERMIT_SOURCE,
  PARK_PERMIT_CHANNELS,
  GREEN_BUTTON,
  FREE_VISIT_AREAS,
  isFreeVisitArea,
} from '@/lib/safety/park-permit';

const ROOT = process.cwd();
const component = readFileSync(join(ROOT, 'components/safety/ParkPermitAction.tsx'), 'utf-8');
const routeCard = readFileSync(join(ROOT, 'app/routes/[id]/_RouteDetailClient.tsx'), 'utf-8');
const placeSafety = readFileSync(join(ROOT, 'components/places/PlaceSafety.tsx'), 'utf-8');

describe('факты названы источником', () => {
  it('у источника есть ведомство, адрес страницы и дата снятия', () => {
    expect(PARK_PERMIT_SOURCE.authority).toContain('Вулканы Камчатки');
    expect(PARK_PERMIT_SOURCE.url).toMatch(/^https:\/\/www\.vulcanikamchatki\.ru\//);
    expect(PARK_PERMIT_SOURCE.asOf).not.toHaveLength(0);
  });

  it('«Зелёная кнопка» ведёт в магазин, а не на APK-файл', () => {
    // Страница парка даёт ссылку на .apk; вести туриста на скачивание
    // установочного файла мимо магазина мы не будем.
    expect(GREEN_BUTTON.androidUrl).toBe(
      'https://play.google.com/store/apps/details?id=com.empedokl.greenbutton',
    );
    expect(component).not.toMatch(/\.apk/);
  });

  it('адрес под iOS не выдумывается: null — и это сказано словами', () => {
    // Третий исход §4.0: «не знаю» не равно «нет». Пока адрес не подтверждён
    // ответом магазина, компонент обязан говорить, куда ведёт ссылка.
    if (GREEN_BUTTON.iosUrl === null) {
      expect(component).toMatch(/App Store/);
    } else {
      expect(GREEN_BUTTON.iosUrl).toMatch(/^https:\/\/apps\.apple\.com\//);
    }
  });

  it('способов получить разрешение несколько, и «Зелёная кнопка» — один из них', () => {
    const keys = PARK_PERMIT_CHANNELS.map((c) => c.key);
    expect(keys).toContain('green_button');
    expect(keys).toContain('gosuslugi');
    expect(PARK_PERMIT_CHANNELS.length).toBeGreaterThan(2);
    // У каждого способа есть чем воспользоваться: ссылка либо внятная деталь.
    for (const channel of PARK_PERMIT_CHANNELS) {
      expect(channel.href ?? channel.detail, channel.key).toBeTruthy();
      expect(channel.detail.length, channel.key).toBeGreaterThan(10);
    }
  });
});

describe('зона свободного посещения названа, а не выведена правилом', () => {
  it('Авачинский перевал — разрешение не требуется', () => {
    expect(isFreeVisitArea('Авачинский перевал (база Три вулкана)')).toBe(true);
    expect(isFreeVisitArea('авачинский перевал')).toBe(true);
  });

  it('остальное — не свободная зона; пусто — тоже нет', () => {
    expect(isFreeVisitArea('Вулкан Горелый')).toBe(false);
    expect(isFreeVisitArea('Каньон Сноубордистов')).toBe(false);
    expect(isFreeVisitArea(null)).toBe(false);
    expect(isFreeVisitArea('')).toBe(false);
  });

  it('список поимённый и короткий — правила «перевалы можно» нет', () => {
    expect(FREE_VISIT_AREAS.length).toBeLessThan(5);
    expect(component).not.toMatch(/перевал['"]\s*\)|includes\(['"]перевал/i);
  });
});

describe('две обязанности не слиты в одну', () => {
  it('карточка маршрута показывает разрешение парка отдельным блоком', () => {
    expect(routeCard).toMatch(/import ParkPermitAction from '@\/components\/safety\/ParkPermitAction'/);
    expect(routeCard).toMatch(/<ParkPermitAction[\s\S]{0,200}parkApprovalUrl=\{route\.parkApprovalUrl\}/);
  });

  it('ссылка «согласование с парком» больше не дублируется в блоке МЧС', () => {
    expect(routeCard).not.toMatch(/Согласование с парком/);
  });

  it('карточка места показывает разрешение парка рядом с регистрацией МЧС', () => {
    expect(placeSafety).toMatch(/Разрешение парка/);
    expect(placeSafety).toMatch(/<ParkPermitAction variant="compact"/);
    // МЧС со своей ссылкой остаётся — блок не подменён, а дополнен.
    expect(placeSafety).toMatch(/MCHS_ONLINE_FORM_URL/);
  });

  it('текст блока прямо говорит, что это РАЗНЫЕ обязанности', () => {
    expect(component).toMatch(/не то же, что регистрация в МЧС/);
  });
});

describe('вид по дизайн-системе', () => {
  it('никакого стекла и хардкода цвета — это действие, а не контекст', () => {
    expect(component).not.toMatch(/backdrop-blur/);
    expect(component).not.toMatch(/#[0-9a-fA-F]{6}/);
    expect(component).not.toMatch(/bg-white\/\d|text-white\/\d/);
  });

  it('иконки только lucide, эмодзи нет', () => {
    expect(component).toMatch(/from 'lucide-react'/);
    expect(component).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });

  it('зелёный не становится главным акцентом экрана', () => {
    // Разбор 19.09: первая редакция красила кнопку сплошным --success по
    // НАЗВАНИЮ сервиса. На Ведаре цвет несёт состояние (§1), зелёный значит
    // «эко/норма», а рядом в блоке МЧС уже стоит яркая кнопка — два кричащих
    // действия отменяют друг друга. Заливка допускается только разбавленная.
    expect(component).not.toMatch(/background:\s*'var\(--success\)'/);
    expect(component).not.toMatch(/bg-\[var\(--success\)\]/);
    expect(component).toMatch(/color-mix\(in srgb, var\(--success\) \d+%/);
  });

  it('тач-цели не меньше 44px — это палец в перчатке, а не придирка', () => {
    const targets = component.match(/min-h-\[44px\]/g) ?? [];
    expect(targets.length).toBeGreaterThanOrEqual(3);
  });

  it('запасные способы свёрнуты, и свёрнуты нативно — без JS и без сети', () => {
    // Четыре адреса с часами работы — это шум на экране человека в поле.
    // <details> открывается без JS (§8) и доступен с клавиатуры (§10).
    // Ищем РАЗМЕТКУ, а не слово: первая версия этой проверки радовалась
    // упоминанию `<details>` в комментарии к файлу и пропускала мутацию,
    // в которой блок был развёрнут обратно (поймано мутационной проверкой).
    expect(component).toMatch(/<details\s+className=/);
    expect(component).toMatch(/<summary\s+className=[\s\S]{0,400}Другие способы/);
    // Список способов лежит ВНУТРИ раскрывающегося блока, а не над ним.
    const det = component.indexOf('<details');
    const list = component.indexOf('PARK_PERMIT_CHANNELS.filter');
    expect(det).toBeGreaterThan(0);
    expect(list).toBeGreaterThan(det);
  });

  it('движение — только переходами Tailwind, без keyframes', () => {
    expect(component).toMatch(/transition-\w+ duration-200/);
    expect(component).not.toMatch(/@keyframes|animate-\[/);
  });
});

describe('«Зелёная кнопка» там, где человек регистрируется (владелец 25.09: «где зелёная кнопка регистрации?»)', () => {
  const register = readFileSync(join(ROOT, 'app/register/page.tsx'), 'utf-8');
  const home = readFileSync(join(ROOT, 'app/_home/_HomeV8Client.tsx'), 'utf-8');

  it('адрес под iPhone — карточка App Store id1658152262, присланная владельцем', () => {
    expect(GREEN_BUTTON.iosUrl).toBe('https://apps.apple.com/ru/app/id1658152262');
  });

  it('блок даёт оба магазина, когда оба адреса известны', () => {
    expect(component).toMatch(/label: 'Android', href: GREEN_BUTTON\.androidUrl/);
    expect(component).toMatch(/GREEN_BUTTON\.iosUrl \? \[\{ label: 'iPhone', href: GREEN_BUTTON\.iosUrl \}\]/);
  });

  it('страница регистрации маршрута показывает разрешение парка — строкой на первом шаге и блоком после заявки', () => {
    expect(register).toMatch(/import ParkPermitAction from '@\/components\/safety\/ParkPermitAction'/);
    expect(register).toMatch(/<ParkPermitAction variant="compact" \/>/);
    expect(register).toMatch(/<ParkPermitAction \/>/);
    expect(register).toMatch(/отдельно от МЧС/);
  });

  it('плитка «Регистрация» на главной называет обе обязанности', () => {
    expect(home).toMatch(/<b>Регистрация<\/b><span>МЧС и парк<\/span>/);
    expect(home).toMatch(/aria-label="[^"]*Зелёная кнопка[^"]*"/);
  });
});
