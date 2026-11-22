import { Header } from '@/components/layout/Header';
import BottomNav from '@/components/shared/BottomNav';

/** Скелет перехода на /safety. Лид и заголовок страницы — только в page.tsx, иначе в HTML будет дубль (аудит 23.11). */
export default function Loading() {
  return (
    <>
      <Header />
      <div className="ds-page px-4" style={{ maxWidth: 680, margin: '0 auto', paddingBottom: 96 }}>
        <p role="status" className="text-sm" style={{ color: 'var(--text-muted)' }}>Загрузка обстановки…</p>
      </div>
      <BottomNav activePath="/safety" />
    </>
  );
}
