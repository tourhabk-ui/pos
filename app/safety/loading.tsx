import { Header } from '@/components/layout/Header';
import BottomNav from '@/components/shared/BottomNav';
import { SafetyIntro, SafetyLiveIntro } from './SafetyAbout';

/** Пока грузится живая обстановка, в HTML уже есть вопрос, прямой ответ и заголовок радара. */
export default function Loading() {
  return (
    <>
      <Header />
      <div className="ds-page px-4" style={{ maxWidth: 680, margin: '0 auto', paddingBottom: 96 }}>
        <SafetyIntro />
        <SafetyLiveIntro />
        <p role="status" className="text-sm" style={{ color: 'var(--text-muted)' }}>Загрузка обстановки…</p>
      </div>
      <BottomNav activePath="/safety" />
    </>
  );
}
