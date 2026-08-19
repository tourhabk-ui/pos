/**
 * «На маршруте» — прибор, а не витрина.
 *
 * Владелец 09.08: «это же навигация без связи и может спасти либо убить
 * человека». Аудит того же дня нашёл пять умолчаний, каждое из которых делает
 * экран уверенным при мёртвом датчике:
 *   1. на iOS разрешение на компас не запрашивалось (`requestPermission` не
 *      вызывался нигде) — события не приходили, `heading` навечно оставался
 *      нулём, и стрелка показывала «север» при любом повороте телефона;
 *   2. относительный `alpha` части Android выдавался за истинный азимут —
 *      флаг `absolute` не проверялся;
 *   3. `pos.timestamp` и `pos.coords.accuracy` не использовались нигде: после
 *      потери фикса экран вечно показывал последние координаты как живые, а
 *      ошибки геолокации кода 2 и 3 проходили молча;
 *   4. плашка «Онлайн • GPS активен» отчитывалась за спутники, зная только
 *      про сеть;
 *   5. переход на следующую точку срабатывал при 50 м независимо от точности
 *      фикса — при точности 300 м это уводит человека от цели.
 *
 * Тесты стерегут не вид экрана, а именно право прибора молчать и признаваться.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  fixInfo, fixLabel, figuresAreLive, canAdvanceWaypoint, readHeading,
  compassLabel, formatAge, FIX_STALE_MS, FIX_DEAD_MS, ARRIVAL_MAX_ACCURACY_M,
} from '@/lib/on-route/fix-quality';

const SCREEN = readFileSync(join(process.cwd(), 'app/planning/_PlanningClient.tsx'), 'utf-8');
const NOW = 1_700_000_000_000;

describe('свежесть фикса', () => {
  it('свежий — живой, и точность названа', () => {
    const f = fixInfo(NOW - 5_000, 12, NOW);
    expect(f.state).toBe('live');
    expect(fixLabel(f)).toContain('12 м');
    expect(figuresAreLive(f)).toBe(true);
  });

  it('полминуты без сигнала — цифры ещё показываем, но говорим о возрасте', () => {
    const f = fixInfo(NOW - FIX_STALE_MS - 1, 20, NOW);
    expect(f.state).toBe('stale');
    expect(fixLabel(f)).toContain('Последний сигнал');
    expect(figuresAreLive(f)).toBe(true);
  });

  it('две минуты без сигнала — цифры объявлены устаревшими', () => {
    const f = fixInfo(NOW - FIX_DEAD_MS, 20, NOW);
    expect(f.state).toBe('dead');
    expect(fixLabel(f)).toContain('устарели');
    expect(figuresAreLive(f)).toBe(false);
  });

  it('фикса не было вовсе — так и сказано', () => {
    const f = fixInfo(null, null, NOW);
    expect(f.state).toBe('none');
    expect(fixLabel(f)).toBe('GPS не получен');
    expect(figuresAreLive(f)).toBe(false);
  });

  it('возраст читается словами', () => {
    expect(formatAge(30)).toBe('30 с');
    expect(formatAge(120)).toBe('2 мин');
    expect(formatAge(3900)).toBe('1 ч 5 мин');
    expect(formatAge(null)).toBe('—');
  });
});

describe('«мы дошли» — решение только по надёжному фиксу', () => {
  it('рядом и точность хорошая — переходим', () => {
    expect(canAdvanceWaypoint(fixInfo(NOW - 1000, 15, NOW), 0.03)).toBe(true);
  });

  it('точность хуже полусотни метров — не переходим, даже если «рядом»', () => {
    const f = fixInfo(NOW - 1000, ARRIVAL_MAX_ACCURACY_M + 1, NOW);
    expect(canAdvanceWaypoint(f, 0.01)).toBe(false);
  });

  it('фикс устарел — маршрут не двигается сам', () => {
    expect(canAdvanceWaypoint(fixInfo(NOW - FIX_STALE_MS - 1, 5, NOW), 0.01)).toBe(false);
    expect(canAdvanceWaypoint(fixInfo(null, null, NOW), 0.01)).toBe(false);
  });

  it('далеко — не переходим', () => {
    expect(canAdvanceWaypoint(fixInfo(NOW, 5, NOW), 1.2)).toBe(false);
  });
});

describe('компасу верим только там, где азимут привязан к земле', () => {
  it('iOS webkitCompassHeading — истинный север', () => {
    expect(readHeading({ webkitCompassHeading: 123 })).toEqual({ heading: 123, state: 'ok' });
  });

  it('alpha с флагом absolute — истинный север', () => {
    const r = readHeading({ alpha: 90, absolute: true });
    expect(r).toEqual({ heading: 270, state: 'ok' });
  });

  it('alpha без флага — НЕ азимут: помечаем неподтверждённым', () => {
    expect(readHeading({ alpha: 90 })?.state).toBe('unconfirmed');
    expect(readHeading({ alpha: 90, absolute: false })?.state).toBe('unconfirmed');
  });

  it('событие земной системы координат подтверждает азимут даже без флага', () => {
    // Chrome на части Android не ставит `absolute` в самом
    // deviceorientationabsolute. Гарантия здесь — тип события, а не флаг.
    expect(readHeading({ alpha: 90 }, true)).toEqual({ heading: 270, state: 'ok' });
  });

  it('пустое событие не даёт направления вовсе', () => {
    expect(readHeading({})).toBeNull();
    expect(readHeading({ alpha: null })).toBeNull();
  });

  it('каждое состояние объясняется словами', () => {
    expect(compassLabel('blocked')).toContain('включите');
    expect(compassLabel('unconfirmed')).toContain('сверяйтесь с картой');
    expect(compassLabel('off')).toContain('недоступен');
  });
});

describe('экран пользуется этим, а не рисует уверенность', () => {
  it('стрелка гаснет и не крутится, пока азимут не подтверждён', () => {
    // Прибор переехал в components/field/FieldCompass (приборный вид по
    // макетам FCN), правило то же: неподтверждённый датчик не двигает
    // стрелку и не выдаёт её за рабочую.
    const C = readFileSync(join(process.cwd(), 'components/field/FieldCompass.tsx'), 'utf-8');
    expect(C).toMatch(/const trusted = state === 'ok'/);
    expect(C).toMatch(/rotate\(\$\{trusted \? needleAngle : 0\}/);
    expect(C).toMatch(/opacity=\{trusted \? 1 : 0\.35\}/);
  });

  it('на iOS разрешение компаса запрашивается жестом', () => {
    expect(SCREEN).toMatch(/compassNeedsPermission\(\)/);
    expect(SCREEN).toMatch(/requestPermission\?\.\(\)/);
    expect(SCREEN).toMatch(/Включить/);
  });

  it('плашка сети больше не отчитывается за спутники', () => {
    expect(SCREEN).not.toMatch(/Онлайн • GPS активен/);
    expect(SCREEN).toMatch(/fixLabel\(fix\)/);
  });

  it('ошибки геолокации кода 2 и 3 больше не молчат', () => {
    expect(SCREEN).toMatch(/err\.code === 3/);
    expect(SCREEN).toMatch(/gpsMessage/);
  });

  it('возраст фикса стареет по таймеру — мёртвый GPS событий не шлёт', () => {
    expect(SCREEN).toMatch(/setNowTick\(Date\.now\(\)\)/);
  });

  it('переход точки идёт через проверку доверия, а не по одному расстоянию', () => {
    expect(SCREEN).toMatch(/canAdvanceWaypoint\(info, dist\)/);
    expect(SCREEN).not.toMatch(/dist < 0\.05 && currentWpIdx/);
  });

  it('расстояние признаётся прямой линией и гаснет на мёртвом фиксе', () => {
    expect(SCREEN).toMatch(/по прямой/);
    // Главная цифра переехала в components/field/FieldDistance (приборный
    // вид по макетам), но правило то же: мёртвый фикс не стирает число и не
    // выдаёт его за живое — цвет уходит в приглушённый.
    expect(SCREEN).toMatch(/live=\{figuresLive\}/);
    const DIST = readFileSync(join(process.cwd(), 'components/field/FieldDistance.tsx'), 'utf-8');
    expect(DIST).toMatch(/p\.live \? '#F0F6FC' : 'var\(--text-muted\)'/);
  });
});

describe('экран соответствует моменту, а не отчитывается о датчиках', () => {
  it('состояний датчиков — одна строка, а не стек баннеров', () => {
    // Регресс честности из #1061: сверху вставало четыре полосы, две из них
    // про одно и то же (GPS и разрешение). Владелец 09.08 назвал это криком
    // системы о себе — и был прав.
    const banners = SCREEN.match(/borderBottom: '1px solid color-mix/g) ?? [];
    expect(banners.length).toBeLessThanOrEqual(1);
    expect(SCREEN).toMatch(/const status = useMemo/);
  });

  it('всё в порядке — строки нет вовсе', () => {
    // Тишина тоже сообщение: «иди». Постоянная зелёная плашка «сеть есть»
    // приучает не читать статусы.
    expect(SCREEN).toMatch(/return null;\n  \}, \[gpsError, fix, gpsMessage, isOffline, compassState\]\)/);
    expect(SCREEN).not.toMatch(/'Сеть есть'/);
  });

  it('без маршрута — одно действие вместо приборной панели', () => {
    expect(SCREEN).toMatch(/\{!hasRoute && !isLoadingRoute \? \(/);
    expect(SCREEN).toMatch(/Маршрут не выбран/);
    expect(SCREEN).toMatch(/Выбрать маршрут/);
  });

  it('нули не показываются: карточки ждут живого фикса', () => {
    expect(SCREEN).toMatch(/\{figuresLive && \(/);
  });

  it('высоту показываем, только когда приёмник её дал', () => {
    // coords.altitude на многих телефонах и при Wi-Fi позиционировании
    // приходит null. Карточка «— м» в шрифте заголовка читается как поломка
    // прибора — того же класса, что и прочерк вместо расстояния выше.
    expect(SCREEN).toMatch(/\{altitude !== null && \(/);
    expect(SCREEN).not.toMatch(/'— м'/);
    // Стрелки вверх при абсолютной высоте нет: она обещает набор, которого
    // экран не считает — украшение, похожее на данные.
    expect(SCREEN).not.toMatch(/text-\[var\(--success\)\] text-base ml-0\.5">↑/);
  });

  it('нет фикса — говорим словами, а не прочерком в шрифте заголовка', () => {
    // Скрин владельца 09.08: вместо расстояния — серая полоса. Это «—»
    // размером 5xl: читается как поломка, а не как «данных пока нет».
    expect(SCREEN).toMatch(/Ждём сигнал GPS/);
    expect(SCREEN).not.toMatch(/\{distLabel \?\? '—'\}/);
    // И оценку времени без расстояния не показываем: считать нечего.
    expect(SCREEN).toMatch(/\{distLabel !== null && /);
    // Сам прибор тоже отказывается рисовать пустоту, а не полагается на
    // то, что его позовут в правильной ветке.
    const DIST = readFileSync(join(process.cwd(), 'components/field/FieldDistance.tsx'), 'utf-8');
    expect(DIST).toMatch(/if \(p\.distanceLabel === null\) return null/);
  });

  it('имя точки не дублирует название маршрута', () => {
    // «Мыс Маячный» печатался дважды: как маршрут и как следующая точка.
    expect(SCREEN).toMatch(/nextWp\.name !== activeRouteTitle/);
  });

  it('относительное событие не затирает подтверждённый азимут', () => {
    // На Android приходят ОБА события. Пока оба шли в один обработчик,
    // относительное сбивало состояние через такт, и предупреждение
    // «компас не подтверждён» висело вечно на исправном магнитометре.
    expect(SCREEN).toMatch(/sawAbsoluteRef/);
    expect(SCREEN).toMatch(/if \(sawAbsoluteRef\.current\) return;/);
    expect(SCREEN).toMatch(/'deviceorientationabsolute', handleAbsolute/);
    expect(SCREEN).toMatch(/'deviceorientation', handleRelative/);
  });

  it('кольцо сторон света замирает вместе со стрелкой', () => {
    // Скрин владельца 09.08: стрелка погашена и смотрит вверх, а кольцо
    // развёрнуто — «север справа». Один мёртвый датчик, два противоречащих
    // утверждения в одном приборе.
    const C = readFileSync(join(process.cwd(), 'components/field/FieldCompass.tsx'), 'utf-8');
    // Шкала (засечки, цифры, буквы) вращается ОДНИМ значением, и оно
    // обнуляется вместе с недоверием к датчику.
    expect(C).toMatch(/const ringRotation = trusted \? -heading : 0/);
    expect(C).toMatch(/rotate\(\$\{ringRotation\}/);
    // Второго, независимого поворота кольца в приборе нет.
    expect(C).not.toMatch(/rotate\(\$\{-heading\}/);
  });

  it('на карте рисуется настоящий трек, а не ломаная по точкам', () => {
    // Скрин владельца 09.08: «Мыс Маячный», одна точка маршрута — на карте
    // одинокий маркер и ничего больше. Трек при этом был: им рисуется схема
    // «вид сверху» на том же экране. Карта навигации без пути читается как
    // «маршрут не загрузился».
    expect(SCREEN).toMatch(/const line = track && track\.length >= 2 \? track : fallback;/);
    // Инвариант, а не буквальный список: трек обязан быть в зависимостях
    // мемо, иначе линия не перерисуется, когда трек доедет.
    expect(SCREEN).toMatch(/\}, \[track,[^\]]*\]\);/);
  });

  it('ожидание карты названо словами, а не чёрным экраном', () => {
    // Кусок leaflet грузится не мгновенно; без подписи нажатие выглядит
    // зависанием — ровно так владелец это и описал.
    expect(SCREEN).toMatch(/Загружаем карту/);
  });

  it('куска карты не греем заранее: промах прогрева отравляет модуль', () => {
    // Сборщик запоминает отвергнутое обещание динамического импорта, и после
    // неудачного прогрева нажатие на кнопку не грузит уже ничего. На маршруте
    // связь рвётся именно так, а цена промаха — чёрный экран вместо карты.
    expect(SCREEN).not.toMatch(/void import\('@\/components\/shared\/LeafletMap'\)/);
  });

  it('карта не завелась — это сказано и есть чем ответить', () => {
    const MAP = readFileSync(join(process.cwd(), 'components/shared/LeafletMap.tsx'), 'utf-8');
    // Пустой catch превращал любую неудачу загрузки в чёрный прямоугольник —
    // ответ, неотличимый от «приложение умерло».
    expect(MAP).not.toMatch(/catch\(\(\) => \{ \/\* Leaflet init failed/);
    expect(MAP).toMatch(/setInitFailed\(true\)/);
    expect(MAP).toMatch(/Карта не загрузилась/);
    expect(MAP).toMatch(/Повторить/);
  });

  it('копирайт человеческий, без разработческого жаргона', () => {
    expect(SCREEN).not.toMatch(/рельефа нет в данных маршрута/);
    expect(SCREEN).not.toMatch(/Схема точек/);
  });
});
