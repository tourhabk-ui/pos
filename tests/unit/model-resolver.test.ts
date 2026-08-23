/**
 * Выбор модели-решателя БЕЗ привязки к id. Ранкер должен сам находить
 * сильнейшую ОБЩУЮ модель в списке /v1/models и НЕ выбирать классы, ломающие
 * решателя (reasoner → <think>-теги рвут JSON; мультимодальные/служебные).
 */
import { describe, it, expect } from 'vitest';
import { pickBestModel, scoreModel } from '@/lib/ai/model-resolver';

describe('pickBestModel — DeepSeek', () => {
  it('предпочитает флагманский general (chat-алиас) reasoner-у', () => {
    expect(pickBestModel(['deepseek-chat', 'deepseek-reasoner'])).toBe('deepseek-chat');
  });
  it('reasoner/thinking исключены совсем', () => {
    expect(pickBestModel(['deepseek-reasoner', 'deepseek-r1'])).toBeNull();
  });
  it('chat-алиас предпочтительнее датированного снапшота (годы не считаем версией)', () => {
    expect(pickBestModel(['deepseek-chat', 'deepseek-chat-2025-01-25'])).toBe('deepseek-chat');
  });
});

describe('pickBestModel — Qwen', () => {
  it('max-тир выигрывает у plus/turbo', () => {
    expect(pickBestModel(['qwen-turbo', 'qwen-plus', 'qwen-max-latest'])).toBe('qwen-max-latest');
  });
  it('скользящий -latest предпочтительнее закреплённого снапшота той же силы', () => {
    expect(pickBestModel(['qwen-max-latest', 'qwen-max-2025-01-25'])).toBe('qwen-max-latest');
  });
  it('новая линейка (qwen3-max) выигрывает у старой (qwen2.5-max) при отсутствии -latest', () => {
    expect(pickBestModel(['qwen2.5-max', 'qwen3-max'])).toBe('qwen3-max');
  });
  it('мультимодальные и служебные исключены', () => {
    expect(pickBestModel(['qwen-vl-max', 'qwen-audio', 'qwen-max'])).toBe('qwen-max');
    expect(pickBestModel(['text-embedding-v3', 'qwen-vl-plus'])).toBeNull();
  });
});

describe('pickBestModel — устойчивость', () => {
  it('пустой список / только исключённые → null', () => {
    expect(pickBestModel([])).toBeNull();
    expect(pickBestModel(['qwen-embedding', 'bge-reranker'])).toBeNull();
  });
  it('детерминизм: при равенстве баллов — стабильный выбор', () => {
    const a = pickBestModel(['model-a-max', 'model-b-max']);
    const b = pickBestModel(['model-b-max', 'model-a-max']);
    expect(a).toBe(b);
  });
  it('scoreModel: max > pro > plus/chat > turbo/flash', () => {
    expect(scoreModel('x-max')).toBeGreaterThan(scoreModel('x-pro'));
    expect(scoreModel('x-pro')).toBeGreaterThan(scoreModel('x-plus'));
    expect(scoreModel('x-plus')).toBeGreaterThan(scoreModel('x-turbo'));
  });
});


describe('дата-снапшот не может стать версией (проба 165)', () => {
  /**
   * Список снят с боевого ключа DashScope 23.08: 162 модели. Резолвер
   * выбирал из них `qwen3-max-2025-09-23` — снапшот годичной давности,
   * при живых `qwen3.8-max` и `qwen3.7-max`.
   *
   * Причина: versionScore брал все числа id и отбрасывал только те, что
   * ≥ 100. Год 2025 отсекался, а месяц 09 и день 23 — нет, и версией
   * становилось ЧИСЛО МЕСЯЦА: 23 против 3.8.
   */
  const REAL_IDS = [
    'qwen3.8-max', 'qwen3-max-2025-09-23', 'qwen3-max-2026-01-23',
    'qwen3.7-max', 'qwen3.7-max-2026-06-08', 'qwen3-max', 'qwen-max',
    'qwen3.6-max-preview', 'qwen-plus', 'qwen-turbo',
  ];

  it('флагман новее датированного снапшота', () => {
    expect(pickBestModel(REAL_IDS)).toBe('qwen3.8-max');
  });

  it('день месяца не поднимает версию', () => {
    // Единственная разница между этими id — хвост-дата. Баллы обязаны
    // совпасть: снапшот не сильнее и не слабее своего же алиаса по версии.
    expect(scoreModel('qwen3-max-2025-09-23')).toBe(scoreModel('qwen3-max'));
    expect(scoreModel('qwen3.7-max-2026-06-08')).toBe(scoreModel('qwen3.7-max'));
  });

  it('при равной версии выигрывает скользящий алиас, а не снапшот', () => {
    expect(pickBestModel(['qwen3.7-max-2026-06-08', 'qwen3.7-max'])).toBe('qwen3.7-max');
  });

  it('не-дата в хвосте id остаётся на месте', () => {
    // 397b/a17b — размерность модели. Резак дат её трогать не должен:
    // цифры обязаны сохраниться, иначе вырезание пойдёт по живому.
    expect(scoreModel('qwen3.5-397b-a17b')).toBeGreaterThan(scoreModel('qwen3.5'));
    // Слитная дата в хвосте DeepSeek версией не становится.
    expect(scoreModel('deepseek-v4-flash-0731')).toBe(scoreModel('deepseek-v4-flash'));
  });

  it('размерность модели versionScore всё ещё путает — но это не решает исход', () => {
    // Честная запись остаточной кривизны: «27b» читается как версия 27, и
    // qwen3.5-27b формально «новее» qwen3.5-397b-a17b. Чинить это здесь я
    // не стал — обе записи тира 1 и против max/plus не выигрывают никогда,
    // так что на выбор решателя не влияет. Сторож фиксирует ЗНАНИЕ о
    // кривизне: если завтра она начнёт решать исход, тест придётся менять
    // осознанно, а не обнаружить последствия в проде.
    expect(scoreModel('qwen3.5-27b')).toBeGreaterThan(scoreModel('qwen3.5-397b-a17b'));
    expect(pickBestModel(['qwen3.5-27b', 'qwen3.5-397b-a17b', 'qwen-max'])).toBe('qwen-max');
  });
});
