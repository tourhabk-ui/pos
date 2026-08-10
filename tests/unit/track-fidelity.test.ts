/**
 * Линия между точками не выдаётся за тропу.
 *
 * У части маршрутов geometry построена миграцией 168 — прямыми отрезками от
 * точки к точке. В её собственном комментарии это названо честно: «This gives
 * a rough visual track on the map». Но до экрана оговорка не доезжала:
 * ломаная приходила тем же полем `track`, рисовалась тем же сплошным зелёным
 * в четыре пикселя и ничем не отличалась от снятого GPS-трека.
 *
 * В поле разница решающая. По снятому треку идти можно. Прямая между двумя
 * точками на камчатском рельефе проходит через каньон, стену и реку — и
 * выглядит на карте ровно так же уверенно.
 *
 * Флага в данных нет: миграция ничего не проставила. Различаем по плотности
 * точек, и порог занижен намеренно — ошибаться можно только в сторону
 * «назвали наброском настоящий трек».
 */
import { describe, it, expect } from 'vitest';
import {
  trackFidelity, trackFidelityLabel, trackFidelityStyle, trackLengthKm,
  type LatLng,
} from '@/lib/routes/track-fidelity';

/** Прямая линия заданной длины из n точек — модель ломаной из миграции 168. */
function straight(km: number, n: number): LatLng[] {
  const dLat = km / 111.32;
  return Array.from({ length: n }, (_, i) => [53 + (dLat * i) / (n - 1), 158] as LatLng);
}

describe('длина ломаной считается', () => {
  it('градус широты — около 111 км', () => {
    expect(trackLengthKm([[53, 158], [54, 158]])).toBeGreaterThan(110);
    expect(trackLengthKm([[53, 158], [54, 158]])).toBeLessThan(113);
  });

  it('одна точка длины не имеет', () => {
    expect(trackLengthKm([[53, 158]])).toBe(0);
  });
});

describe('набросок отличается от снятого трека', () => {
  it('три точки на двадцать километров — набросок', () => {
    // Ровно то, что делает миграция 168: старт маршрута плюс путевые точки.
    expect(trackFidelity(straight(20, 3))).toBe('sketch');
  });

  it('две точки на сто километров — тем более набросок', () => {
    expect(trackFidelity(straight(100, 2))).toBe('sketch');
  });

  it('снятый трек, прорезанный до 600 точек на 100 км, остаётся треком', () => {
    // Сервер режет трек для карты; проверка не должна на этом ломаться.
    expect(trackFidelity(straight(100, 600))).toBe('surveyed');
  });

  it('плотный трек на короткой дистанции — трек', () => {
    expect(trackFidelity(straight(5, 300))).toBe('surveyed');
  });
});

describe('о чём не знаем — не судим', () => {
  it('пустой и одноточечный вход', () => {
    expect(trackFidelity(null)).toBe('unknown');
    expect(trackFidelity([])).toBe('unknown');
    expect(trackFidelity([[53, 158]])).toBe('unknown');
  });

  it('слишком короткий маршрут по плотности не судится', () => {
    // На километре деление на малое число превращает оценку в шум, и назвать
    // честный трек наброском здесь так же неверно, как обратное.
    expect(trackFidelity(straight(1, 3))).toBe('unknown');
  });
});

describe('разница видна и глазом, и словом', () => {
  it('снятый трек рисуется сплошным, набросок — пунктиром и тоньше', () => {
    const s = trackFidelityStyle('surveyed');
    const k = trackFidelityStyle('sketch');
    expect(s.dashArray).toBeUndefined();
    expect(k.dashArray).toBeTruthy();
    expect(k.weight).toBeLessThan(s.weight);
    expect(k.color).not.toBe(s.color);
  });

  it('у наброска есть подпись, и она запрещает идти по линии', () => {
    expect(trackFidelityLabel('sketch')).toMatch(/не тропа|нельзя идти/i);
  });

  it('у снятого трека подписи нет — молчание и означает «настоящий»', () => {
    expect(trackFidelityLabel('surveyed')).toBe('');
  });

  it('неизвестное происхождение названо, а не приравнено к треку', () => {
    expect(trackFidelityLabel('unknown')).not.toBe('');
    expect(trackFidelityStyle('unknown').dashArray).toBeTruthy();
  });
});
