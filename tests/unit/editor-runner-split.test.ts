/**
 * Сторож разделения труда: описания пишет раннер, база остаётся за продом.
 *
 * ПОВОД. Замер 07.09: с прода OpenRouter отвечает 403 и напрямую, и через
 * релей — ответы совпали ДОСЛОВНО, значит режет край сети по нашему адресу, и
 * релей его не прячет. Флагманы оттуда недостижимы, и `callAIQuality`
 * намеренно ставит первым DeepSeek. Раннер GitHub не в РФ и OpenRouter
 * достигает. Решение владельца: «OpenRouter переключи на гитхаб».
 *
 * Опасность у такого разделения одна и известная: две копии правил. Промпт на
 * проде и промпт на раннере разошлись бы, и половина описаний оказалась бы
 * написана по другим законам, чем вторая. Поэтому общие функции, а не копии, —
 * и сторож смотрит именно за этим.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { buildDescriptionMessages, pickDescriptionFromAnswer, MIN_GENERATION_LENGTH } from '@/lib/agents/editor';

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

const RUNNER = strip(read('scripts/editor-runner.ts'));
const JOB = strip(read('app/api/cron/editor-job/route.ts'));
const RESULT = strip(read('app/api/cron/editor-result/route.ts'));
const WF = read('.github/workflows/editor-runner.yml');

const route = {
  id: '11111111-1111-1111-1111-111111111111',
  title: 'Вулкан Горелый', description: null, category: null, kind: 'place',
  lat: 52.5, lng: 158.0, location_type: 'volcano', activity_type: null,
  zone: null, source_name: null, altitude_m: 1829, terrain_type: null,
  hazard_types: null, difficulty_level: null, nearest_medical_km: null,
  distance_km: null, elevation_gain_m: null, duration_hours: null,
  season: null, route_type: null, hazards: null, equipment: null, park_name: null,
} as unknown as Parameters<typeof buildDescriptionMessages>[0];

describe('правило одно на оба пути', () => {
  it('промпт — общая функция, а не копия в скрипте', () => {
    expect(RUNNER).toMatch(/buildDescriptionMessages/);
    // Своего системного промпта у раннера быть не должно.
    expect(RUNNER).not.toMatch(/Ты эксперт по туризму на Камчатке/);
  });

  it('разбор ответа — тоже общий', () => {
    expect(RUNNER).toMatch(/pickDescriptionFromAnswer/);
    expect(RUNNER).not.toMatch(/parseVerbalizedSamples|pickLeastTypical/);
  });

  it('общие функции работают и без сети', () => {
    const messages = buildDescriptionMessages(route);
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toMatch(/ТОЛЬКО из переданных фактов/);
    expect(messages[1].content).toMatch(/Вулкан Горелый/);

    expect(pickDescriptionFromAnswer(null).text).toBeNull();
    expect(pickDescriptionFromAnswer('коротко').text).toBeNull();
    const long = 'Горелый — действующий вулкан высотой 1829 метров в южной части полуострова.';
    expect(pickDescriptionFromAnswer(long).text).toBe(long);
    expect(long.length).toBeGreaterThanOrEqual(MIN_GENERATION_LENGTH);
  });
});

describe('база остаётся за продом', () => {
  it('раннер в базу не ходит', () => {
    expect(RUNNER).not.toMatch(/db-pool|pool\.query|DATABASE_URL/);
  });

  it('очередь и запись берут ОДИН отбор, а не две выборки', () => {
    expect(JOB).toMatch(/findRoutesNeedingDescription/);
    expect(RESULT).toMatch(/findRoutesNeedingDescription/);
    expect(JOB).not.toMatch(/SELECT/i);
    expect(RESULT).not.toMatch(/SELECT\s+ark\./i);
  });

  it('приёмник не верит присланному id: пишет только то, что есть в очереди', () => {
    expect(RESULT).toMatch(/записи нет в очереди на описание/);
    expect(RESULT).toMatch(/byId\.get\(item\.id\)/);
  });

  it('порог длины у приёмника тот же, что у прод-пути', () => {
    expect(RESULT).toMatch(/MIN_GENERATION_LENGTH/);
  });

  it('происхождение отличает раннер от прода', () => {
    expect(RESULT).toMatch(/editor-ai-runner/);
  });
});

describe('тишина не считается успехом', () => {
  it('нет ключа — отказ с причиной, а не пустой прогон', () => {
    expect(RUNNER).toMatch(/OPENROUTER_API_KEY не задан/);
    expect(RUNNER).toMatch(/process\.exit\(1\)/);
  });

  it('ноль описаний при непустом входе краснит прогон', () => {
    expect(RUNNER).toMatch(/routes\.length > 0 && written === 0/);
  });

  it('прод не отдал очередь — раннер краснеет, а не отчитывается «всё описано»', () => {
    expect(WF).toMatch(/писать нечего, и это не «всё описано»/);
  });

  it('принято меньше отправленного — тоже отказ', () => {
    expect(WF).toMatch(/Записано \$WRITTEN из \$COUNT/);
  });
});
