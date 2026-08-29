/**
 * Передача маршрута в настоящий навигатор.
 *
 * Слово владельца 11.08: «смысл людям пользоваться нашей кривой, если есть
 * другие». Дорогу строят Organic Maps, Яндекс и 2ГИС, и строят лучше нас.
 * Наша часть — тропа и безопасность; довезти до её начала должен тот, кто
 * умеет.
 *
 * Главное, что тут охраняется, — ПОРЯДОК КООРДИНАТ. У Яндекса и Organic Maps
 * `lat,lng`, у 2ГИС `lng,lat`. Перепутанная пара даёт ссылку, которая
 * откроется и будет выглядеть рабочей, увозя человека в другое полушарие.
 * Поэтому проверяем на камчатских числах, где подмена видна сразу.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  routeUrl, pointUrl, navLinks, type NavPoint,
} from '@/lib/navigation/handoff';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

/** Петропавловск-Камчатский. */
const ME: NavPoint = { lat: 53.019500, lng: 158.648300, name: 'Я' };
/** Мыс Маячный — цель полевого скриншота. */
const CAPE: NavPoint = { lat: 52.885700, lng: 158.704000, name: 'Мыс Маячный' };

describe('порядок координат у каждого провайдера свой', () => {
  it('Organic Maps ждёт lat,lng', () => {
    const u = routeUrl('organic', ME, CAPE, 'car')!;
    expect(u).toContain('sll=53.019500,158.648300');
    expect(u).toContain('dll=52.885700,158.704000');
  });

  it('MAPS.ME ждёт lat,lng — та же форма, что у Organic Maps, разный хост', () => {
    const u = routeUrl('maps_me', ME, CAPE, 'car')!;
    expect(u.startsWith('https://dlink.maps.me/route?')).toBe(true);
    expect(u).toContain('sll=53.019500,158.648300');
    expect(u).toContain('dll=52.885700,158.704000');
  });

  it('Яндекс ждёт lat,lng в rtext', () => {
    const u = routeUrl('yandex', ME, CAPE, 'car')!;
    // rtext закодирован целиком: запятая и тильда экранированы
    expect(decodeURIComponent(u)).toContain('rtext=53.019500,158.648300~52.885700,158.704000');
  });

  it('2ГИС ждёт lng,lat — обратный порядок', () => {
    // Ровно здесь и ломаются такие ссылки.
    const u = decodeURIComponent(routeUrl('dgis', ME, CAPE, 'car')!);
    expect(u).toContain('|158.648300,53.019500|158.704000,52.885700');
    expect(u).not.toContain('|53.019500,158.648300');
  });

  it('широта и долгота нигде не совпадают по значению — подмена была бы не видна', () => {
    // Страховка самого теста: на равных числах он ничего бы не проверял.
    expect(ME.lat).not.toBeCloseTo(ME.lng, 1);
    expect(CAPE.lat).not.toBeCloseTo(CAPE.lng, 1);
  });
});

describe('режим передвижения доезжает до ссылки', () => {
  it('пешком — пешеходный профиль у всех четырёх', () => {
    expect(routeUrl('organic', ME, CAPE, 'foot')).toContain('type=pedestrian');
    expect(routeUrl('maps_me', ME, CAPE, 'foot')).toContain('type=pedestrian');
    expect(routeUrl('yandex', ME, CAPE, 'foot')).toContain('rtt=pd');
    expect(routeUrl('dgis', ME, CAPE, 'foot')).toContain('/tab/pedestrian/');
  });

  it('на машине — автомобильный', () => {
    expect(routeUrl('organic', ME, CAPE, 'car')).toContain('type=vehicle');
    expect(routeUrl('maps_me', ME, CAPE, 'car')).toContain('type=vehicle');
    expect(routeUrl('yandex', ME, CAPE, 'car')).toContain('rtt=auto');
    expect(routeUrl('dgis', ME, CAPE, 'car')).toContain('/tab/car/');
  });
});

describe('без старта маршрут не выдумывается', () => {
  it('нет точки старта — маршрутной ссылки нет', () => {
    // Формы «origin пустой, возьми моё местоположение» у провайдеров разные
    // и недодокументированы. Собрать такую наугад значит иногда открыть не то.
    for (const app of ['organic', 'maps_me', 'yandex', 'dgis'] as const) {
      expect(routeUrl(app, null, CAPE, 'car')).toBeNull();
    }
  });

  it('вместо маршрута отдаётся честная ссылка на точку', () => {
    const links = navLinks(null, CAPE, 'car');
    expect(links).toHaveLength(4);
    expect(links.every((l) => l.isRoute === false)).toBe(true);
    expect(links.every((l) => l.url.length > 0)).toBe(true);
  });

  it('старт есть — все три ссылки маршрутные', () => {
    const links = navLinks(ME, CAPE, 'foot');
    expect(links.every((l) => l.isRoute)).toBe(true);
  });

  it('офлайновый Organic Maps идёт первым', () => {
    // На Камчатке связь кончается раньше дороги: единственный из четырёх, кто
    // построит маршрут без сети, должен быть под большим пальцем.
    expect(navLinks(ME, CAPE).map((l) => l.app)[0]).toBe('organic');
  });

  it('MAPS.ME идёт вторым', () => {
    expect(navLinks(ME, CAPE).map((l) => l.app)[1]).toBe('maps_me');
  });
});

describe('негодные координаты не превращаются в ссылку', () => {
  it('0,0 — это потерянная координата, а не Гвинейский залив', () => {
    // Тот же дефект, что подвёл нас на якоре маршрута: Number(null) === 0.
    expect(routeUrl('yandex', ME, { lat: 0, lng: 0 }, 'car')).toBeNull();
    expect(pointUrl('yandex', { lat: 0, lng: 0 })).toBeNull();
    expect(navLinks(ME, { lat: 0, lng: 0 })).toEqual([]);
  });

  it('NaN и выход за пределы Земли отсекаются', () => {
    expect(pointUrl('organic', { lat: NaN, lng: 158 })).toBeNull();
    expect(pointUrl('organic', { lat: 91, lng: 158 })).toBeNull();
    expect(pointUrl('organic', { lat: 53, lng: 181 })).toBeNull();
  });

  it('негодный СТАРТ роняет маршрут до точки, а не до пустоты', () => {
    const links = navLinks({ lat: 0, lng: 0 }, CAPE, 'car');
    expect(links).toHaveLength(4);
    expect(links.every((l) => l.isRoute === false)).toBe(true);
  });
});

describe('передача доехала до экранов', () => {
  it('карточка точки отдаёт дорогу навигатору', () => {
    // Правило, которое некому вызвать, — мёртвое правило.
    const screen = read('app/places/[id]/_PlaceDetailClient.tsx');
    expect(screen).toMatch(/<NavigateTo[\s\S]{0,300}to=/);
  });

  it('«На маршруте» отдаёт СВОЙ фикс, а не спрашивает геолокацию заново', () => {
    // Экран уже ведёт положение: не передать его значит показать человеку
    // ссылки-точки и лишнюю всплывашку там, где маршрут можно построить сразу.
    const screen = read('app/planning/_PlanningClient.tsx');
    expect(screen).toMatch(/<NavigateTo[\s\S]{0,400}from=/);
  });
});

describe('название точки попадает в навигатор', () => {
  it('имя цели подставляется и экранируется', () => {
    const u = routeUrl('organic', ME, CAPE, 'car')!;
    expect(u).toContain(`daddr=${encodeURIComponent('Мыс Маячный')}`);
  });

  it('пустое имя заменяется, а не даёт daddr=', () => {
    const u = routeUrl('organic', ME, { lat: 53, lng: 158, name: '   ' }, 'car')!;
    expect(u).not.toContain('daddr=&');
    expect(u).toContain('daddr=');
  });
});
