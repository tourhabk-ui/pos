// @vitest-environment node
/**
 * Проба канала КБГС в MAX: только читает, и умеет отличить пост С ДАТОЙ от
 * строки страницы без даты.
 *
 * Повод (24.09, владелец: «бери цунами из MAX kbgsras»): канал МЧС в MAX мы
 * читаем строками без дат — дата каждой «сейчас». Для КБГС это превратило бы
 * старый пост «Угроза цунами» с витрины канала в свежую тревогу для всех
 * туристов. Поэтому приём пишется по итогу пробы, а проба держится здесь:
 * она ничего не пишет, отказ не выдаёт за «в канале тихо», и посты с датой
 * считает отдельно от строк без неё.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { censusMaxPage, MAX_KBGSRAS_URL } from '@/lib/services/safety/max-channel';

const ROOT = process.cwd();
const SRC = readFileSync(join(ROOT, 'app/api/cron/max-channel-probe/route.ts'), 'utf-8');
const WF = readFileSync(join(ROOT, '.github/workflows/max-channel-probe.yml'), 'utf-8');
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

describe('проба только читает', () => {
  it('экспортирует только GET', () => {
    expect(SRC).toMatch(/export async function GET/);
    expect(SRC).not.toMatch(/export async function (POST|PUT|PATCH|DELETE)/);
  });

  it('не пишет и не зовёт запись', () => {
    expect(code).not.toMatch(/UPDATE\s|INSERT INTO|DELETE FROM/);
    // Сухой прогон — это классификатор, а не приём: saveEvent/ingest* здесь
    // означали бы, что «проба» выпускает тревоги.
    expect(code).not.toMatch(/saveEvent|saveQuakeOnce|ingest[A-Z]/);
  });

  it('авторизация — CRON_SECRET постоянным временем, 401 объясняет себя', () => {
    expect(code).toContain('timingSafeCompare');
    expect(code).toContain('diagnoseCronAuth');
  });

  it('маркер версии есть', () => {
    expect(SRC).toMatch(/max_channel_probe_v\d+/);
  });

  it('адрес канала — одна константа', () => {
    expect(MAX_KBGSRAS_URL).toBe('https://max.ru/kbgsras');
    expect(code).not.toMatch(/max\.ru\/kbgsras['"`]/);
  });
});

describe('пост с датой отличается от строки без даты', () => {
  const PAGE = `<html><head><title>КБГС РАН — MAX</title></head><body>
    <div>Камчатский филиал ФИЦ ЕГС РАН. Оперативная информация о землетрясениях и предупреждения о цунами.</div>
    <script type="application/json">{"channel":{"posts":[
      {"id":"901","text":"Землетрясение ML=5.8, 120 км от Петропавловска. Угроза цунами не ожидается.","date":1790000000},
      {"id":"900","message":"Объявлена угроза цунами для восточного побережья Камчатки.","createdAt":"2026-03-01T04:00:00Z"}
    ]}}</script>
  </body></html>`;
  const c = censusMaxPage(PAGE);

  it('посты с датой найдены во встроенном JSON', () => {
    expect(c.datedPosts.length).toBe(2);
    expect(c.datedPosts.map((p) => p.id).sort()).toEqual(['900', '901']);
  });

  it('дата — своя у каждого поста, а не «сейчас»', () => {
    const old = c.datedPosts.find((p) => p.id === '900');
    expect(old?.time).toBe('2026-03-01T04:00:00.000Z');
  });

  it('эпоха в секундах читается как дата', () => {
    const p = c.datedPosts.find((x) => x.id === '901');
    expect(p?.time).toBe(new Date(1790000000 * 1000).toISOString());
  });

  it('описание канала — строка без даты, а не пост', () => {
    expect(c.lines.some((l) => l.startsWith('Камчатский филиал'))).toBe(true);
    expect(c.datedPosts.some((p) => p.text.startsWith('Камчатский филиал'))).toBe(false);
  });

  it('страница без данных — ноль постов с датой, а не выдуманные', () => {
    const empty = censusMaxPage('<html><body><p>Откройте канал в приложении MAX, чтобы читать сообщения.</p></body></html>');
    expect(empty.datedPosts).toEqual([]);
  });

  it('закрывающий тег скрипта читается как браузером', () => {
    // CodeQL js/bad-tag-filter, 24.09: `</script\t\n bar>` закрывает скрипт,
    // а строгое `</script\s*>` его пропускало.
    const odd = censusMaxPage(
      '<script type="application/json">{"id":"1","text":"Землетрясение ML=4.2 в 110 км от Петропавловска.","date":1790000000}</script\t\n bar>' +
      '<p>хвост страницы</p>',
    );
    expect(odd.datedPosts.length).toBe(1);
  });

  it('неправдоподобное время датой не считается', () => {
    const bad = censusMaxPage('<script type="application/json">{"text":"Объявлена угроза цунами для побережья.","time":12}</script>');
    expect(bad.datedPosts).toEqual([]);
  });
});

describe('прогон не выдаёт отказ за «в канале тихо»', () => {
  it('вердикт по success, при отказе — красный с телом', () => {
    const at = WF.indexOf("d.get('success') is not True");
    expect(at).toBeGreaterThan(0);
    expect(WF.slice(at, at + 500)).toContain('sys.exit(1)');
    expect(WF).toContain('Тело ответа целиком');
  });

  it('пустой ответ — громкий отказ', () => {
    expect(WF).toMatch(/if \[ -z "\$RESP" \]; then/);
  });

  it('ложная тревога в сухом прогоне помечается глазами', () => {
    expect(WF).toContain('ЛОЖНАЯ ТРЕВОГА?');
  });

  it('ждёт свою сборку', () => {
    expect(WF).toContain('wait-for-deploy.sh');
    expect(WF).toMatch(/REQUIRE_FRESH: '1'/);
  });
});
