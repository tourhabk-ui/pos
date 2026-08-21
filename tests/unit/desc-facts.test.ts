/**
 * Судья сверки описаний с фактами (кампания владельца 21.08).
 *
 * Канонический кейс — Дикие озерки: AI-описание уносило место в «долину
 * Паратунки» (полевые данные владельца — правый берег Пиначевки) и могло бы
 * говорить «12 километров» при записи 1.6 км. Судья ловит ПРОТИВОРЕЧИЕ
 * своим же данным; чинить текст или запись — решение человека.
 */
import { describe, it, expect } from 'vitest';
import {
  parseClaimedNumbers,
  compareFacts,
  mentionedFarPlaces,
  claimsTrack,
  MISMATCH_RATIO,
  MIN_ABS_KM,
  MIN_ABS_H,
  MIN_ABS_GAIN_M,
  FAR_PLACE_KM,
} from '@/lib/routes/desc-facts';

describe('parseClaimedNumbers — числа из текста', () => {
  it('километры, часы, набор высоты', () => {
    const c = parseClaimedNumbers(
      'Маршрут 12 километров, займёт 5 часов, набор высоты около 800 м.',
    );
    expect(c.distanceKm).toBe(12);
    expect(c.durationH).toBe(5);
    expect(c.gainM).toBe(800);
  });

  it('диапазон читается серединой', () => {
    const c = parseClaimedNumbers('Путь 8-10 часов, дистанция 14–16 км.');
    expect(c.durationH).toBe(9);
    expect(c.distanceKm).toBe(15);
  });

  it('запятая как десятичный разделитель', () => {
    expect(parseClaimedNumbers('Тропа всего 1,6 км.').distanceKm).toBe(1.6);
  });

  it('нет чисел — нет утверждений, а не нули', () => {
    const c = parseClaimedNumbers('Красивое место, стоит увидеть.');
    expect(c.distanceKm).toBeNull();
    expect(c.durationH).toBeNull();
    expect(c.gainM).toBeNull();
  });

  it('«в 20 км от города» — география, не длина маршрута (проба 125)', () => {
    const c = parseClaimedNumbers('Маршрут начинается в 20 км от Петропавловска-Камчатского.');
    expect(c.distanceKm).toBeNull();
  });

  it('«2 часа езды» — доставка, не прохождение', () => {
    const c = parseClaimedNumbers('До начала маршрута 2 часа езды на машине.');
    expect(c.durationH).toBeNull();
  });

  it('число без слова о пути в предложении не судится', () => {
    const c = parseClaimedNumbers('Панорама открывается на 60 км вокруг.');
    expect(c.distanceKm).toBeNull();
  });

  it('география пропускается, а настоящая длина дальше по тексту берётся', () => {
    const c = parseClaimedNumbers(
      'Маршрут начинается в 20 км от города. Протяжённость тропы — 12 км.',
    );
    expect(c.distanceKm).toBe(12);
  });
});

describe('compareFacts — пороги: вдвое И заметно в абсолюте', () => {
  it('пороги ровно объявленные', () => {
    expect(MISMATCH_RATIO).toBe(2);
    expect(MIN_ABS_KM).toBe(3);
    expect(MIN_ABS_H).toBe(2);
    expect(MIN_ABS_GAIN_M).toBe(300);
  });

  it('«12 километров» против записи 1.6 км — расхождение', () => {
    const out = compareFacts(
      parseClaimedNumbers('Маршрут 12 километров вдоль реки.'),
      { distanceKm: 1.6, durationH: null, gainM: null },
    );
    expect(out.map(f => f.kind)).toEqual(['distance_mismatch']);
  });

  it('честное округление не судится: 11 км против 9 км', () => {
    const out = compareFacts(
      { distanceKm: 11, durationH: null, gainM: null },
      { distanceKm: 9, durationH: null, gainM: null },
    );
    expect(out).toEqual([]);
  });

  it('вдвое, но мелко в абсолюте — не судится: 2 км против 1 км', () => {
    const out = compareFacts(
      { distanceKm: 2, durationH: null, gainM: null },
      { distanceKm: 1, durationH: null, gainM: null },
    );
    expect(out).toEqual([]);
  });

  it('неизвестный факт не судит текст: запись без дистанции', () => {
    const out = compareFacts(
      { distanceKm: 12, durationH: null, gainM: null },
      { distanceKm: null, durationH: null, gainM: null },
    );
    expect(out).toEqual([]);
  });

  it('набор высоты: 1200 м в тексте против 300 м в записи', () => {
    const out = compareFacts(
      { distanceKm: null, durationH: null, gainM: 1200 },
      { distanceKm: null, durationH: null, gainM: 300 },
    );
    expect(out.map(f => f.kind)).toEqual(['gain_mismatch']);
  });
});

describe('mentionedFarPlaces — чужая география', () => {
  // Озерки на Пиначевке (~53.267, 158.387); Паратунка — за хребтом.
  const places = [
    { name: 'Долина Паратунки', lat: 52.96, lng: 158.25 },
    { name: 'Река Пиначевка', lat: 53.27, lng: 158.39 },
    { name: 'Камчатка', lat: 56.0, lng: 159.0 },
    { name: 'Озеро', lat: 51.0, lng: 157.0 },
  ];

  it('место из реестра в десятках км — находка', () => {
    const out = mentionedFarPlaces(
      'Тропа идёт по живописной долине Паратунки мимо озёр.',
      53.2669, 158.3874, 'Дикие озерки', places,
    );
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('far_place');
    expect(out[0].detail).toContain('Долина Паратунки');
  });

  it('настоящий сосед в паре км — законный контекст', () => {
    const out = mentionedFarPlaces(
      'Начало у реки Пиначевка.', 53.2669, 158.3874, 'Дикие озерки', places,
    );
    expect(out).toEqual([]);
  });

  it('общие имена и короткие однословные — не улика', () => {
    const out = mentionedFarPlaces(
      'Камчатка прекрасна, каждое озеро — жемчужина.',
      53.2669, 158.3874, 'Дикие озерки', places,
    );
    expect(out).toEqual([]);
  });

  it('без координаты маршрута судить нечем — пусто, не выдумка', () => {
    const out = mentionedFarPlaces('Долина Паратунки.', null, null, 'X', places);
    expect(out).toEqual([]);
  });

  it('имя самого маршрута — предмет описания, не находка', () => {
    const out = mentionedFarPlaces(
      'Долина Паратунки встречает туманом.',
      53.2669, 158.3874, 'Долина Паратунки (обзорный)', places,
    );
    expect(out).toEqual([]);
  });

  it('порог дистанции — объявленная константа', () => {
    expect(FAR_PLACE_KM).toBe(30);
  });

  it('«каменистое дно» — слово, не место: без заглавной имя не считается', () => {
    const far = [{ name: 'Каменистый', lat: 56.5, lng: 161.0 }];
    expect(mentionedFarPlaces(
      'Прозрачная вода и каменистое дно создают условия для снорклинга.',
      53.0, 158.5, 'Бухта Малая Лагерная (дайвинг)', far,
    )).toEqual([]);
    const out = mentionedFarPlaces(
      'Отсюда виден Каменистый в хорошую погоду.',
      53.0, 158.5, 'Бухта Малая Лагерная (дайвинг)', far,
    );
    expect(out.map(f => f.kind)).toEqual(['far_place']);
  });
});

describe('claimsTrack — обещание трека, не слово «маршрут»', () => {
  it('GPS и трек — улика', () => {
    expect(claimsTrack('Скачайте GPS-трек перед выходом.')).toBe(true);
    expect(claimsTrack('Трек записан в 2024 году.')).toBe(true);
  });

  it('«маршрут» и «треккинг» — не улика', () => {
    expect(claimsTrack('Маршрут проходит через перевал.')).toBe(false);
    expect(claimsTrack('Лёгкий треккинг для всей семьи.')).toBe(false);
  });
});
