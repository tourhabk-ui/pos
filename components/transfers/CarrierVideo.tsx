import type { CharterVideo } from '@/lib/transfers/charter-format';

/**
 * Ролик перевозчика с кнопками — один на карточку витрины /transfers и
 * страницу перевозчика: две копии плеера разошлись бы размерами.
 *
 * Рамка 16:9 и не шире 42rem (владелец 14.10: «в дисктопе видео и фото
 * растягиваются»). Ролик «Шатуна» — 640×356, а колонка страницы на десктопе —
 * 717 px: плеер во всю колонку растягивал кадр шире файла, и пока ролик не
 * загружен, рамка брала размер обложки, а без неё — полосу высотой 150 px.
 *
 * preload="none": ролик ~3 МБ, на мобильной сети он не должен качаться, пока
 * человек не нажал «играть»; кадр-обложка — отдельный файл. Звука нет
 * (решение владельца 09.10): дорожка вырезана из самого файла, muted — на
 * случай, если ролик заменят файлом со звуком. Подпись «Видео», а не «Видео
 * целиком»: с 09.10 внизу другой ролик, а не полная версия клипов над ним.
 */
export function CarrierVideo({ video, name }: { video: CharterVideo; name: string }) {
  return (
    <figure className="max-w-2xl">
      <video
        controls
        muted
        playsInline
        preload="none"
        poster={video.poster}
        className="block w-full aspect-video rounded-lg bg-[var(--bg-hover)] object-contain"
        aria-label={`Видео: ${name}`}
      >
        <source src={video.url} type="video/mp4" />
      </video>
      <figcaption className="text-xs text-[var(--text-muted)] mt-1">Видео: {name}</figcaption>
    </figure>
  );
}
