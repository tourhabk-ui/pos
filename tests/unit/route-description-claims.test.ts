/**
 * Проверка описания, написанного моделью, против данных, по которым его
 * писали (lib/routes/description-claims, 14.10 — владелец: «3 да»).
 * Судится вызовом на настоящих текстах: «Тупикин ключ» у Эссо, описанный
 * как водопад в долине Паратунки.
 */
import { describe, it, expect } from 'vitest';
import { descriptionClaims } from '@/lib/routes/description-claims';

describe('descriptionClaims', () => {
  it('чужое место и числа без опоры — улики', () => {
    const v = descriptionClaims(
      'Тупикин ключ — маршрут к водопаду в долине реки Паратунка. Тропа идёт от дороги к Паратунским источникам, длина около 2,5 километров.',
      { texts: ['Тупикин ключ'] },
    );
    expect(v.flags).toEqual(['number_not_in_data', 'place_name_not_in_data']);
    expect(v.names).toEqual(['Паратунка', 'Паратунским']);
    expect(v.numbers).toEqual(['2,5']);
  });

  it('имя из данных — в любой форме — не улика; край и страна — тоже', () => {
    const v = descriptionClaims(
      'Озеро лежит у подножия вулкана Горелого, на юге Камчатки, в России.',
      { texts: ['Озеро у Горелого'] },
    );
    expect(v.flags).toEqual([]);
  });

  it('заглавная в начале предложения — не имя', () => {
    expect(descriptionClaims('Озеро тихое. Тропа идёт вдоль берега. Вода холодная.', { texts: ['Озеро'] }).names).toEqual([]);
  });

  it('имя в кавычках посреди предложения — улика, если его нет в данных', () => {
    expect(descriptionClaims('Тропа ведёт к стоянке «Медвежья» у озера.', { texts: ['Озеро'] }).names).toEqual(['Медвежья']);
    expect(descriptionClaims('Тропа ведёт к стоянке «Медвежья» у озера.', { texts: ['Стоянка Медвежья'] }).names).toEqual([]);
  });

  it('опасность и дневник — как у заметок Кузьмича', () => {
    expect(descriptionClaims('Здесь часто ходят медведи.', { texts: ['Озеро'] }).hazards).toEqual(['bears']);
    expect(descriptionClaims('Здесь часто ходят медведи.', { texts: ['Озеро'], hazardCodes: ['bears'] }).flags).toEqual([]);
    expect(descriptionClaims('Я поднялся сюда вчера.', { texts: ['Гора'] }).flags).toContain('diary');
  });
});
