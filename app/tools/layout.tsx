import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';

export default function ToolsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-[var(--bg-primary)] text-[var(--text-primary)] min-h-[100dvh] flex flex-col">
      <Header />
      <main className="flex-1">{children}</main>
      <Footer />
    </div>
  );
}
