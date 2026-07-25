import { describe, it, expect } from 'vitest';
import { selectReviewTargets, riskScore, type LedgerEntry } from '@/lib/agents/evo/coverage-ledger';
import { detectMockPatterns } from '@/lib/agents/evo/mock-detector';

const NOW = Date.parse('2026-07-24T12:00:00Z');
const H = 3_600_000;

describe('riskScore — критичный контур раньше', () => {
  it('платёжки/SOS/брони > утилит', () => {
    expect(riskScore('app/api/payments/webhook/route.ts')).toBeGreaterThan(riskScore('lib/utils/format.ts'));
    expect(riskScore('app/api/safety/sos/route.ts')).toBeGreaterThan(riskScore('lib/text/slug.ts'));
    expect(riskScore('app/api/hub/bookings/create/route.ts')).toBeGreaterThan(riskScore('lib/agents/scout.ts'));
  });
  it('HTTP-роут рискованнее внутренней утилиты того же домена', () => {
    expect(riskScore('app/api/auth/login/route.ts')).toBeGreaterThan(riskScore('lib/auth/helpers.ts'));
  });
});

describe('selectReviewTargets — систематический прочёс', () => {
  const candidates = [
    'app/api/payments/webhook/route.ts',
    'app/api/safety/sos/route.ts',
    'lib/utils/a.ts', 'lib/utils/b.ts', 'lib/utils/c.ts',
  ];

  it('никогда-не-виданные идут первыми, рискованные раньше', () => {
    const ledger: LedgerEntry[] = []; // всё невиданное
    const out = selectReviewTargets({ candidates, ledger, recentChanged: [], now: NOW, max: 2 });
    // payments и sos — самый высокий риск среди невиданных
    expect(out).toContain('app/api/payments/webhook/route.ts');
    expect(out).toContain('app/api/safety/sos/route.ts');
  });

  it('churn (недавно изменённые) всегда в приоритете', () => {
    const ledger: LedgerEntry[] = candidates.map((f) => ({
      file_path: f, last_reviewed_at: new Date(NOW - 1 * H).toISOString(), review_count: 1, last_findings: 0,
    }));
    const out = selectReviewTargets({ candidates, ledger, recentChanged: ['lib/utils/c.ts'], now: NOW, max: 3, recentCap: 1 });
    expect(out[0]).toBe('lib/utils/c.ts');
  });

  it('давно-невиданный обгоняет недавно-виданного', () => {
    const ledger: LedgerEntry[] = [
      { file_path: 'lib/utils/a.ts', last_reviewed_at: new Date(NOW - 100 * H).toISOString(), review_count: 1, last_findings: 0 },
      { file_path: 'lib/utils/b.ts', last_reviewed_at: new Date(NOW - 1 * H).toISOString(), review_count: 1, last_findings: 0 },
    ];
    const out = selectReviewTargets({
      candidates: ['lib/utils/a.ts', 'lib/utils/b.ts'], ledger, recentChanged: [], now: NOW, max: 1,
    });
    expect(out).toEqual(['lib/utils/a.ts']); // 100ч назад раньше, чем 1ч назад
  });

  it('не выходит за max и не дублирует', () => {
    const out = selectReviewTargets({ candidates, ledger: [], recentChanged: ['app/api/safety/sos/route.ts'], now: NOW, max: 3 });
    expect(out.length).toBeLessThanOrEqual(3);
    expect(new Set(out).size).toBe(out.length);
  });
});

describe('detectMockPatterns — фейк-витрины', () => {
  it('клиент с setTimeout-моком и без fetch → находка «Экран на мок-данных»', () => {
    const src = `'use client';
    export default function C() {
      const [rows, setRows] = useState([]);
      useEffect(() => {
        setTimeout(() => {
          setRows([{ id: '1', name: 'Анна М.', price: 3000 }, { id: '2', name: 'Дмитрий К.', price: 5000 }]);
        }, 500);
      }, []);
      return null;
    }`;
    const found = detectMockPatterns('app/hub/x/_Client.tsx', src);
    expect(found.some((f) => f.title === 'Экран на мок-данных' && f.category === 'ux')).toBe(true);
  });

  it('клиент с реальным fetch → НЕ находка', () => {
    const src = `'use client';
    export default function C() {
      useEffect(() => { fetch('/api/x').then(r => r.json()); }, []);
      return null;
    }`;
    expect(detectMockPatterns('app/hub/x/_Client.tsx', src)).toHaveLength(0);
  });

  it('кнопки подтвердить/отменить без мутации → находка', () => {
    const src = `'use client';
    export default function C() {
      return <div>
        <button onClick={() => setStatus('confirmed')}>Подтвердить</button>
        <button onClick={() => setStatus('cancelled')}>Отменить</button>
      </div>;
    }`;
    expect(detectMockPatterns('app/hub/x/_Client.tsx', src).some((f) => f.title === 'Кнопки действий без мутации')).toBe(true);
  });

  it('тестовые файлы игнорируются', () => {
    const src = `'use client'; setTimeout(() => setRows([{a:'1'},{b:'2'}]), 1);`;
    expect(detectMockPatterns('app/x/_Client.test.tsx', src)).toHaveLength(0);
  });

  it('заглушка-маркер → tech_debt', () => {
    const src = `const url = 'https://placeholder.com/img.png';`;
    expect(detectMockPatterns('app/x/page.tsx', src).some((f) => f.category === 'tech_debt')).toBe(true);
  });
});

/**
 * Регрессия на ЛОЖНЫЕ срабатывания мок-детектора.
 *
 * Аудит админки 24.07: детектор дал 3 находки из 3 — и все три оказались
 * ложью (проверено чтением файлов). Он клеймил корректно построенные экраны,
 * то есть сам делал то, ради предотвращения чего создан. Кейсы ниже — точные
 * копии реальных паттернов, на которых он ошибся.
 */
describe('detectMockPatterns — ложняки, найденные аудитом админки', () => {
  it('данные из серверного компонента пропсами — НЕ фейк (channels)', () => {
    const src = `'use client';
import { useState } from 'react';
const CHANNELS = [
  { id: 'avito', name: 'Авито', steps: [{ done: true, text: 'фид готов' }] },
  { id: 'yandex', name: 'Яндекс', steps: [{ done: true, text: 'YML готов' }] },
];
export function ChannelsDashboardClient({ orders, tours }: { orders: OrderStat[]; tours: TourStats }) {
  const [copied, setCopied] = useState(false);
  return <button onClick={() => { navigator.clipboard.writeText('x'); setCopied(true); setTimeout(() => setCopied(false), 2000); }}>Копировать</button>;
}`;
    expect(detectMockPatterns('app/hub/admin/channels/_ChannelsDashboardClient.tsx', src)).toHaveLength(0);
  });

  it('таймер кнопки «скопировано» — не имитация загрузки', () => {
    const src = `'use client';
const ROWS = [{ a: '1' }, { a: '2' }];
export default function C({ data }: { data: string[] }) {
  return <span onClick={() => setTimeout(() => setCopied(false), 2000)}>Отменить</span>;
}`;
    expect(detectMockPatterns('app/hub/x/_C.tsx', src)).toHaveLength(0);
  });

  it('placeholder="https://example.com/rss.xml" — подсказка поля, не заглушка', () => {
    const src = `'use client';
export default function S() {
  return <input placeholder="https://example.com/rss.xml" />;
}`;
    expect(detectMockPatterns('app/hub/admin/intelligence/_S.tsx', src)).toHaveLength(0);
  });

  it('НАСТОЯЩИЙ мок по-прежнему ловится (детектор не оглушён)', () => {
    const src = `'use client';
import { useState, useEffect } from 'react';
export default function Fake() {
  const [rows, setRows] = useState([]);
  useEffect(() => {
    setTimeout(() => { setRows([{ id: 1, name: 'Иван' }, { id: 2, name: 'Пётр' }]); }, 500);
  }, []);
  return <button onClick={() => alert('ок')}>Подтвердить</button>;
}`;
    const found = detectMockPatterns('app/hub/x/_FakeClient.tsx', src);
    expect(found.length).toBeGreaterThanOrEqual(1);
    expect(found.map(f => f.title)).toContain('Экран на мок-данных');
  });
});

/**
 * Регрессия на ПРОПУСКИ (аудит бизнес-процессов 25.07).
 *
 * Обратная сторона вчерашней правки: убирая ложняки, детектор стал требовать
 * ОТДЕЛЬНЫЙ короткий литерал рядом с setTimeout — и мок тем вернее ускользал,
 * чем он крупнее. На 262 экранах кабинетов детектор дал 0 находок, при этом
 * три экрана были доказанным фейком: «Профиль гида» (один объект в форме +
 * кнопка «Сохранить» на таймере), «Отзывы гида» (три выдуманных отзыва с
 * именами) и «Гиды оператора» (три выдуманных гида). Кейсы — копии этих
 * паттернов.
 */
describe('detectMockPatterns — пропуски, найденные аудитом кабинетов', () => {
  it('мок ОДНОГО объекта в форме (профиль гида) — находка', () => {
    const src = `'use client';
export default function C() {
  const [form, setForm] = useState({ name: '' });
  useEffect(() => {
    setTimeout(() => {
      setForm({ name: 'Иван Петров', email: 'guide@example.com' });
      setLoading(false);
    }, 500);
  }, []);
  return null;
}`;
    expect(detectMockPatterns('app/hub/guide/profile/_Client.tsx', src)
      .map((f) => f.title)).toContain('Экран на мок-данных');
  });

  it('кнопка «Сохранить» на таймере без мутации — находка', () => {
    const src = `'use client';
export default function C() {
  function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setTimeout(() => setSaving(false), 1000);
  }
  return <form onSubmit={handleSave}><button type="submit">Сохранить</button></form>;
}`;
    expect(detectMockPatterns('app/hub/guide/profile/_Client.tsx', src)
      .map((f) => f.title)).toContain('Форма сохраняет в никуда');
  });

  it('форма с настоящим PUT — НЕ находка', () => {
    const src = `'use client';
export default function C() {
  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    await fetch('/api/guide/profile', { method: 'PUT', body: JSON.stringify({}) });
    setSaving(false);
  }
  return <form onSubmit={handleSave}><button type="submit">Сохранить</button></form>;
}`;
    expect(detectMockPatterns('app/hub/guide/profile/_Client.tsx', src)).toHaveLength(0);
  });

  it('крупный мок из трёх длинных объектов (отзывы гида) — находка', () => {
    const src = `'use client';
export default function C() {
  const [reviews, setReviews] = useState([]);
  useEffect(() => {
    setTimeout(() => {
      setReviews([
        { id: '1', touristName: 'Анна М.', tourName: 'Восхождение на Авачинский', rating: 5, text: 'Отличный гид, всё рассказал про вулкан и обеспечил безопасность группы.', date: '2026-02-20' },
        { id: '2', touristName: 'Дмитрий К.', tourName: 'Рыбалка на Жупанова', rating: 4, text: 'Хорошая организация, но погода подвела, гид нашёл отличное место.', date: '2026-02-15' },
      ]);
      setLoading(false);
    }, 500);
  }, []);
  return null;
}`;
    expect(detectMockPatterns('app/hub/guide/reviews/_Client.tsx', src)
      .map((f) => f.title)).toContain('Экран на мок-данных');
  });

  it('статический конфиг рядом с useState — НЕ находка (шаги онбординга)', () => {
    const src = `'use client';
const STEPS = [
  { id: 'profile', title: 'Профиль', desc: 'Заполните данные компании' },
  { id: 'tours', title: 'Туры', desc: 'Добавьте первый тур' },
];
export default function C() {
  const [step, setStep] = useState(0);
  return <div>{STEPS[step].title}</div>;
}`;
    expect(detectMockPatterns('app/hub/gear/onboarding/_Client.tsx', src)).toHaveLength(0);
  });
});
