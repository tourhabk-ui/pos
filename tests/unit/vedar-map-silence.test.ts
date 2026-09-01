/**
 * Молчание карты — не исход.
 *
 * Полевой прогон 01.09, скрин владельца с Авачинского перевала: между
 * компасом и карточкой расстояния чёрное поле. Ни рельефа, ни трека, ни
 * строки ошибки, ни строки «Подложка OSM: …». Приложение при этом работало:
 * GPS ±30 м, азимут, 15.6 км до следующей точки — всё живое.
 *
 * У карты было ровно два исхода: «рисую» и «сказала ошибку». Случившийся
 * третий — смонтировалась, не упала, тайлы не пришли — на экране выглядел
 * как фон страницы того же цвета `#0D1117`. Отличить его человеку в поле
 * было нечем, и разбор пошёл перепиской со скринами вместо одного взгляда.
 *
 * Это ровно §4.0: у проверки обязан быть исход «не смог», и он обязан
 * отличаться от «хорошо». Сторож держит три вещи:
 *   - карта считает, пришёл ли КАЖДЫЙ источник, а не «была ли ошибка»
 *     (при чтении PMTiles своим протоколом отказ до события `error` может
 *     не дойти вовсе — 01.09 он и не дошёл);
 *   - счёт идёт в ref, не в state: событий `data` сотни, и перерисовка на
 *     каждом вернула бы скачущую карту, которую чинили тем же утром;
 *   - сторож молчит, когда всё хорошо, и снимается при размонтировании.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { packFileName } from '@/components/shared/VedarMap';

const SRC = readFileSync(join(process.cwd(), 'components/shared/VedarMap.tsx'), 'utf-8');
const CLIENT_SRC = readFileSync(join(process.cwd(), 'app/planning/_PlanningClient.tsx'), 'utf-8');

describe('карта отчитывается о себе, когда ничего не нарисовала', () => {
  it('считает приход каждого источника поимённо', () => {
    // «Рельеф не пришёл» и «горизонтали не пришли» — разные поломки с
    // разными причинами: один читается Range-запросами из архива, другой
    // обычным GET. Общее «карта не работает» не назвало бы ни одну.
    expect(SRC).toMatch(/sourceId === 'terrain'/);
    expect(SRC).toMatch(/sourceId === 'contours'/);
    expect(SRC).toMatch(/рельеф не пришёл/);
    expect(SRC).toMatch(/горизонтали не пришли/);
    expect(SRC).toMatch(/стиль не загрузился/);
  });

  it('судит по приходу данных, а не только по событию ошибки', () => {
    // 01.09 событие error не сработало ни разу, а карты не было.
    expect(SRC).toMatch(/map\.on\('data'/);
  });

  it('счётчики живут в замыкании, а не в state', () => {
    // Событий data сотни. setState на каждом — это пересборка карты на
    // каждом тайле, та же болезнь, что чинили в LeafletMap 31.08.
    const at = SRC.indexOf("map.on('data'");
    expect(at).toBeGreaterThan(0);
    const body = SRC.slice(at, at + 400);
    expect(body).not.toMatch(/setDiag|setState|setReady/);
  });

  it('сторож снимается при размонтировании', () => {
    // Иначе таймер стрельнёт по мёртвому компоненту и попробует обновить
    // размонтированное состояние.
    expect(SRC).toMatch(/clearTimeout\(watchdog\)/);
  });

  it('молчит, когда всё хорошо', () => {
    // Сообщение без повода читается как шум, и через неделю его перестают
    // замечать — тогда оно не сработает и в настоящий раз.
    expect(SRC).toMatch(/if \(loaded && seen\.terrain > 0\) return;/);
  });

  it('отчёт называет файл пакета, а не только факт отказа', () => {
    expect(SRC).toMatch(/искала: \{packFileName/);
  });
});

describe('сообщение доходит туда, где его не накроет карточка статуса', () => {
  /**
   * Регресс того же дня: строка была НА карте, но карта — `fixed inset-0
   * z-0`, а приборная колонка со статусом — `z-10`, СОСЕДНИЙ стекинг-
   * контекст. Дочерний z-index внутри z-0 не может перекрыть родителя
   * соседа, сколько его ни поднимай, — и текст оказался под непрозрачной
   * карточкой, видна была только полоска в 1-2 пикселя.
   *
   * Лечится не CSS-трюком внутри карты, а тем же приёмом, что уже применён
   * для `fieldBaseMap.reason` («Подложка OSM: …»): сообщение выходит из
   * карты наружу и рисуется в самой приборной колонке.
   */
  it('VedarMap принимает onDiagnostic и вызывает его при смене mapError/diag', () => {
    expect(SRC).toMatch(/onDiagnostic\?:\s*\(message: string \| null\) => void/);
    const at = SRC.indexOf('onDiagnosticRef.current?.(mapError ?? diag ?? null)');
    expect(at, 'эффект, синхронизирующий диагноз наружу, не найден').toBeGreaterThan(0);
  });

  it('callback идёт через ref, а не напрямую в зависимостях — жизненный цикл карты не должен дёргаться от чужой identity', () => {
    expect(SRC).toMatch(/const onDiagnosticRef = useRef\(onDiagnostic\)/);
  });

  it('очистка при размонтировании — отдельным эффектом, не при каждой смене диагноза', () => {
    const at = SRC.indexOf('() => onDiagnosticRef.current?.(null), []');
    expect(at, 'unmount-эффект очистки не найден').toBeGreaterThan(0);
  });

  it('_PlanningClient рисует диагноз в приборной колонке (z-10), а не только внутри VedarMap', () => {
    expect(CLIENT_SRC).toMatch(/onDiagnostic=\{setVedarDiag\}/);
    const at = CLIENT_SRC.indexOf("fieldBaseMap.kind === 'vedar' && vedarDiag");
    expect(at, 'строка диагноза в приборной колонке не найдена').toBeGreaterThan(0);
    expect(CLIENT_SRC.slice(at, at + 400)).toMatch(/Своя карта не отрисовалась: \{vedarDiag\}/);
  });
});

describe('имя пакета в отчёте читаемо на телефоне', () => {
  it('снимает схему pmtiles и хост', () => {
    expect(packFileName('pmtiles://https://s3.example.ru/bucket/avacha.terrain.pmtiles'))
      .toBe('avacha.terrain.pmtiles');
  });

  it('снимает параметры запроса — в них бывают ключи', () => {
    expect(packFileName('https://s3.example.ru/b/avacha.contours.geojson?sig=abc'))
      .toBe('avacha.contours.geojson');
  });

  it('обычный адрес без схемы pmtiles тоже сокращает', () => {
    expect(packFileName('https://s3.example.ru/b/avacha.contours.geojson'))
      .toBe('avacha.contours.geojson');
  });

  it('пустой хвост не превращается в пустую строку', () => {
    // Пустая строка в отчёте выглядела бы как «искала: » — вопрос без
    // ответа. Лучше вернуть то, что есть.
    expect(packFileName('https://s3.example.ru/')).toBe('s3.example.ru');
  });
});
