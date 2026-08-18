/**
 * Облёт — не пеший маршрут.
 *
 * Черта спрашивает, можно ли обещать, что по линии человека проведут. Вопрос
 * предполагает, что по линии ИДУТ: сходят с неё, возвращаются, сверяются с
 * точками. У вертолётной программы ничего этого нет.
 *
 * Разбор 18.08 показал цену смешения: «Облет Мутновского и Горелого» получил
 * отказ «точка стоит в 4.9 км от линии» — причина, которой не существует: с
 * курса вертолёта не сворачивают к фумароле. Владелец: «облет это не пеший
 * маршрут».
 *
 * Сторож держит две вещи: воздух выводится из-под черты со СВОИМ вердиктом
 * (а не сваливается к битым данным), и способ передвижения только снимает
 * обещание, никогда его не выдаёт.
 */
import { describe, it, expect } from 'vitest';
import { detectTravelMode, lineIsTraversed } from '@/lib/routes/travel-mode';
import { routeNavigability, navigabilityCtaLabel } from '@/lib/routes/navigability';

const line: Array<[number, number]> = Array.from({ length: 30 }, (_, i) => [
  52.5 + i * 0.002,
  158.2,
]);

describe('способ передвижения по имени записи', () => {
  it('воздух опознаётся в обоих написаниях «облёта»', () => {
    expect(detectTravelMode('Облет Мутновского и Горелого')).toBe('air');
    expect(detectTravelMode('Облёт Долины гейзеров')).toBe('air');
    expect(detectTravelMode('Вертолётная экскурсия в Долину гейзеров')).toBe('air');
  });

  it('наземные способы остаются наземными', () => {
    expect(detectTravelMode('Сплав по реке Быстрая')).toBe('water');
    expect(detectTravelMode('Горный массив Вачкажец (лыжный)')).toBe('snow');
    expect(detectTravelMode('Джип-тур на Толбачик')).toBe('vehicle');
    expect(detectTravelMode('Восхождение на Авачинский вулкан')).toBe('foot');
  });

  it('воздух побеждает при смешанном имени', () => {
    // «Вертолётная заброска на сплав» — всё ещё вертолёт. Обратное прочтение
    // вернуло бы записи обещание ведения.
    expect(detectTravelMode('Вертолётная заброска на сплав по Жупанова')).toBe('air');
  });

  it('линию проходят везде, кроме воздуха', () => {
    expect(lineIsTraversed('foot')).toBe(true);
    expect(lineIsTraversed('water')).toBe(true);
    expect(lineIsTraversed('snow')).toBe(true);
    expect(lineIsTraversed('vehicle')).toBe(true);
    expect(lineIsTraversed('air')).toBe(false);
  });
});

describe('черта и облёт', () => {
  const args = {
    grade: 'surveyed' as const,
    track: line,
    waypoints: [{ lat: 52.52, lng: 158.2 }, { lat: 52.7, lng: 158.9 }],
    waypointTypes: ['hot_spring', 'hot_spring'],
  };

  it('облёт получает СВОЙ вердикт, а не «маршрутом не является»', () => {
    const nav = routeNavigability({ ...args, mode: 'air' });
    expect(nav.verdict).toBe('not_on_foot');
    expect(nav.canLead).toBe(false);
    // Причина названа своими словами, а не расстоянием до линии.
    expect(nav.reasons.join(' ')).toContain('облёт');
    expect(nav.reasons.join(' ')).not.toContain('км от линии');
  });

  it('исправная запись не смешивается с битыми данными', () => {
    // «Маршрутом не является» — про сломанную запись. Облёт исправен, просто
    // вопрос черты к нему не относится, и цифры этих двух состояний нельзя
    // складывать.
    expect(routeNavigability({ ...args, mode: 'air' }).verdict).not.toBe('not_a_route');
  });

  it('ни навигатора, ни ориентирования у облёта нет', () => {
    expect(navigabilityCtaLabel('not_on_foot')).toBeNull();
  });

  it('наземные способы судятся как раньше', () => {
    for (const mode of ['foot', 'water', 'snow', 'vehicle'] as const) {
      const nav = routeNavigability({ ...args, mode });
      expect(nav.verdict).not.toBe('not_on_foot');
    }
  });

  it('без указания способа поведение прежнее', () => {
    // Старый кэш ответа не должен внезапно объявлять записи облётами.
    expect(routeNavigability(args).verdict).not.toBe('not_on_foot');
  });
});
