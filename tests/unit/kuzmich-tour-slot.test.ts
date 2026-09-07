/**
 * Вечерний слот Кузьмича продаёт: туры вместо сезонных постов.
 *
 * Владелец 05.09: «я не вижу постов у Кузьмича про реальные туры — вместо
 * сезонов можно публиковать туры». С 24.08 слот 19:00 KMT чередовал
 * sezon/tour по чётности дня, но чередование жило в выборе по часу, а внешний
 * планировщик зовёт эндпоинт с явным type=sezon — явный тип побеждал, и
 * ветка tour могла не выполниться ни разу. Как настроен cron-job.org, из
 * репозитория не узнать, поэтому решение от него не зависит: sezon ОЗНАЧАЕТ
 * тур, и по часу вечерний слот тоже отдаёт тур.
 *
 * Текст тура — тот же, что у ручной публикации (buildTourPostText, только
 * поля карточки): модель просила «дать почувствовать сам тур», то есть
 * ощущений, которых в карточке нет. Судим код, а не прозу.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePostType, pickTypeByHour } from '@/lib/notifications/kuzmich-post-slot';

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const read = (p: string) => strip(readFileSync(join(process.cwd(), p), 'utf-8'));

describe('sezon означает тур', () => {
  it('явный type=sezon даёт тур и честно называет, что просили', () => {
    expect(resolvePostType('sezon')).toEqual({ type: 'tour', requested: 'sezon' });
  });

  it('вечерний слот по часу — тур в любой день, чётный и нечётный', () => {
    for (const day of [4, 5]) {
      const d = new Date(Date.UTC(2026, 8, day, 7, 0, 0));
      expect(pickTypeByHour(d), `день ${day}`).toBe('tour');
      expect(resolvePostType(null, d).type, `день ${day}`).toBe('tour');
    }
  });

  it('утро — место, день — совет, явные типы проходят как есть', () => {
    expect(pickTypeByHour(new Date(Date.UTC(2026, 8, 5, 21)))).toBe('route');
    expect(pickTypeByHour(new Date(Date.UTC(2026, 8, 5, 2)))).toBe('tip');
    expect(resolvePostType('tip')).toEqual({ type: 'tip' });
    expect(resolvePostType('мусор', new Date(Date.UTC(2026, 8, 5, 7))).type).toBe('tour');
  });

  it('крон-роут решает слот через общий модуль и не зовёт сезонный пост', () => {
    const route = read('app/api/cron/kuzmich/route.ts');
    expect(route).toMatch(/resolvePostType\(searchParams\.get\('type'\)\)/);
    expect(route).not.toMatch(/postSezonToChannel/);
    expect(route).toMatch(/requested: resolved\.requested/);
  });
});

describe('пост о туре в слоте — из карточки, без модели', () => {
  const channel = read('lib/notifications/telegram-channel.ts');
  const body = channel.match(/export async function postKuzmichTour[\s\S]*?\n\}/)?.[0] ?? '';

  it('публикатор найден', () => {
    expect(body).not.toBe('');
  });

  it('текст строит buildTourPostText, вызова модели нет', () => {
    expect(body).toMatch(/buildTourPostText\(t, appUrl\)/);
    expect(body).not.toMatch(/callAI|getModelForAgent|prompt/);
  });

  it('снимки — оператора, альбомом; без фото поста нет', () => {
    expect(body).toMatch(/array_length\(ot\.photos, 1\), 0\) > 0/);
    expect(body).toMatch(/photoUrls\.length === 0/);
    expect(body).toMatch(/postType: 'kuzmich_tour', text, photoUrls/);
  });

  it('ротация — по давности публикации, а не 7-дневным исключением при пуле в 8', () => {
    expect(body).toMatch(/ORDER BY lp\.last_posted_at ASC NULLS FIRST/);
    expect(body).toMatch(/TOUR_REPEAT_MIN_GAP_DAYS/);
    expect(channel).toMatch(/export const TOUR_REPEAT_MIN_GAP_DAYS = (1|2|3);/);
  });

  it('ротация видит и ручные публикации тура', () => {
    expect(body).toMatch(/action_type IN \('kuzmich_tour_post', 'tour_channel_post'\)/);
  });
});
