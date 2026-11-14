/**
 * «Анализатор безопасности» (/tools/safety): результат — из блоков карточек
 * (слово владельца 14.11 «1 и 2»).
 *
 * До 14.11 у инструмента была своя оценка: число риска 1–5 и три текста,
 * которые писала модель и не сверял никто. Теперь место показано теми же
 * блоками, что его карточка (обстановка дня, опасности, совет Кузьмича из
 * данных, «Что знать» с кнопкой 112), маршрут — блоком оценки дня его
 * карточки. У кнопки GPS четыре исхода, и далёкое место за «ваше» не выдаётся.
 *
 * Судится рендером: что видит человек.
 */
import React from 'react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

// Кнопка 112 раздела «Что знать» (EmergencyAction) читает роутер приложения.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/tools/safety',
}));

import { SafetyToolResult, distanceWords, type SafetyToolAnswer, type ToolPlace } from '@/components/tools/SafetyToolResult';
import RouteVerdict from '@/components/routes/RouteVerdict';
import PlaceRealtimeStatus from '@/components/places/PlaceRealtimeStatus';
import { EMERGENCY_PRIMARY } from '@/lib/safety/emergency-numbers';
import { advisoryForPlace, buildPlaceAdvisory } from '@/lib/kuzmich/place-advisory';
import { placeDayStatus } from '@/lib/safety/place-day-status';
import { NEAREST_PLACE_MAX_KM } from '@/lib/places/nearest-limit';
import { goVerdict, VERDICT_LABELS, type RouteSignals } from '@/lib/routes/go-verdict';
import type { PlaceRealtime, PlaceSafety } from '@/components/places/types';

const fetchSpy = vi.fn(() => new Promise<Response>(() => {}));
beforeEach(() => {
  fetchSpy.mockClear();
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
});
afterEach(cleanup);

const SAFETY: PlaceSafety = {
  source: 'manual',
  difficultyLevel: 3, altitudeM: 2741, altitudeDiffM: null, distanceKm: null, terrainType: null,
  nearestMedicalKm: 35, emergencyAccess: null, phoneRangerMches: null, satCommunicatorRequired: true,
  rulesRequired: null, weatherThreshold: null, hazardTypes: ['volcanic_gas'],
  capacityPerDay: null, optimalGroupSize: null, openFromDate: null, openToDate: null,
  requiredGear: [], connectivity: null, registrationRequired: true, medicalInfo: null,
} as PlaceSafety;

const fresh = () => new Date().toISOString();

const realtime = (over: Partial<PlaceRealtime>): PlaceRealtime => ({
  isOpen: true, currentCrowds: null, currentWeather: null, activeAlerts: null, alertSeverity: null,
  alertMessage: null, touristsToday: null, touristsHour: null, status: 'green', linkedVolcanoes: null,
  updatedAt: fresh(), ...over,
});

const place = (over: Partial<ToolPlace> = {}): ToolPlace => ({
  id: '4a474632-d8d6-4147-9fa1-ed149edb1a62',
  name: 'Авачинский вулкан',
  locationType: 'volcano',
  safety: SAFETY,
  realtime: realtime({ status: 'yellow', activeAlerts: ['Штормовое предупреждение: ветер до 30 м/с'] }),
  volcanoStatus: null,
  eco: null,
  ...over,
});

const show = (answer: SafetyToolAnswer) => render(<SafetyToolResult answer={answer} onReset={() => {}} />);

/** Чего в результате быть не должно ни при каком ответе: прежняя своя оценка и тексты модели. */
function expectNoOwnAssessment(): void {
  const text = document.body.textContent ?? '';
  expect(text).not.toMatch(/\d\s*\/\s*5/);
  expect(text).not.toMatch(/(Низкий|Умеренный|Повышенный|Высокий|Экстремальный) риск/);
  expect(text).not.toContain('Кузьмич говорит');
  expect(text).not.toContain('Рекомендации');
}

describe('место — теми же блоками, что его карточка', () => {
  it('обстановка дня — слова блока карточки, с причиной и временем пересчёта', () => {
    const p = place();
    show({ kind: 'place', distanceKm: null, place: p });
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('Есть предупреждение — прочитайте, прежде чем ехать');
    expect(status.textContent).toContain('Штормовое предупреждение: ветер до 30 м/с');
    expect(status.textContent).toContain('Сводки пересчитаны');

    // Тот же блок карточки с теми же данными говорит те же слова.
    cleanup();
    render(<PlaceRealtimeStatus realtime={p.realtime!} isVolcano volcanoColor={null} />);
    expect(screen.getByRole('status').textContent).toContain('Есть предупреждение — прочитайте, прежде чем ехать');
  });

  it('своей оценки нет: ни числа риска, ни текстов модели', () => {
    show({ kind: 'place', distanceKm: null, place: place() });
    expectNoOwnAssessment();
  });

  it('пересчёта у места нет — «не знаем» словами, а не пустое место', () => {
    show({ kind: 'place', distanceKm: null, place: place({ realtime: null }) });
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('Обстановку сейчас не знаем');
    expect(status.textContent).not.toContain('Предупреждений по месту нет');
  });

  it('место закрыто — «закрыто» видно', () => {
    show({ kind: 'place', distanceKm: null, place: place({ realtime: realtime({ isOpen: false, alertMessage: 'Закрыто из-за медведей' }) }) });
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('Закрыто для посещения');
    expect(status.textContent).toContain('Закрыто из-за медведей');
  });

  it('совет Кузьмича — из данных, той же сборкой, что на карточке, и согласован с обстановкой', () => {
    const p = place();
    show({ kind: 'place', distanceKm: null, place: p });
    const advisory = advisoryForPlace(p);
    const headline = screen.getByText(/Кузьмич — сегодня здесь:/);
    expect(headline.textContent).toContain(advisory.headline);
    const block = headline.closest('.ds-card')!;
    for (const line of advisory.lines) expect(block.textContent).toContain(line);
    // Жёлтый день — не «спокойно»: совет не расходится с полосой обстановки.
    expect(advisory.tone).toBe('caution');
  });

  it('закрытое место — совет не зовёт идти; пересчёта нет — совет не «спокойно»', () => {
    const closed = advisoryForPlace(place({ realtime: realtime({ isOpen: false }) }));
    expect(closed.tone).toBe('danger');
    const unknown = advisoryForPlace(place({ realtime: null, safety: { ...SAFETY, hazardTypes: [] } }));
    expect(unknown.tone).toBe('unknown');
    // Сборка — та же функция, что считает совет на карточке места.
    const p = place({ volcanoStatus: { colorCode: 'orange', ashHeightM: null, summary: null, sourceUrl: null, observedAt: new Date().toISOString() } });
    expect(advisoryForPlace(p)).toEqual(buildPlaceAdvisory({
      volcano: { colorCode: 'orange', observedAt: p.volcanoStatus!.observedAt },
      realtime: { ...placeDayStatus(p.realtime!), activeAlerts: p.realtime!.activeAlerts },
      hazardTypes: p.safety.hazardTypes,
    }));
  });

  it('опасности не записаны — сказано словами', () => {
    show({ kind: 'place', distanceKm: null, place: place({ safety: { ...SAFETY, hazardTypes: [], registrationRequired: false } }) });
    expect(screen.getByText(/Опасности этого места у нас не записаны/)).toBeTruthy();
  });

  it('есть ссылка на карточку места и раздел «Что знать» с кнопкой 112', () => {
    const p = place();
    show({ kind: 'place', distanceKm: null, place: p });
    expect(screen.getByRole('link', { name: /Открыть карточку места/ }).getAttribute('href')).toBe(`/places/${p.id}`);
    const know = screen.getByRole('heading', { name: 'Что знать' }).closest('section')!;
    expect(within(know).getByText('112')).toBeTruthy();
  });
});

describe('GPS: далёкое место за «ваше» не выдаётся', () => {
  it('место рядом — названо расстояние и к чему относится оценка', () => {
    show({ kind: 'place', distanceKm: 3, place: place() });
    const text = document.body.textContent ?? '';
    expect(text).toContain('в 3 км от вас');
    expect(text).toContain('Оценка ниже относится к этому месту, а не к точке, где вы стоите');
  });

  it('выбрано по названию — строки о расстоянии нет', () => {
    show({ kind: 'place', distanceKm: null, place: place() });
    expect(document.body.textContent).not.toContain('от вас');
  });

  it('меньше километра — без ложной точности', () => {
    expect(distanceWords(0)).toBe('меньше километра от вас');
    expect(distanceWords(7)).toBe('в 7 км от вас');
  });

  it('ближайшее место далеко — оценки нет, место и расстояние названы, 112 есть', () => {
    show({ kind: 'far', nearest: { id: 'a1', slug: 'vulkan-ksudach', name: 'Вулкан Ксудач', locationType: 'volcano', distanceKm: 43 } });
    const text = document.body.textContent ?? '';
    expect(screen.getByRole('heading', { name: 'Что там, где вы стоите, мы не знаем' })).toBeTruthy();
    expect(text).toContain(`В пределах ${NEAREST_PLACE_MAX_KM} км от вас мест в нашей базе нет`);
    expect(text).toContain('Вулкан Ксудач');
    expect(text).toContain('в 43 км от вас');
    // Блока обстановки чужого места на экране нет.
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('link', { name: /Открыть карточку: Вулкан Ксудач/ }).getAttribute('href')).toBe('/places/vulkan-ksudach');
    expect(screen.getByRole('link', { name: /Обстановка в крае/ }).getAttribute('href')).toBe('/safety');
    expect(screen.getByRole('link', { name: /Экстренный вызов — 112/ }).getAttribute('href')).toBe('tel:112');
    expectNoOwnAssessment();
  });

  it('у далёкого места без адреса-слова ссылка ведёт по его номеру', () => {
    show({ kind: 'far', nearest: { id: 'a1b2', slug: null, name: 'Мыс', locationType: null, distanceKm: 12 } });
    expect(screen.getByRole('link', { name: /Открыть карточку: Мыс/ }).getAttribute('href')).toBe('/places/a1b2');
  });

  it('человек вне края и «мест нет» — разные слова, и 112 есть в обоих', () => {
    show({ kind: 'outside' });
    expect(screen.getByRole('heading', { name: 'Вы вне Камчатского края' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Экстренный вызов — 112/ })).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
    cleanup();
    show({ kind: 'none' });
    expect(screen.getByRole('heading', { name: 'Мест рядом не нашлось' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Экстренный вызов — 112/ })).toBeTruthy();
  });
});

describe('маршрут — та же оценка дня, что на его карточке', () => {
  const signals: RouteSignals = {
    alerts: [],
    volcanoes: [],
    inSeason: true,
    weather: null,
    closures: [{ title: 'Парк «Налычево» закрыт для посещения', kind: 'park' }] as RouteSignals['closures'],
  };
  const verdict = goVerdict(signals);
  const answer: Extract<SafetyToolAnswer, { kind: 'route' }> = {
    kind: 'route',
    route: { cardId: '22222222-2222-4222-8222-222222222222', title: 'Пиначево — Центральный', hazards: ['bears'], registrationRequired: true },
    verdict: { ...verdict, label: VERDICT_LABELS[verdict.status] },
    signals,
  };

  it('слово оценки и причина — те же, что рисует блок карточки маршрута', () => {
    show(answer);
    const toolText = document.body.textContent ?? '';
    expect(toolText).toContain(VERDICT_LABELS[verdict.status]);
    expect(toolText).toContain(verdict.reason);

    cleanup();
    render(<RouteVerdict routeId="" data={{ verdict: answer.verdict, signals }} />);
    const cardText = document.body.textContent ?? '';
    expect(cardText).toContain(VERDICT_LABELS[verdict.status]);
    expect(toolText).toContain(cardText);
  });

  it('второго запроса за оценкой нет: данные пришли с ответом', () => {
    show(answer);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('ссылка на карточку маршрута — по номеру карточки; 112 есть; своей оценки нет', () => {
    show(answer);
    expect(screen.getByRole('link', { name: /Открыть карточку маршрута/ }).getAttribute('href')).toBe(`/routes/${answer.route.cardId}`);
    const call = screen.getByRole('link', { name: /Экстренный вызов — 112/ });
    expect(call.getAttribute('href')).toBe('tel:112');
    expect(call.textContent).toContain(EMERGENCY_PRIMARY.name);
    expectNoOwnAssessment();
  });

  it('опасности маршрута не записаны — сказано словами', () => {
    show({ ...answer, route: { ...answer.route, hazards: [], registrationRequired: false } });
    expect(screen.getByText(/Опасности этого маршрута у нас не записаны/)).toBeTruthy();
  });
});

describe('«Новый запрос»', () => {
  it('кнопка зовёт сброс', () => {
    const onReset = vi.fn();
    render(<SafetyToolResult answer={{ kind: 'none' }} onReset={onReset} />);
    screen.getByRole('button', { name: 'Новый запрос' }).click();
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});
