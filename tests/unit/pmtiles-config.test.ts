/**
 * Конфиг сборки своей карты.
 *
 * Прогон идёт два часа и качает сотни мегабайт, поэтому ошибку в рамке или
 * зумах дешевле поймать здесь, чем через два часа по весу файла. Тесты
 * стерегут ровно то, из-за чего сборка окажется бесполезной: рамка мимо
 * Камчатки, зумы не те, конвейер начал что-то деплоить.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const cfg = JSON.parse(
  readFileSync(join(process.cwd(), '.github/triggers/pmtiles.json'), 'utf-8'),
) as {
  osmUrl: string; bounds: string; minzoom: number; maxzoom: number; planetilerVersion: string;
};
const wf = readFileSync(join(process.cwd(), '.github/workflows/data-pmtiles.yml'), 'utf-8');

describe('рамка накрывает Камчатку', () => {
  const [west, south, east, north] = cfg.bounds.split(',').map(Number);

  it('четыре числа в порядке запад,юг,восток,север', () => {
    expect([west, south, east, north].every(Number.isFinite)).toBe(true);
    expect(west).toBeLessThan(east);
    expect(south).toBeLessThan(north);
  });

  it('Петропавловск, Ключевская и Командоры внутри', () => {
    // Три угла обитаемой Камчатки. Промах рамки виден только по весу файла
    // через два часа сборки — здесь он виден сразу.
    const inside = (lat: number, lng: number) =>
      lat >= south && lat <= north && lng >= west && lng <= east;
    expect(inside(53.02, 158.65)).toBe(true);   // Петропавловск
    expect(inside(56.06, 160.64)).toBe(true);   // Ключевская сопка
    expect(inside(55.20, 165.98)).toBe(true);   // остров Беринга
    expect(inside(51.45, 157.00)).toBe(true);   // Курильское озеро, юг
  });

  it('рамка не разрослась на весь Дальний Восток', () => {
    // Без --bounds в файл уехал бы Владивосток и Магадан: вес втрое, польза
    // нулевая.
    expect(east - west).toBeLessThan(20);
    expect(north - south).toBeLessThan(20);
  });
});

describe('зумы выбраны под пеший маршрут', () => {
  it('хранение до 14: дальше вектор дорисовывается на устройстве', () => {
    // 14 — потолок ХРАНЕНИЯ, не показа. У растра так нельзя, там каждый зум
    // качается отдельно, и в этом вся разница в весе.
    expect(cfg.maxzoom).toBeGreaterThanOrEqual(13);
    expect(cfg.maxzoom).toBeLessThanOrEqual(15);
    expect(cfg.minzoom).toBe(0);
  });

  it('версия сборщика зафиксирована, а не «latest»', () => {
    // Плавающая версия делает вес и схему невоспроизводимыми: сравнивать
     // прогоны между собой станет не с чем.
    expect(cfg.planetilerVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('конвейер ничего не деплоит', () => {
  it('результат уходит артефактом, а не в репозиторий и не на прод', () => {
    // Фаза 1 по плану — замер. Решение о переезде принимается по весу файла,
    // и до этого решения runtime не трогается.
    expect(wf).toMatch(/upload-artifact/);
    expect(wf).not.toMatch(/git push/);
    // Проверяем ИНВАРИАНТ «не ходит на прод», а не упоминание домена: адрес
    // vedarai.ru законно стоит в заголовке Origin, которым проверяется CORS
    // хранилища. Это вопрос к бакету, а не обращение к приложению.
    expect(wf).not.toMatch(/vedarai\.ru\/api/);
    expect(wf).toMatch(/permissions:\s*\n\s*contents: read/);
  });

  it('рамка и источник берутся из конфига, а не зашиты в шаге', () => {
    expect(wf).toMatch(/--bounds="\$BOUNDS"/);
    expect(wf).toMatch(/--osm-url="\$OSM_URL"/);
  });

  it('источник — прямая ссылка, а не псевдоним с нечётким поиском', () => {
    // Первый прогон 09.08 упал на псевдониме geofabrik: — «No matches for
    // russia-far-eastern-fed-district». Ошибка в одном слове видна только в
    // момент запуска, и то не сразу.
    expect(cfg.osmUrl).toMatch(/^https:\/\/.+\.osm\.pbf$/);
    // Проверяем КОМАНДУ, а не текст файла: в комментарии слово «geofabrik:»
    // стоит законно — там объяснено, почему от псевдонима отказались.
    expect(wf).not.toMatch(/--osm-url="geofabrik:/);
    expect(wf).not.toMatch(/--area=/);
  });

  it('доступность источника проверяется ДО скачивания', () => {
    // Иначе опечатка всплывает после семисот мегабайт загрузки.
    const check = wf.indexOf('Check source is reachable');
    const build = wf.indexOf('Build Kamchatka vector tiles');
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(build);
  });

  it('вес печатается и превышение названо вслух', () => {
    expect(wf).toMatch(/Своя карта Камчатки: \$\{MB\} МБ/);
    expect(wf).toMatch(/больше гигабайта/);
  });

  it('атрибуция OSM не забыта — это условие ODbL, а не вежливость', () => {
    expect(wf).toMatch(/OpenStreetMap contributors, ODbL/);
  });
});

describe('выкладка в хранилище', () => {
  it('пропускается молча, пока секретов нет', () => {
    // Конвейер замера обязан работать и без хранилища: на нём принималось
    // решение о переезде, ломать его настройкой нельзя.
    expect(wf).toMatch(/if: \$\{\{ env\.S3_BUCKET != '' \}\}/);
  });

  it('имя файла с датой, а не «latest»', () => {
    // Файл, меняющийся под тем же адресом, ломает возобновление закачки:
    // куски старой и новой версии сшились бы в файл, которого не было.
    expect(wf).toMatch(/kamchatka-\$\(date -u \+%Y%m%d\)\.pmtiles/);
    expect(wf).not.toMatch(/kamchatka-latest\.pmtiles/);
  });

  it('Range и CORS проверяются раннером, а не надеждой', () => {
    // Без 206 формат бесполезен; без открытых заголовков возобновление
    // сломается молча — тело придёт, а размер и версию прочитать будет нечем.
    expect(wf).toMatch(/206/);
    expect(wf).toMatch(/access-control-allow-origin/);
    expect(wf).toMatch(/Content-Range/);
  });
});
