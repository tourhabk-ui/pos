/**
 * Бэкфилл фото точек: cron-эндпоинт (CRON_SECRET, пачками) + воркфлоу-цикл.
 * Структурный страж: авторизация по секрету, лимит пачки, цикл до remaining=0.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const route = readFileSync('app/api/cron/backfill-place-images/route.ts', 'utf8');
const wf = readFileSync('.github/workflows/cron-place-images.yml', 'utf8');

describe('cron backfill-place-images', () => {
  it('авторизация по CRON_SECRET (timingSafeCompare), не admin', () => {
    expect(route).toMatch(/getCronSecret/);
    expect(route).toMatch(/timingSafeCompare\(secret, process\.env\.CRON_SECRET/);
    expect(route).toMatch(/status:\s*401/);
  });

  it('берёт только точки без фото и ограничивает пачку', () => {
    expect(route).toMatch(/getRoutesWithoutImages/);
    expect(route).toMatch(/MAX_BATCH/);
    expect(route).toMatch(/remaining/);
  });
});

describe('workflow cron-place-images', () => {
  it('ждёт деплой эндпоинта (проба 401) и крутит цикл до remaining=0', () => {
    expect(wf).toMatch(/HTTP 401/);
    expect(wf).toMatch(/remaining/);
    expect(wf).toMatch(/REMAIN.*=.*0|"\$REMAIN" = "0"/);
  });

  it('расписания НЕТ — генерация остановлена решением владельца 29.07', () => {
    // Инвариант перевернулся, и это намеренно. Раньше сторож требовал
    // расписание: конвейер должен был догонять точки без фото. С 17.07
    // сгенерированные изображения нигде не показываются (карточка рисует
    // честный градиент), а 29.07 владелец закрыл развилку issue #878 в
    // сторону «не генерировать»: фотореалистичная иллюстрация вулкана
    // читается как фотография вулкана, подписи не спасают.
    //
    // Проверяем именно отсутствие блока schedule, а не его закомментированность:
    // вернуть расписание должно быть осознанным действием, а не побочным
    // эффектом чьей-то правки отступов.
    const code = wf.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(code, 'расписание вернулось — генерация снова идёт по ночам').not.toMatch(/^\s*schedule:/m);
  });

  it('ручной запуск остался — решение обратимо', () => {
    expect(wf).toMatch(/workflow_dispatch:/);
    expect(wf).toMatch(/cancel-in-progress:\s*false/);
  });
});
