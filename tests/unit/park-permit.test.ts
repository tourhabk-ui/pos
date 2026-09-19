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
});
