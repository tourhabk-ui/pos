/**
 * Ступень 4 — санитар контента. Детекция ДОЛЖНА ловить мусор и НИКОГДА не
 * трогать реальную прозу (иначе авто-откат стирал бы честные описания).
 * Тестируем чистую garbageSignature на фикстурах.
 */
import { describe, it, expect } from 'vitest';
import { garbageSignature } from '@/lib/agents/evo/content-sanitizer';

describe('garbageSignature — ловит мусор', () => {
  it('сырой Verbalized Sampling JSON (баг «Большой Калыгирь»)', () => {
    const vs = '[{"probability": 0.4, "text": "Озеро Большой Калыгирь расположено..."},{"probability":0.35,"text":"обрыв';
    expect(garbageSignature(vs)).toBe('verbalized_json');
  });
  it('обёрнутый ```json тоже, если начинается с [ после trim', () => {
    const vs = '[{"probability":0.5,"text":"x"}]';
    expect(garbageSignature(vs)).toBe('verbalized_json');
  });
  it('мета-отговорки модели', () => {
    expect(garbageSignature('Файл не предоставлен для анализа. Пропускаю.')).toBe('model_meta');
    expect(garbageSignature('Как языковая модель, я не располагаю данными.')).toBe('model_meta');
    expect(garbageSignature('Я не могу предоставить описание этого места.')).toBe('model_meta');
    expect(garbageSignature('As an AI, I cannot verify this location.')).toBe('model_meta');
  });
  it('заглушка waterfall', () => {
    expect(garbageSignature('Сервис временно недоступен.')).toBe('stub');
    expect(garbageSignature('Service temporarily unavailable')).toBe('stub');
  });
});

describe('garbageSignature — НЕ трогает реальную прозу (нет ложных срабатываний)', () => {
  const realDescriptions = [
    'Озеро Большой Калыгирь расположено в Камчатском крае и представляет собой природный объект, доступный для треккинга. Вода холодная и чистая, вокруг вулканические формы рельефа и тундровая растительность.',
    'Авачинский перевал — естественная седловина на высоте 940 метров между Авачинским и Корякским вулканами. Отсюда открывается панорама на Тихий океан и Петропавловск-Камчатский.',
    'Долина гейзеров — одно из крупнейших гейзерных полей мира. Точные параметры маршрута уточняйте у оператора и в дирекции парка.',
    'Маршрут проходит через каменноберёзовые леса и субальпийские луга. На тропе возможна встреча с медведями — обязательны меры предосторожности.',
    'Вилючинский водопад ниспадает с высоты около 40 метров. Лучшее время для посещения — с июля по сентябрь.',
  ];

  it('ни одно реальное описание не помечено мусором', () => {
    for (const d of realDescriptions) {
      expect(garbageSignature(d), `ложное срабатывание на: ${d.slice(0, 50)}…`).toBeNull();
    }
  });

  it('квадратная скобка в прозе без probability/text — не мусор', () => {
    expect(garbageSignature('Высота [по разным данным] около 2000 м.')).toBeNull();
  });

  it('пусто/пробелы/null → null', () => {
    expect(garbageSignature(null)).toBeNull();
    expect(garbageSignature('')).toBeNull();
    expect(garbageSignature('   ')).toBeNull();
  });
});
