/**
 * Сводка ГУ МЧС 24–25.10, как её переслал владелец: четыре вулкана
 * «не приближаться», ощущаемое землетрясение без цунами, закрытый участок
 * в Усть-Большерецком округе и ограничение на мысе Левашова.
 *
 * Текст ниже — эти факты построчно, в форме суточной сводки. Чего владелец
 * не прислал (номер километра, высота пепла), в проверке нет: разбор не
 * имеет права это достроить.
 */
import { describe, expect, it } from 'vitest';
import { zoneBanner } from '@/app/safety/_SafetyClient';
import { finishKuzmichAnswer } from '@/lib/kuzmich/answer-guards';
import {
  appendOfferingFlags, citeBulletin, notesForOffering, notesForPlanDay,
  parseBulletinPeriod, warningsFromRows,
} from '@/lib/safety/mchs-bulletin';
import { classifyMchsItems } from '@/lib/services/safety/seismic-parser';

const SOURCE = 'https://vk.com/mchs_kamchatka?w=wall-1_2410';
const PERIOD = '06:00 24.10–06:00 25.10';

const BULLETIN = `Оперативная информация Главного управления МЧС России по Камчатскому краю.
Продолжается активность вулканов Безымянного, Шивелуча, Ключевского, Крашенинникова. Жителям и гостям региона рекомендуют не приближаться.
Утром 25.10 ощущалось землетрясение силой 2–3 балла. Угрозы цунами нет.
В Усть-Большерецком округе закрыт проезд для всех видов транспорта на участке автодороги.
Остаются ограничения для пассажирского транспорта на дороге мыс Левашова – посёлок Октябрьский.
Период сводки — с 06:00 24.10 по 06:00 25.10.`;

const run = (text: string, link = SOURCE) =>
  classifyMchsItems('vk.com/mchs_kamchatka/2410', '', text, '2026-10-24T18:00:00Z', link, 'vk_mchs');

describe('суточная сводка 24–25.10', () => {
  it('называет период так, как он написан, и не выдумывает его из даты поста', () => {
    expect(parseBulletinPeriod(BULLETIN)?.label).toBe(PERIOD);
    expect(parseBulletinPeriod('Активность вулканов сохраняется.')).toBeNull();
    expect(citeBulletin('Проезд закрыт.', null, null)).toBe('Проезд закрыт.');
  });

  it('четыре названных вулкана — четыре запрета, каждый в своей зоне', () => {
    const events = run(BULLETIN);
    const volcanoes = events.filter((e) => e.alert_type === 'volcanic_eruption');
    const names = volcanoes.map((e) => e.volcano_name);
    expect(names).toEqual(expect.arrayContaining(['Безымянный', 'Шивелуч', 'Ключевской', 'Крашенинникова']));
    expect(new Set(names).size).toBe(names.length);
    for (const ev of volcanoes) {
      expect(ev.severity).toBeGreaterThanOrEqual(2);
      expect(ev.title).toMatch(/не приближаться/);
      expect(ev.description).toContain(PERIOD);
      expect(ev.description).toContain(SOURCE);
      expect(ev.source_url).toBe(SOURCE);
    }
    const zone = (name: string) => volcanoes.find((e) => e.volcano_name === name)?.affected_zones;
    expect(zone('Безымянный')).toEqual(['northern']);
    expect(zone('Шивелуч')).toEqual(['northern']);
    expect(zone('Ключевской')).toEqual(['northern']);
    expect(zone('Крашенинникова')).toEqual(['eastern']);
  });

  it('закрытый округ и мыс Левашова — дороги, не цунами и не выдуманный вулкан', () => {
    const events = run(BULLETIN);
    expect(events.some((e) => e.alert_type === 'tsunami_warning')).toBe(false);
    const roads = events.filter((e) => e.alert_type === 'road_closure');
    expect(roads.map((e) => e.title)).toEqual(expect.arrayContaining([
      expect.stringMatching(/Усть-Большерецк/),
      expect.stringMatching(/Левашова/),
    ]));
    expect(roads.find((e) => /Левашова/.test(e.title))?.affected_zones).toEqual(['western']);
    expect(roads.find((e) => /Усть-Большерецк/.test(e.title))?.affected_zones).toEqual(['western']);
  });

  it('не разобранный текст не становится предупреждением о вулкане', () => {
    expect(run('Сегодня на Камчатке спокойная погода и хороший улов.')).toEqual([]);
    expect(run('Рекомендуют не приближаться к исполинам.').filter((e) => e.alert_type === 'volcanic_eruption')).toEqual([]);
  });

  it('пеплопад Шивелуча не подменяется общей строкой «не приближаться»', () => {
    const text = `На вулкане Шивелуч произошел пепловый выброс. В посёлках Ключи и Козыревск зафиксирован пепел.
Продолжается активность вулканов Безымянного и Шивелуча. Рекомендуют не приближаться к исполинам.
Период сводки — с 06:00 24.10 по 06:00 25.10.`;
    const shiveluch = run(text).find((e) => e.volcano_name === 'Шивелуч');
    expect(shiveluch?.title).toMatch(/пепл/i);
    expect(shiveluch?.severity).toBeGreaterThanOrEqual(2);
  });
});

describe('баннер называет место и период сводки', () => {
  it('вулкан и дорога из сводки 24.10 стоят с датой периода', () => {
    const banner = zoneBanner(true, ['low', 'low', 'low', 'low'], [
      {
        severity: 2,
        title: 'Вулкан Шивелуч: не приближаться',
        description: `Период сводки: ${PERIOD}. Источник: ${SOURCE}`,
      },
      {
        severity: 2,
        title: 'Мыс Левашова (п. Октябрьский): проезд ограничен',
        description: `Период сводки: ${PERIOD}.`,
      },
    ]);
    expect(banner.state).toBe('alarm');
    expect(banner.scope).toContain('Шивелуч');
    expect(banner.scope).toContain('Левашова');
    expect(banner.scope).toContain(PERIOD);
  });
});

describe('тур и маршрут не называются свободными от риска', () => {
  const rows = () => warningsFromRows(run(BULLETIN).map((e) => ({
    alert_type: e.alert_type,
    title: e.title,
    description: e.description,
    source_url: e.source_url,
    volcano_name: e.volcano_name,
  })));

  it('восхождение на Ключевскую и день северной зоны получают запрет', () => {
    const warnings = rows();
    const notes = notesForOffering('Восхождение на Ключевскую сопку', warnings);
    expect(notes.join('\n')).toMatch(/Ключевской/);
    expect(notes.join('\n')).toContain(PERIOD);
    expect(notes.join('\n')).toContain(SOURCE);
    const day = notesForPlanDay('Горячие источники', ['northern'], warnings);
    expect(day.some((n) => /Шивелуч|Ключевской|Безымянный/.test(n))).toBe(true);
    expect(notesForPlanDay('Прогулка по Петропавловску', ['avachinsky'], warnings)).toEqual([]);
  });

  it('переезд через запад получает закрытую дорогу, восток — нет', () => {
    const warnings = rows();
    const west = notesForPlanDay('Переезд на внедорожнике', ['avachinsky', 'western'], warnings);
    expect(west.some((n) => /Левашова|Усть-Большерецк/.test(n))).toBe(true);
    expect(notesForPlanDay('Переезд', ['eastern'], warnings).some((n) => /Левашова|проезд/.test(n))).toBe(false);
  });

  it('Кузьмич не оставляет «безопасно» при живом запрете и при непрочитанной сводке', () => {
    const block = [
      'ДЕЙСТВУЮЩИЕ ПРЕДУПРЕЖДЕНИЯ МЧС:',
      `вулкан | Шивелуч | период ${PERIOD} | источник ${SOURCE}`,
      'Туры у названных вулканов и маршруты по названным дорогам нельзя называть безопасными или без риска.',
    ].join('\n');
    const safe = finishKuzmichAnswer({
      surface: 'web',
      answer: 'К Шивелучу сейчас безопасно, можно идти.',
      question: 'Можно на Шивелуч?',
      toolRuns: [],
      context: block,
    });
    expect(safe.text).toMatch(/нельзя называть безопасн/);
    expect(safe.text).toContain(SOURCE);
    const unread = finishKuzmichAnswer({
      surface: 'telegram',
      answer: 'Маршрут безопасный.',
      question: 'Как там?',
      toolRuns: [],
      context: 'Сводки МЧС не прочитаны — эти варианты нельзя называть безопасными или без риска.',
    });
    expect(unread.text).toContain('Сводки МЧС не прочитаны');
    const quiet = finishKuzmichAnswer({
      surface: 'web',
      answer: 'В каталоге есть три тура.',
      question: 'Какие туры?',
      toolRuns: [],
      context: block,
    });
    expect(quiet.text).not.toMatch(/нельзя называть безопасн/);
  });

  it('флаг не дублируется, если ответ его уже содержит', () => {
    const warnings = rows().filter((w) => w.place === 'Шивелуч');
    const once = appendOfferingFlags('На Шивелуч идти безопасно.', warnings);
    expect(appendOfferingFlags(once, warnings).match(/МЧС: к вулкану Шивелуч/g)?.length).toBe(1);
  });
});
