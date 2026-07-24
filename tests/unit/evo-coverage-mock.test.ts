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
