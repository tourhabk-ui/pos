/**
 * Готова ли карта маршрута к выходу — по записи о закачке И по пробе
 * Cache Storage (29.10, #2558, #2789).
 *
 * До этого карточка маршрута после перезагрузки читала только запись в
 * localStorage и ставила «Готово к офлайн», хотя запись ставится и при
 * частичной закачке, а система вправе вычистить кэш, не тронув запись.
 * Экран планирования уже проверял заявление пробой (`probeCoverage`) —
 * здесь то же правило, одной функцией на карточку и тест.
 *
 * Исходы (§4.0): готово / докачать (не всё легло или карты в телефоне
 * меньше обещанного) / нет в телефоне / проверить нечем — последнее не
 * равно «готово», и слово «проверено» при нём не произносится.
 */
import { coverageIsShort, coverageLabel, type CoverageReport } from '@/lib/offline/coverage';
import { savedAtLabel, type SavedMapRecord } from '@/lib/offline/saved-map';

export type RouteMapReadiness =
  | { state: 'ready'; note: string }
  | { state: 'redo'; note: string }
  | { state: 'unchecked'; note: string };

export function routeMapReadiness(
  rec: SavedMapRecord,
  coverage: CoverageReport | null,
  now = Date.now(),
): RouteMapReadiness {
  if (rec.failedFiles > 0) {
    return {
      state: 'redo',
      note: `Карта сохранена не вся: не легло файлов — ${rec.failedFiles}. Повторите, пока есть связь`,
    };
  }
  if (!coverage || coverage.state === 'cannot_check') {
    return {
      state: 'unchecked',
      note: `Карта маршрута в телефоне: ${rec.mb} МБ, ${savedAtLabel(rec.at, now)} — на месте ли она сейчас, проверить не удалось`,
    };
  }
  if (coverage.state === 'none') {
    return {
      state: 'redo',
      note: `Карту сохраняли ${savedAtLabel(rec.at, now)} — сейчас её в телефоне нет. Скачайте заново`,
    };
  }
  if (coverageIsShort(coverage)) {
    return {
      state: 'redo',
      note: `Проверено: ${coverageLabel(coverage)} — докачайте, пока есть связь`,
    };
  }
  return {
    state: 'ready',
    note: `Карта маршрута в телефоне: ${rec.mb} МБ · проверено: ${coverageLabel(coverage)}`,
  };
}
