/**
 * Экран планера без входа (слово владельца 14.11 «6-3»: без входа планер не
 * работает). План хранится в личном кабинете, поэтому планер открывается
 * после входа. Не смогли проверить вход — так и сказано: это не «вы не
 * вошли» (§4.0).
 */
import Link from 'next/link';
import { Map, LogIn, UserPlus, RefreshCw, MessageCircle, Compass } from 'lucide-react';
import { plannerLoginHref, PLANNER_PATH, type PlannerGate } from '@/lib/planner/login-gate';
import { kuzmichAskHref } from '@/lib/kuzmich/ask-link';

/**
 * Без входа — не тупик (21.11, разбор уходов: на экране входа визит
 * кончался). План по дням без кабинета собирает Кузьмич в чате тем же
 * движком планера (make_trip_plan); туры и маршруты открыты всем.
 */
export const PLANNER_NO_LOGIN_ASK = 'Собери план поездки на Камчатку по дням';

export function PlannerLoginGate({ gate }: { gate: PlannerGate }) {
  return (
    <main className="ds-page min-h-[70vh] flex items-center justify-center px-4 py-16">
      <section className="ds-card max-w-xl w-full p-8 space-y-5" aria-labelledby="planner-gate-title">
        <Map className="w-8 h-8 text-[var(--ocean)]" aria-hidden="true" />
        <h1 id="planner-gate-title" className="font-playfair text-3xl font-bold text-[var(--text-primary)]">
          {gate === 'unchecked' ? 'Не смогли проверить вход' : 'Планер поездки — после входа'}
        </h1>
        {gate === 'unchecked' ? (
          <p className="text-[var(--text-secondary)]">
            Сервер не ответил, вошли ли вы. Это не значит, что вы не вошли. Обновите страницу через минуту.
          </p>
        ) : (
          <p className="text-[var(--text-secondary)]">
            План поездки хранится в личном кабинете: собранный план сохраняется туда сам, и вы вернётесь к нему с
            любого устройства. Войдите или зарегистрируйтесь — после входа планер откроется здесь же.
          </p>
        )}
        <div className="flex flex-wrap gap-3">
          {gate === 'unchecked' ? (
            <a href={PLANNER_PATH} className="ds-btn ds-btn-primary inline-flex items-center gap-2">
              <RefreshCw className="w-4 h-4" aria-hidden="true" />Обновить
            </a>
          ) : (
            <>
              <Link href={plannerLoginHref('login')} className="ds-btn ds-btn-primary inline-flex items-center gap-2">
                <LogIn className="w-4 h-4" aria-hidden="true" />Войти
              </Link>
              <Link href={plannerLoginHref('register')} className="ds-btn ds-btn-secondary inline-flex items-center gap-2">
                <UserPlus className="w-4 h-4" aria-hidden="true" />Зарегистрироваться
              </Link>
            </>
          )}
        </div>
        {gate === 'sign_in' && (
          <div className="border-t border-[var(--border)] pt-5 space-y-3">
            <p className="text-sm text-[var(--text-secondary)]">Без входа:</p>
            <div className="flex flex-wrap gap-3">
              <Link href={kuzmichAskHref(PLANNER_NO_LOGIN_ASK)} className="ds-btn ds-btn-secondary inline-flex items-center gap-2">
                <MessageCircle className="w-4 h-4" aria-hidden="true" />План в чате с Кузьмичом
              </Link>
              <Link href="/catalog" className="ds-btn ds-btn-secondary inline-flex items-center gap-2">
                <Compass className="w-4 h-4" aria-hidden="true" />Туры
              </Link>
              <Link href="/routes" className="ds-btn ds-btn-secondary inline-flex items-center gap-2">
                <Map className="w-4 h-4" aria-hidden="true" />Маршруты
              </Link>
            </div>
            <p className="text-xs text-[var(--text-muted)]">План из чата в личном кабинете не сохраняется.</p>
          </div>
        )}
      </section>
    </main>
  );
}
