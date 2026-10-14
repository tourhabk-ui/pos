#!/usr/bin/env python3
"""
Аудит чужого сайта с раннера GitHub — ТОЛЬКО ЧТЕНИЕ (GET и HEAD).

Зачем отдельно от крон-роута partner-site-audit: тот ходит с прода и
зашит на один хост (SSRF-довод), а здесь раннер, хост берётся из маркера
.github/triggers/site-audit.json, и нужен не снимок страниц, а разбор:
вход (редиректы, TLS, заголовки), robots и sitemap, обход до N страниц с
метаданными, битые внутренние ссылки, тонкие страницы, картинки без alt.
Lighthouse запускает сам workflow следующим шагом — здесь только стандартная
библиотека Python, чтобы прогон не зависел от установки пакетов.

Вежливость: один запрос за раз, пауза между запросами, свой User-Agent с
адресом платформы — владелец сайта видит в логах, кто приходил.

Вывод: markdown в stdout (его workflow кладёт в сводку и в check-run) и
JSON в файл --json для разбора машиной. Страницы для Lighthouse — в файл
--lh-pages (главная и две самые ссылаемые внутренние).

Перепись sitemap (--sitemap-census N, 13.10): обход по ссылкам видит 60
страниц, а у vedarai.ru их в sitemap около девятисот, и дефекты там
массовые — по шаблону на сотни карточек (аудит 29.09, Н1–Н14). Перепись
проходит каждый адрес sitemap без перехода по редиректу и считает по
разделам: код, title, description, H1, canonical и ГДЕ он стоит (Google
читает canonical только из <head>, а Next 15 стримит метаданные в <body>
всем ботам не из htmlLimitedBots), сколько meta robots (два разных —
Яндекс выбирает разрешающий), soft-404, og:image.

--ua googlebot|yandex — смотреть страницы глазами бота. Только для
vedarai.ru: представляться чужим краулером на чужом сайте нельзя.
"""
from __future__ import annotations

import argparse
import html
import json
import os
import re
import socket
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, deque
from datetime import datetime, timezone
from html.parser import HTMLParser

UA = 'Mozilla/5.0 (compatible; VedarSiteAudit/1.0; +https://vedarai.ru)'
TIMEOUT = 20
# Пауза между запросами; переменная окружения — только для теста скрипта на локальном сервере.
PAUSE = float(os.environ.get('SITE_AUDIT_PAUSE', '0.4'))
# Длина <title> целиком, с названием сайта. Тот же предел, что TITLE_LIMIT в
# lib/seo/title-fit (аудит 01.10): инструмент, строже правила проекта, звал на
# правку 13 заголовков, которые правило считает нормальными (прогон 5).
TITLE_LIMIT = 65
# Сколько страниц-продолжений списков (?page=N) перепись обходит как источники
# ссылок, больше — нет: у самого длинного списка Ведара их меньше двадцати.
PAGED_CAP = 200
# Адреса с параметрами, на которые ведут ссылки вместо самого адреса sitemap
# (/planning?mode=trail при /planning, 14.10): сколько вариантов одной страницы
# перепись открывает, чтобы прочитать их canonical, и сколько всего. Открываются
# только варианты страниц без единой прямой ссылки, самые частые первыми.
VARIANTS_PER_URL = 3
VARIANTS_TOTAL = 60

# Заголовки ботов — ТОЛЬКО для нашего домена (см. шапку). Строки — те, что
# боты присылают сами; по ним Next решает, отдавать ли метаданные в <head>.
BOT_UA = {
    'googlebot': 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) '
                 'Chrome/120.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'yandex': 'Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)',
}
OWN_HOSTS = {'vedarai.ru'}
LOOPBACK = {'127.0.0.1', 'localhost'}
CURRENT_UA = UA


# ─── сеть ───────────────────────────────────────────────────────────────────

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: N802
        return None


OPENER_NOREDIR = urllib.request.build_opener(NoRedirect)


def fetch(url: str, method: str = 'GET', follow: bool = True, max_hops: int = 6) -> dict:
    """Один запрос с ручной цепочкой редиректов. Никогда не бросает."""
    chain: list[tuple[str, int]] = []
    cur = url
    t0 = time.monotonic()
    for _ in range(max_hops):
        req = urllib.request.Request(cur, method=method, headers={
            'User-Agent': CURRENT_UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
            'Accept-Encoding': 'gzip, deflate', 'Accept-Language': 'ru,en;q=0.5',
        })
        try:
            with OPENER_NOREDIR.open(req, timeout=TIMEOUT) as r:
                code = r.status
                hdrs = {k.lower(): v for k, v in r.headers.items()}
                body = b'' if method == 'HEAD' else r.read(3_000_000)
        except urllib.error.HTTPError as e:
            code = e.code
            hdrs = {k.lower(): v for k, v in e.headers.items()}
            try:
                body = b'' if method == 'HEAD' else e.read(3_000_000)
            except Exception:
                body = b''
        except Exception as e:  # DNS, TLS, таймаут, сброс
            return {'url': url, 'final': cur, 'code': 0, 'error': f'{type(e).__name__}: {str(e)[:160]}',
                    'chain': chain, 'headers': {}, 'body': b'', 'ms': int((time.monotonic() - t0) * 1000)}
        chain.append((cur, code))
        if follow and code in (301, 302, 303, 307, 308) and hdrs.get('location'):
            cur = urllib.parse.urljoin(cur, hdrs['location'])
            continue
        if hdrs.get('content-encoding', '').lower() == 'gzip' and body:
            import gzip
            try:
                body = gzip.decompress(body)
            except Exception:
                pass
        return {'url': url, 'final': cur, 'code': code, 'error': None, 'chain': chain,
                'headers': hdrs, 'body': body, 'ms': int((time.monotonic() - t0) * 1000)}
    return {'url': url, 'final': cur, 'code': 0, 'error': 'слишком длинная цепочка редиректов',
            'chain': chain, 'headers': {}, 'body': b'', 'ms': int((time.monotonic() - t0) * 1000)}


def cert_info(host: str) -> dict:
    try:
        ctx = ssl.create_default_context()
        with socket.create_connection((host, 443), timeout=TIMEOUT) as s:
            with ctx.wrap_socket(s, server_hostname=host) as ss:
                c = ss.getpeercert()
                exp = datetime.strptime(c['notAfter'], '%b %d %H:%M:%S %Y %Z').replace(tzinfo=timezone.utc)
                sans = [v for k, v in c.get('subjectAltName', []) if k == 'DNS']
                issuer = dict(x[0] for x in c.get('issuer', ()))
                return {'ok': True, 'expires': exp.isoformat(), 'days_left': (exp - datetime.now(timezone.utc)).days,
                        'issuer': issuer.get('organizationName') or issuer.get('commonName'), 'sans': sans,
                        'tls': ss.version()}
    except Exception as e:
        return {'ok': False, 'error': f'{type(e).__name__}: {str(e)[:160]}'}


# ─── разбор HTML ────────────────────────────────────────────────────────────

class Page(HTMLParser):
    def __init__(self, base: str):
        super().__init__(convert_charrefs=True)
        self.base = base
        self.title = ''
        self._in_title = False
        self.meta: dict[str, str] = {}
        self.og: dict[str, str] = {}
        self.canonical: str | None = None
        self.lang: str | None = None
        self.viewport = False
        self.h1: list[str] = []
        self.h2 = 0
        self._in_h: str | None = None
        self.links: list[str] = []
        self.imgs = 0
        self.imgs_no_alt = 0     # атрибута alt нет вовсе — дефект
        self.imgs_empty_alt = 0  # alt="" — декоративная картинка рядом с подписью, так и надо (WCAG)
        self.scripts = 0
        self.jsonld: list[str] = []
        self._in_jsonld = False
        self._jsonld_buf = ''
        self.jsonld_blocks: list[str] = []   # текст каждого <script type="application/ld+json">
        self.http_assets = 0
        self.hreflang = 0
        self.favicon = False
        self._skip = 0
        self.words = 0
        self.forms = 0
        self.iframes = 0
        # Где стоит метаданное: Google берёт canonical только из <head>.
        self._in_head = False
        self._svg = 0                                   # <title> внутри <svg> — подпись картинки, не страницы
        self.titles: list[list] = []                    # [текст, в <head>]
        self.descs: list[tuple[str, bool]] = []         # (content, в <head>)
        self.canonicals: list[tuple[str, bool]] = []   # (адрес, в <head>)
        self.robots_metas: list[tuple[str, bool]] = []  # (content, в <head>)

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == 'head':
            self._in_head = True
        elif tag == 'body':
            self._in_head = False
        if tag == 'html' and a.get('lang'):
            self.lang = a['lang']
        elif tag == 'title' and not self._svg:
            self._in_title = True
            self.titles.append(['', self._in_head])
        elif tag == 'meta':
            name = (a.get('name') or '').lower()
            prop = (a.get('property') or '').lower()
            content = a.get('content') or ''
            if name in ('description', 'robots', 'viewport', 'yandex-verification', 'google-site-verification', 'generator'):
                self.meta[name] = content
                if name == 'viewport':
                    self.viewport = True
            if name == 'robots':
                self.robots_metas.append((content, self._in_head))
            if name == 'description':
                self.descs.append((content, self._in_head))
            if prop.startswith('og:'):
                self.og[prop[3:]] = content
        elif tag == 'link':
            rel = (a.get('rel') or '').lower()
            if 'canonical' in rel:
                self.canonical = urllib.parse.urljoin(self.base, a.get('href') or '')
                self.canonicals.append((self.canonical, self._in_head))
            if 'alternate' in rel and a.get('hreflang'):
                self.hreflang += 1
            if 'icon' in rel:
                self.favicon = True
            if (a.get('href') or '').startswith('http://'):
                self.http_assets += 1
        elif tag in ('h1', 'h2'):
            self._in_h = tag
            if tag == 'h1':
                self.h1.append('')
            else:
                self.h2 += 1
        elif tag == 'a' and a.get('href'):
            self.links.append(urllib.parse.urljoin(self.base, a['href']))
        elif tag == 'img':
            self.imgs += 1
            if 'alt' not in a:
                self.imgs_no_alt += 1
            elif not (a.get('alt') or '').strip():
                self.imgs_empty_alt += 1
            if (a.get('src') or '').startswith('http://'):
                self.http_assets += 1
        elif tag == 'script':
            self.scripts += 1
            self._skip += 1
            if (a.get('type') or '').lower() == 'application/ld+json':
                self._in_jsonld = True
            if (a.get('src') or '').startswith('http://'):
                self.http_assets += 1
        elif tag in ('style', 'noscript', 'svg'):
            self._skip += 1
            if tag == 'svg':
                self._svg += 1
        elif tag == 'form':
            self.forms += 1
        elif tag == 'iframe':
            self.iframes += 1

    def handle_endtag(self, tag):
        if tag == 'head':
            self._in_head = False
        if tag == 'title':
            self._in_title = False
        elif tag in ('h1', 'h2'):
            self._in_h = None
        elif tag in ('script', 'style', 'noscript', 'svg'):
            self._skip = max(0, self._skip - 1)
            if tag == 'script':
                if self._in_jsonld:
                    self.jsonld_blocks.append(self._jsonld_buf)
                    self._jsonld_buf = ''
                self._in_jsonld = False
            if tag == 'svg':
                self._svg = max(0, self._svg - 1)

    def handle_data(self, data):
        if self._in_title:
            if len(self.titles) == 1:
                self.title += data
            self.titles[-1][0] += data
        elif self._in_jsonld:
            self._jsonld_buf += data
            for m in re.finditer(r'"@type"\s*:\s*"([^"]+)"', data):
                self.jsonld.append(m.group(1))
        elif self._skip == 0:
            if self._in_h == 'h1' and self.h1:
                self.h1[-1] += data
            self.words += len(re.findall(r'[A-Za-zА-Яа-яЁё0-9]{2,}', data))


def same_host(url: str, hosts: set[str]) -> bool:
    try:
        return urllib.parse.urlsplit(url).hostname in hosts
    except Exception:
        return False


def norm(url: str) -> str:
    p = urllib.parse.urlsplit(url)
    path = p.path or '/'
    return urllib.parse.urlunsplit((p.scheme, p.netloc.lower(), path, p.query, ''))


def bare(url: str) -> str:
    """Тот же адрес без параметров запроса."""
    p = urllib.parse.urlsplit(url)
    return urllib.parse.urlunsplit((p.scheme, p.netloc.lower(), p.path or '/', '', ''))


def canonical_elsewhere(final: str, canonical: str) -> bool:
    """canonical обходимой страницы ведёт на ДРУГУЮ страницу — находка.

    Не находка — адрес с параметрами, чей canonical — тот же путь без них: так
    склеивают варианты одной страницы (/planning?mode=trail → /planning, режим
    читается в браузере, серверный HTML один). Прогон 7 (14.10) назвал это
    «серьёзным». Исключение из исключения — продолжения списков: у ?page=N своё
    содержимое, и склейка с первой страницей прячет его от поиска.
    """
    if not canonical or norm(canonical) == norm(final):
        return False
    query = urllib.parse.parse_qs(urllib.parse.urlsplit(final).query, keep_blank_values=True)
    return not (query and 'page' not in query and norm(canonical) == bare(final))


# ─── аудит ──────────────────────────────────────────────────────────────────

def audit(host: str, max_pages: int, link_checks: int, scheme: str = 'https') -> dict:
    # scheme=http — только для локальной проверки самого скрипта; на сайтах всегда https.
    base = f'{scheme}://{host}'
    bare = host.split(':')[0]
    hosts = {bare, f'www.{bare}'}
    out: dict = {'host': host, 'at': datetime.now(timezone.utc).isoformat(), 'entry': [], 'issues': []}

    # 1. Вход: четыре написания адреса и несуществующая страница.
    variants = (f'http://{host}/', f'http://www.{host}/', f'https://www.{host}/', f'{base}/') if scheme == 'https' else (f'{base}/',)
    for u in variants:
        r = fetch(u)
        out['entry'].append({'url': u, 'code': r['code'], 'final': r['final'], 'error': r['error'],
                             'chain': [f'{c} {x}' for x, c in r['chain']], 'ms': r['ms']})
        time.sleep(PAUSE)
    r404 = fetch(f'{base}/vedar-audit-net-takoy-stranicy-{int(time.time())}/')
    out['not_found'] = {'code': r404['code'], 'final': r404['final'], 'error': r404['error']}
    out['cert'] = cert_info(host.split(':')[0]) if scheme == 'https' else {'ok': False, 'error': 'без TLS (локальная проверка)'}

    # 2. Заголовки главной.
    home = fetch(f'{base}/')
    h = home['headers']
    out['headers'] = {
        'server': h.get('server'), 'content_encoding': h.get('content-encoding'),
        'hsts': h.get('strict-transport-security'), 'csp': bool(h.get('content-security-policy')),
        'x_content_type_options': h.get('x-content-type-options'), 'x_frame_options': h.get('x-frame-options'),
        'referrer_policy': h.get('referrer-policy'), 'cache_control': h.get('cache-control'),
        'content_type': h.get('content-type'),
    }

    # 3. robots.txt и sitemap.
    rb = fetch(f'{base}/robots.txt')
    rtxt = rb['body'].decode('utf-8', 'replace') if rb['code'] == 200 else ''
    sitemaps = re.findall(r'(?im)^\s*sitemap:\s*(\S+)', rtxt)
    out['robots'] = {'code': rb['code'], 'disallow': re.findall(r'(?im)^\s*disallow:\s*(\S*)', rtxt)[:30],
                     'sitemaps': sitemaps, 'has_host_directive': bool(re.search(r'(?im)^\s*host:', rtxt)),
                     'blocks_all': bool(re.search(r'(?im)^\s*disallow:\s*/\s*$', rtxt))}
    sm_urls: list[str] = []
    sm_report: list[dict] = []
    for sm in (sitemaps or [f'{base}/sitemap.xml'])[:5]:
        r = fetch(sm)
        txt = r['body'].decode('utf-8', 'replace') if r['code'] == 200 else ''
        locs = [html.unescape(x) for x in re.findall(r'<loc>\s*([^<\s]+)\s*</loc>', txt)]
        is_index = '<sitemapindex' in txt
        sm_report.append({'url': sm, 'code': r['code'], 'urls': len(locs), 'index': is_index,
                          'lastmod': len(re.findall(r'<lastmod>', txt))})
        if is_index:
            for child in locs[:5]:
                rc = fetch(child)
                ctxt = rc['body'].decode('utf-8', 'replace') if rc['code'] == 200 else ''
                clocs = [html.unescape(x) for x in re.findall(r'<loc>\s*([^<\s]+)\s*</loc>', ctxt)]
                sm_report.append({'url': child, 'code': rc['code'], 'urls': len(clocs), 'index': False,
                                  'lastmod': len(re.findall(r'<lastmod>', ctxt))})
                sm_urls += clocs
                time.sleep(PAUSE)
        else:
            sm_urls += locs
        time.sleep(PAUSE)
    out['sitemaps'] = sm_report
    out['sitemap_urls_total'] = len(sm_urls)
    out['sitemap_urls'] = sm_urls

    # 4. Обход.
    start = norm(home['final'] if home['code'] == 200 and same_host(home['final'], hosts) else f'{base}/')
    queue: deque[str] = deque([start])
    seen: set[str] = {start}
    pages: list[dict] = []
    inbound: Counter = Counter()
    all_internal: set[str] = set()
    while queue and len(pages) < max_pages:
        u = queue.popleft()
        r = fetch(u)
        ct = r['headers'].get('content-type', '')
        page = {'url': u, 'code': r['code'], 'ms': r['ms'], 'bytes': len(r['body']), 'final': r['final'], 'error': r['error']}
        if r['code'] == 200 and 'html' in ct and r['body']:
            p = Page(r['final'])
            try:
                p.feed(r['body'].decode('utf-8', 'replace'))
            except Exception as e:
                page['parse_error'] = str(e)[:120]
            page.update({
                'title': html.unescape(p.title.strip())[:200], 'description': p.meta.get('description', '')[:400],
                'robots_meta': p.meta.get('robots', ''), 'canonical': p.canonical, 'lang': p.lang, 'viewport': p.viewport,
                'h1': [html.unescape(x.strip())[:120] for x in p.h1], 'h2': p.h2, 'words': p.words,
                'imgs': p.imgs, 'imgs_no_alt': p.imgs_no_alt, 'scripts': p.scripts, 'jsonld': p.jsonld[:8],
                'og': {k: p.og[k][:120] for k in ('title', 'description', 'image') if k in p.og},
                'http_assets': p.http_assets, 'hreflang': p.hreflang, 'favicon': p.favicon,
                'forms': p.forms, 'iframes': p.iframes, 'generator': p.meta.get('generator', ''),
                'verification': {k: bool(p.meta.get(k)) for k in ('yandex-verification', 'google-site-verification')},
            })
            internal = 0
            external = 0
            for l in p.links:
                if l.startswith(('mailto:', 'tel:', 'javascript:', '#')):
                    continue
                if same_host(l, hosts):
                    internal += 1
                    n = norm(l)
                    if re.search(r'\.(pdf|jpe?g|png|gif|webp|svg|zip|docx?|xlsx?|mp4|mp3)$', urllib.parse.urlsplit(n).path, re.I):
                        continue
                    all_internal.add(n)
                    inbound[n] += 1
                    if n not in seen:
                        seen.add(n)
                        queue.append(n)
                else:
                    external += 1
            page['links_internal'] = internal
            page['links_external'] = external
        pages.append(page)
        time.sleep(PAUSE)
    out['pages'] = pages
    out['crawl'] = {'visited': len(pages), 'discovered': len(seen), 'queue_left': len(queue), 'max_pages': max_pages}

    # 5. Битые внутренние ссылки — те, до которых обход не дошёл, HEAD.
    visited = {p['url'] for p in pages}
    broken: list[dict] = []
    checked = 0
    for u in sorted(all_internal - visited, key=lambda x: -inbound[x]):
        if checked >= link_checks:
            break
        r = fetch(u, method='HEAD')
        if r['code'] in (405, 403, 0) and not r['error']:
            r = fetch(u)
        checked += 1
        if r['code'] >= 400 or r['code'] == 0:
            broken.append({'url': u, 'code': r['code'], 'inbound': inbound[u], 'error': r['error']})
        time.sleep(PAUSE / 2)
    for p in pages:
        if p['code'] >= 400 or p['code'] == 0:
            broken.append({'url': p['url'], 'code': p['code'], 'inbound': inbound[p['url']], 'error': p.get('error')})
    out['broken_links'] = broken
    out['link_checks'] = checked

    # 6. Находки.
    ok_pages = [p for p in pages if p['code'] == 200 and 'title' in p]
    titles = Counter(p['title'] for p in ok_pages)
    descs = Counter(p['description'] for p in ok_pages if p['description'])
    iss = out['issues']

    def add(sev: str, what: str, urls: list[str]) -> None:
        if urls:
            iss.append({'severity': sev, 'what': what, 'count': len(urls), 'urls': urls[:12]})

    add('high', 'страница без <title>', [p['url'] for p in ok_pages if not p['title']])
    add('medium', 'одинаковый <title> на нескольких страницах', [f'«{t[:60]}» × {n}' for t, n in titles.items() if n > 1 and t])
    add('low', f'<title> длиннее {TITLE_LIMIT} знаков (в выдаче обрежется)', [p['url'] for p in ok_pages if len(p['title']) > TITLE_LIMIT])
    add('high', 'нет meta description', [p['url'] for p in ok_pages if not p['description']])
    add('medium', 'одинаковый description на нескольких страницах', [f'«{d[:60]}» × {n}' for d, n in descs.items() if n > 1])
    add('low', 'description короче 70 или длиннее 160 знаков', [p['url'] for p in ok_pages if p['description'] and not (70 <= len(p['description']) <= 160)])
    add('high', 'нет H1', [p['url'] for p in ok_pages if not p['h1']])
    add('medium', 'больше одного H1', [p['url'] for p in ok_pages if len(p['h1']) > 1])
    add('medium', 'нет canonical', [p['url'] for p in ok_pages if not p['canonical']])
    add('high', 'canonical указывает на другой адрес', [f"{p['url']} -> {p['canonical']}" for p in ok_pages if canonical_elsewhere(p['final'], p['canonical'])])
    add('high', 'noindex в meta robots', [p['url'] for p in ok_pages if 'noindex' in p['robots_meta'].lower()])
    add('medium', 'тонкая страница (меньше 150 слов)', [f"{p['url']} ({p['words']} слов)" for p in ok_pages if p['words'] < 150])
    add('medium', 'картинки без alt', [f"{p['url']} ({p['imgs_no_alt']} из {p['imgs']})" for p in ok_pages if p['imgs_no_alt'] > 0])
    add('high', 'смешанный контент: http:// ресурсы на https-странице', [f"{p['url']} ({p['http_assets']})" for p in ok_pages if p['http_assets'] > 0 and p['final'].startswith('https://')])
    add('high', 'нет viewport (не мобильная вёрстка)', [p['url'] for p in ok_pages if not p['viewport']])
    add('low', 'нет lang у <html>', [p['url'] for p in ok_pages if not p['lang']])
    add('low', 'нет Open Graph (og:title/og:image) — ссылка в мессенджере без превью', [p['url'] for p in ok_pages if 'title' not in p['og'] or 'image' not in p['og']])
    add('low', 'нет структурированных данных (JSON-LD)', [p['url'] for p in ok_pages if not p['jsonld']])
    add('medium', 'медленный ответ (дольше 2 с)', [f"{p['url']} ({p['ms']} мс)" for p in pages if p['ms'] > 2000])
    add('medium', 'тяжёлая страница HTML (больше 1 МБ)', [f"{p['url']} ({p['bytes'] // 1024} КБ)" for p in pages if p['bytes'] > 1_000_000])
    add('high', 'битые внутренние ссылки', [f"{b['url']} -> {b['code'] or b['error']}" for b in broken])
    if out['not_found']['code'] == 200:
        iss.append({'severity': 'high', 'what': 'несуществующая страница отвечает 200 (soft-404)', 'count': 1, 'urls': [out['not_found']['final']]})
    if out['robots']['code'] != 200:
        iss.append({'severity': 'medium', 'what': f"robots.txt отвечает {out['robots']['code']}", 'count': 1, 'urls': [f'{base}/robots.txt']})
    if out['robots']['blocks_all']:
        iss.append({'severity': 'high', 'what': 'robots.txt закрывает весь сайт (Disallow: /)', 'count': 1, 'urls': [f'{base}/robots.txt']})
    if not any(s['code'] == 200 and s['urls'] > 0 for s in sm_report):
        iss.append({'severity': 'medium', 'what': 'sitemap не найден или пуст', 'count': 1, 'urls': [s['url'] for s in sm_report]})
    if not sitemaps:
        iss.append({'severity': 'low', 'what': 'robots.txt не называет Sitemap:', 'count': 1, 'urls': [f'{base}/robots.txt']})
    if not out['cert'].get('ok'):
        iss.append({'severity': 'high', 'what': f"TLS: {out['cert'].get('error')}", 'count': 1, 'urls': [base]})
    elif out['cert']['days_left'] < 14:
        iss.append({'severity': 'high', 'what': f"сертификат истекает через {out['cert']['days_left']} дн.", 'count': 1, 'urls': [base]})
    elif f'www.{host}' not in out['cert']['sans'] and not any(s.startswith('*.') for s in out['cert']['sans']):
        # Сертификат основного домена www может и не покрывать: по SNI сервер
        # отдаёт для www свой. Судит сам вход по https://www. — находка, только
        # если он не прошёл проверку TLS (прогон 5 на vedarai.ru назвал ложную).
        www = next((e for e in out['entry'] if e['url'] == f'https://www.{host}/'), None)
        if www and www['code'] == 0 and re.search(r'ssl|certificate|hostname', www['error'] or '', re.I):
            iss.append({'severity': 'medium', 'what': 'сертификат не покрывает www', 'count': 1, 'urls': [f'https://www.{host}/']})
    for e in out['entry']:
        if e['code'] == 0:
            iss.append({'severity': 'high', 'what': f"адрес не отвечает: {e['error']}", 'count': 1, 'urls': [e['url']]})
        elif not e['final'].startswith('https://'):
            iss.append({'severity': 'high', 'what': 'адрес не уводит на https', 'count': 1, 'urls': [e['url']]})
    finals = {e['final'] for e in out['entry'] if e['code'] and e['code'] < 400}
    if len(finals) > 1:
        iss.append({'severity': 'medium', 'what': 'разные написания адреса ведут на разные конечные адреса (нет единого канона)', 'count': len(finals), 'urls': sorted(finals)})
    if not out['headers']['hsts']:
        iss.append({'severity': 'low', 'what': 'нет заголовка HSTS', 'count': 1, 'urls': [base]})
    if not out['headers']['content_encoding']:
        iss.append({'severity': 'medium', 'what': 'HTML отдаётся без сжатия (нет Content-Encoding)', 'count': 1, 'urls': [base]})
    if not out['headers']['x_content_type_options']:
        iss.append({'severity': 'low', 'what': 'нет X-Content-Type-Options', 'count': 1, 'urls': [base]})
    order = {'high': 0, 'medium': 1, 'low': 2}
    iss.sort(key=lambda x: (order[x['severity']], -x['count']))

    # Страницы для Lighthouse: главная и две самые ссылаемые.
    top = [u for u, _ in inbound.most_common(12) if u != start and any(p['url'] == u and p['code'] == 200 for p in pages)][:2]
    out['lighthouse_pages'] = [start] + top
    return out


# ─── перепись sitemap ───────────────────────────────────────────────────────

UUID_RE = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', re.I)
SOFT404_RE = re.compile(r'не найден|не найдена|страница не существует|not found|\b404\b', re.I)


def section_of(url: str) -> str:
    """Раздел по первому сегменту пути; uuid-адрес — отдельный раздел (двойники slug-адресов)."""
    parts = [p for p in urllib.parse.urlsplit(url).path.split('/') if p]
    if not parts:
        return '/'
    sec = f'/{parts[0]}'
    if len(parts) > 1:
        sec += '/{uuid}' if UUID_RE.match(parts[1]) else '/*'
    return sec


def cut_mid_word(desc: str) -> bool:
    """Описание оборвано посреди слова: кончается буквой или цифрой без точки/многоточия."""
    d = desc.strip()
    return len(d) >= 100 and bool(re.search(r'[A-Za-zА-Яа-яЁё0-9]$', d))


JUNK_RE = re.compile(r'\bundefined\b|\bNaN\b|\[object Object\]')


def jsonld_problems(blocks: list[str]) -> list[str]:
    """Ошибки разметки, из-за которых поисковик не строит расширенный сниппет.

    Только то, что ломает разметку наверняка: не разбирается как JSON;
    рейтинг без отзывов; предложение без цены или валюты; хлебные крошки без
    адреса или позиции; относительный адрес картинки или ссылки; мусор из
    шаблона (undefined, NaN, [object Object]). Вкус и «рекомендуемые» поля —
    не находка.
    """
    out: list[str] = []

    def add(p: str) -> None:
        if p not in out:
            out.append(p)

    def walk(node: object) -> None:
        if isinstance(node, list):
            for x in node:
                walk(x)
            return
        if not isinstance(node, dict):
            return
        t = node.get('@type')
        types = set(t if isinstance(t, list) else [t])
        if 'AggregateRating' in types:
            cnt = node.get('reviewCount', node.get('ratingCount'))
            try:
                ok = cnt is not None and float(cnt) > 0 and node.get('ratingValue') not in (None, '')
            except (TypeError, ValueError):
                ok = False
            if not ok:
                add('рейтинг без отзывов или без оценки')
        if 'Offer' in types and (node.get('price') in (None, '') or not node.get('priceCurrency')):
            add('Offer без price/priceCurrency')
        if 'AggregateOffer' in types and (node.get('lowPrice') in (None, '') or not node.get('priceCurrency')):
            add('AggregateOffer без lowPrice/priceCurrency')
        if 'BreadcrumbList' in types:
            items = node.get('itemListElement') or []
            items = items if isinstance(items, list) else [items]
            for i, it in enumerate(items):
                if not isinstance(it, dict) or it.get('position') in (None, '') or not it.get('name'):
                    add('крошка без позиции или имени')
                elif i < len(items) - 1 and not it.get('item'):
                    add('крошка без адреса')
        for k in ('image', 'logo', 'url', 'item'):
            v = node.get(k)
            vals = v if isinstance(v, list) else [v]
            for x in vals:
                if isinstance(x, str) and x.startswith('/') and not x.startswith('//'):
                    add(f'относительный адрес в «{k}»')
        for k, v in node.items():
            if isinstance(v, str) and JUNK_RE.search(v):
                add('мусор из шаблона (undefined/NaN/[object Object])')
            elif isinstance(v, (dict, list)):
                walk(v)

    for b in blocks:
        try:
            walk(json.loads(b))
        except ValueError:
            add('JSON-LD не разбирается')
    return out


def page_of(link: str, base: str) -> bool:
    """Страница-продолжение того же списка: тот же хост и путь, а в запросе только page=N (N ≥ 2).
    Фильтры в запросе — другой список, не продолжение этого."""
    a, b = urllib.parse.urlsplit(link), urllib.parse.urlsplit(base)
    if (a.scheme, a.netloc.lower(), a.path or '/') != (b.scheme, b.netloc.lower(), b.path or '/'):
        return False
    q = urllib.parse.parse_qs(a.query, keep_blank_values=True)
    return list(q) == ['page'] and len(q['page']) == 1 and q['page'][0].isdigit() and int(q['page'][0]) >= 2


def census(urls: list[str], limit: int, og_checks: int = 80) -> dict:
    """Каждый адрес sitemap — без перехода по редиректу: адрес в sitemap обязан отвечать сам."""
    rows: list[dict] = []
    # Темп ниже лимита сайта (100 запросов в минуту с адреса, middleware.ts):
    # перепись меряет страницы, а не ограничитель. 429 — ждать и повторить раз,
    # но число таких ответов называть: бот поисковика упрётся в тот же лимит.
    interval = PAUSE * 2
    limited = 0
    for u in urls[:limit]:
        t_start = time.monotonic()
        r = fetch(u, follow=False)
        if r['code'] == 429:
            limited += 1
            ra = r['headers'].get('retry-after', '')
            time.sleep(min(60.0, float(ra)) if ra.isdigit() else 30.0 if PAUSE else 0)
            r = fetch(u, follow=False)
        row: dict = {'url': u, 'section': section_of(u), 'code': r['code'], 'ms': r['ms'], 'error': r['error']}
        if r['code'] in (301, 302, 303, 307, 308):
            row['location'] = r['headers'].get('location', '')
        ct = r['headers'].get('content-type', '')
        if r['code'] == 200 and 'html' in ct and r['body']:
            p = Page(u)
            try:
                p.feed(r['body'].decode('utf-8', 'replace'))
            except Exception as e:
                row['parse_error'] = str(e)[:120]
            title = html.unescape(p.title.strip())
            # Описание — первое в <head>, иначе первое вообще: словарь meta помнит последнее.
            d_head = [c for c, hd in p.descs if hd]
            desc = html.unescape(((d_head or [c for c, _ in p.descs]) or [''])[0].strip())
            h1 = [html.unescape(x.strip()) for x in p.h1]
            row.update({
                'title': title[:200], 'desc': desc[:400], 'h1': [x[:120] for x in h1], 'words': p.words,
                'titles': [{'text': html.unescape(t.strip())[:120], 'head': hd} for t, hd in p.titles],
                'descs': [{'head': hd} for _, hd in p.descs],
                'canonicals': [{'href': c, 'head': hd} for c, hd in p.canonicals],
                'robots': [{'content': c, 'head': hd} for c, hd in p.robots_metas],
                'og_image': urllib.parse.urljoin(u, p.og['image']) if p.og.get('image') else '', 'jsonld': p.jsonld[:8],
                'jsonld_problems': jsonld_problems(p.jsonld_blocks),
                # Исходящие ссылки — для счёта входящих у адресов sitemap (сироты); в JSON не пишутся.
                '_links': {norm(x.split('#')[0]) for x in p.links},
                'imgs': p.imgs, 'imgs_no_alt': p.imgs_no_alt,
                'x_robots': r['headers'].get('x-robots-tag', ''),
                'soft404': bool(SOFT404_RE.search(title) or any(SOFT404_RE.search(x) for x in h1)),
            })
        rows.append(row)
        time.sleep(max(PAUSE, interval - (time.monotonic() - t_start)))

    # Входящие ссылки на каждый адрес sitemap из серверного HTML ДРУГИХ адресов
    # sitemap: так страницу видит обходчик, не исполняющий JS. Ноль — сирота:
    # поисковик знает о ней только из sitemap, и вес ей не передаёт никто.
    sm_norm = {norm(r['url']): r for r in rows}
    # Страницы-продолжения списков (?page=N того же пути) в sitemap не входят —
    # канон списка его первая страница, — но обходчик по ним ходит, и ссылки
    # с них настоящие. Прогон 6 (13.10) без них назвал сиротами 95 маршрутов,
    # стоящих на 2–16-й страницах /routes. Они — источники ссылок, а не
    # адреса переписи: проверок у них нет.
    queue = [l for r in rows for l in r.get('_links', set()) if l not in sm_norm and page_of(l, r['url'])]
    paged: dict[str, set] = {}
    paged_errors: list[str] = []
    while queue and len(paged) + len(paged_errors) < PAGED_CAP:
        u = queue.pop(0)
        if u in paged or any(e.startswith(u + ' ') for e in paged_errors):
            continue
        t_start = time.monotonic()
        rr = fetch(u, follow=False)
        if rr['code'] == 200 and 'html' in rr['headers'].get('content-type', '') and rr['body']:
            pp = Page(u)
            try:
                pp.feed(rr['body'].decode('utf-8', 'replace'))
            except Exception:
                pass
            paged[u] = {norm(x.split('#')[0]) for x in pp.links}
            queue.extend(l for l in paged[u] if l not in sm_norm and l not in paged and page_of(l, u))
        else:
            paged_errors.append(f"{u} → {rr['code'] or rr['error']}")
        time.sleep(max(PAUSE, interval - (time.monotonic() - t_start)))
    inbound: Counter = Counter()
    inbound_paged: Counter = Counter()
    inbound_from: dict[str, str] = {}     # первый источник ссылки — у страницы с одной ссылкой он и единственный
    sources: list[tuple[str, set]] = []   # (откуда, куда) — ещё нужны для адресов с параметрами
    for r in rows:
        own = norm(r['url'])
        links = r.pop('_links', set())
        sources.append((own, links))
        for link in links:
            if link != own and link in sm_norm:
                inbound[link] += 1
                inbound_from.setdefault(link, own)
    for u, links in paged.items():
        sources.append((u, links))
        for link in links:
            if link in sm_norm:
                inbound_paged[link] += 1
    for r in rows:
        r['inbound'] = inbound.get(norm(r['url']), 0)
        r['inbound_paged'] = inbound_paged.get(norm(r['url']), 0)
        if r['inbound'] == 1:
            r['inbound_from'] = inbound_from.get(norm(r['url']))

    # Ссылки ведут не на адрес sitemap, а на него же с параметрами (прогон 7,
    # 14.10: все ссылки на /planning — /planning?mode=trail, сирот по счёту
    # одна). Обходчик идёт по такой ссылке, читает canonical варианта и
    # склеивает его с адресом без параметров — страница не сирота. Но только
    # если вариант ДЕЙСТВИТЕЛЬНО указывает сюда: canonical читается из <head>
    # варианта, а не предполагается. Открываются варианты лишь тех адресов, у
    # которых нет ни одной прямой ссылки, — самые частые первыми.
    lonely = {norm(r['url']) for r in rows if r['code'] == 200 and 'title' in r
              and r['inbound'] == 0 and r['inbound_paged'] == 0}
    via: dict[str, Counter] = {}
    for own, links in sources:
        for link in links:
            b = bare(link)
            if urllib.parse.urlsplit(link).query and b in lonely and b != own and not page_of(link, b):
                via.setdefault(b, Counter())[link] += 1
    variants: dict[str, bool] = {}        # вариант → его canonical в <head> ведёт на адрес без параметров
    variant_errors: list[str] = []
    for b, counter in via.items():
        for v, _ in counter.most_common(VARIANTS_PER_URL):
            if len(variants) + len(variant_errors) >= VARIANTS_TOTAL:
                break
            t_start = time.monotonic()
            rv = fetch(v, follow=False)
            if rv['code'] == 200 and 'html' in rv['headers'].get('content-type', '') and rv['body']:
                pv = Page(v)
                try:
                    pv.feed(rv['body'].decode('utf-8', 'replace'))
                except Exception:
                    pass
                variants[v] = any(head and norm(c) == b for c, head in pv.canonicals)
            else:
                variant_errors.append(f"{v} → {rv['code'] or rv['error']}")
            time.sleep(max(PAUSE, interval - (time.monotonic() - t_start)))
    for r in rows:
        r['inbound_variant'] = sum(n for v, n in via.get(norm(r['url']), Counter()).items() if variants.get(v))
    linked_pages = sum(1 for r in rows if r['code'] == 200 and 'title' in r)

    ok = [r for r in rows if r['code'] == 200 and 'title' in r]
    titles = Counter(r['title'] for r in ok if r['title'])
    descs = Counter(r['desc'] for r in ok if r['desc'])

    def canon_self(r: dict) -> bool:
        return any(norm(c['href']) == norm(r['url']) for c in r['canonicals'])

    # (что, короткий код для списка адресов, проверка)
    checks = [
        ('не 200 в sitemap', 'n200', lambda r: r['code'] != 200),
        ('soft-404 (200 с «не найден»)', 'soft', lambda r: r.get('soft404')),
        ('нет title', 't0', lambda r: 'title' in r and not r['title']),
        ('title повторяется', 'tdup', lambda r: 'title' in r and r['title'] and titles[r['title']] > 1),
        ('title вне <head>', 'thead', lambda r: r.get('titles') and not any(t['head'] for t in r['titles'])),
        ('title больше одного', 't2', lambda r: len(r.get('titles') or []) > 1),
        (f'title длиннее {TITLE_LIMIT} знаков', 'tlen', lambda r: bool(r.get('title')) and len(r['title']) > TITLE_LIMIT),
        ('нет description', 'd0', lambda r: 'title' in r and not r['desc']),
        ('description <70 или >160', 'dlen', lambda r: r.get('desc') and not (70 <= len(r['desc']) <= 160)),
        ('description оборван посреди слова', 'dcut', lambda r: r.get('desc') and cut_mid_word(r['desc'])),
        ('description повторяется', 'ddup', lambda r: r.get('desc') and descs[r['desc']] > 1),
        ('description вне <head>', 'dhead', lambda r: r.get('descs') and not any(d['head'] for d in r['descs'])),
        ('нет H1', 'h0', lambda r: 'title' in r and not r['h1']),
        ('больше одного H1', 'h2', lambda r: 'title' in r and len(r['h1']) > 1),
        ('нет canonical', 'c0', lambda r: 'title' in r and not r['canonicals']),
        ('canonical только вне <head>', 'chead', lambda r: r.get('canonicals') and not any(c['head'] for c in r['canonicals'])),
        ('canonical на другой адрес', 'cother', lambda r: r.get('canonicals') and not canon_self(r)),
        ('canonical больше одного', 'c2', lambda r: len(r.get('canonicals') or []) > 1),
        ('meta robots больше одного', 'r2', lambda r: len(r.get('robots') or []) > 1),
        ('meta robots вне <head>', 'rhead', lambda r: any(not x['head'] for x in r.get('robots') or [])),
        ('noindex на адресе из sitemap', 'noidx', lambda r: any('noindex' in x['content'].lower() for x in r.get('robots') or [])
                                                    or 'noindex' in (r.get('x_robots') or '').lower()),
        ('тонкая (<150 слов в серверном HTML)', 'thin', lambda r: 'title' in r and r['words'] < 150),
        ('нет og:image', 'og0', lambda r: 'title' in r and not r['og_image']),
        ('нет JSON-LD', 'ld0', lambda r: 'title' in r and not r['jsonld']),
        ('JSON-LD с ошибкой', 'ldbad', lambda r: bool(r.get('jsonld_problems'))),
        # Главная — вход сайта, ссылок на неё изнутри может и не быть; сирота — все прочие.
        ('сирота (ни одной ссылки ни со страниц sitemap, ни с продолжений списков, ни через адрес с параметрами)', 'orph',
         lambda r: r['code'] == 200 and linked_pages > 1 and r.get('inbound', 0) == 0 and r.get('inbound_paged', 0) == 0
         and r.get('inbound_variant', 0) == 0 and (urllib.parse.urlsplit(r['url']).path or '/') != '/'),
        # Достижима, но только через 2-ю и дальше страницу списка: вес до неё доходит слабый.
        ('ссылки только со страниц-продолжений списков (?page=N)', 'deep',
         lambda r: r['code'] == 200 and r.get('inbound', 0) == 0 and r.get('inbound_paged', 0) > 0),
        # Достижима через адрес с параметрами, чей canonical ведёт сюда: поисковик склеит
        # вариант с адресом, но прямая ссылка на сам адрес надёжнее склейки.
        ('ссылки только через адрес с параметрами (его canonical ведёт сюда)', 'pvar',
         lambda r: r['code'] == 200 and r.get('inbound', 0) == 0 and r.get('inbound_paged', 0) == 0
         and r.get('inbound_variant', 0) > 0),
        ('картинки без alt', 'alt', lambda r: (r.get('imgs_no_alt') or 0) > 0),
        ('медленно (>2 с)', 'slow', lambda r: r['ms'] > 2000),
    ]
    for r in rows:
        r['codes'] = [code for _, code, fn in checks if fn(r)]
    sections = sorted({r['section'] for r in rows})
    by_section: dict[str, dict] = {}
    for s in sections:
        srows = [r for r in rows if r['section'] == s]
        by_section[s] = {'urls': len(srows), 'ok': sum(1 for r in srows if r['code'] == 200)}
        for name, _, fn in checks:
            by_section[s][name] = sum(1 for r in srows if fn(r))
    issues = []
    for name, code, fn in checks:
        hit = [r for r in rows if fn(r)]
        if hit:
            ex = []
            for r in hit[:8]:
                extra = ''
                if name == 'не 200 в sitemap':
                    extra = f" → {r['code'] or r['error']}{(' ' + r['location']) if r.get('location') else ''}"
                elif name == 'canonical на другой адрес':
                    extra = f" → {r['canonicals'][0]['href']}"
                elif name.startswith('description') and r.get('desc'):
                    extra = f" ({len(r['desc'])} зн.: «…{r['desc'][-40:]}»)"
                elif name == 'title повторяется':
                    extra = f" «{r['title'][:60]}» ×{titles[r['title']]}"
                elif name.startswith('meta robots'):
                    extra = ' [' + ' | '.join(x['content'] + ('' if x['head'] else ' (в body)') for x in r['robots']) + ']'
                elif name == 'медленно (>2 с)':
                    extra = f" ({r['ms']} мс)"
                elif code == 'thin':
                    extra = f" ({r['words']} слов)"
                elif name == 'JSON-LD с ошибкой':
                    extra = ' [' + '; '.join(r['jsonld_problems']) + ']'
                ex.append(r['url'] + extra)
            issues.append({'what': name, 'code': code, 'count': len(hit), 'examples': ex})

    # og:image — открывается ли сама картинка (превью в мессенджерах и выдаче).
    og_bad: list[str] = []
    og_head_only: list[str] = []
    og_urls = sorted({r['og_image'] for r in ok if r.get('og_image')})
    for img in og_urls[:og_checks]:
        # HEAD дешевле, но не везде открыт: реестр публичных API Ведара пускает
        # /api/images только на GET, и HEAD получает 401 (прогон 5 назвал 67
        # «не открываются» при рабочих картинках). Отказ на HEAD — переспросить
        # GET'ом: превью забирают им; расхождение назвать отдельно.
        rr = fetch(img, method='HEAD')
        if rr['code'] in (401, 403, 405) or (rr['code'] == 0 and not rr['error']):
            head_code = rr['code']
            rr = fetch(img)
            if rr['code'] == 200:
                og_head_only.append(f"{img} → HEAD {head_code}, GET 200")
        if rr['code'] != 200:
            og_bad.append(f"{img} → {rr['code'] or rr['error']}")
        time.sleep(PAUSE / 2)
    return {
        'checked': len(rows), 'of': len(urls), 'ok': len(ok), 'rate_limited': limited,
        'inbound_hist': {
            '0': sum(1 for r in ok if r.get('inbound', 0) == 0),
            '1': sum(1 for r in ok if r.get('inbound', 0) == 1),
            '2-5': sum(1 for r in ok if 2 <= r.get('inbound', 0) <= 5),
            '6+': sum(1 for r in ok if r.get('inbound', 0) >= 6),
        },
        # Одна входящая ссылка: страница держится на единственном источнике —
        # уберут его из «Рядом» или списка, и она станет сиротой. Источник
        # назван, чтобы было видно, на чём она держится (14.10).
        'single_inbound': [{'url': r['url'], 'from': r.get('inbound_from'), 'section': r['section']}
                           for r in sorted(ok, key=lambda r: (r['section'], r['url'])) if r.get('inbound') == 1],
        'paged': {'fetched': len(paged), 'errors': paged_errors},
        'variants': {'fetched': len(variants), 'canonical_here': sum(variants.values()), 'errors': variant_errors},
        'by_section': by_section, 'issues': issues, 'checks': [n for n, _, _ in checks],
        'codes': {code: name for name, code, _ in checks},
        'og_images': {'unique': len(og_urls), 'checked': min(len(og_urls), og_checks), 'bad': og_bad, 'head_only': og_head_only},
        'median_ms': sorted(r['ms'] for r in rows)[len(rows) // 2] if rows else None,
        'rows': rows,
    }


def report_census(c: dict, ua: str, budget: int = 58000) -> str:
    """Отчёт переписи: находки с примерами, таблица по разделам, затем КАЖДЫЙ адрес с находками
    кодами — сколько влезет в бюджет check-run (обрезка называется вслух)."""
    L: list[str] = [f"## Перепись sitemap: {c['checked']} из {c['of']} адресов, 200 — {c['ok']}; UA: {ua}; "
                    f"медиана ответа {c['median_ms']} мс; ответов 429 — {c.get('rate_limited', 0)}", '']
    if c['checked'] < c['of']:
        L.append(f"Пройдены первые {c['checked']} адресов sitemap из {c['of']} — остальные не проверены.")
        L.append('')
    if not c['issues']:
        L.append('- находок нет')
    for i in c['issues']:
        L.append(f"- **{i['what']}** (`{i['code']}`) — {i['count']}")
        for e in i['examples']:
            L.append(f"  - {e}")
    ih = c.get('inbound_hist')
    if ih:
        L.append(f"- входящих ссылок с других страниц sitemap (серверный HTML): 0 — {ih['0']}, 1 — {ih['1']}, 2–5 — {ih['2-5']}, 6 и больше — {ih['6+']}")
    si = c.get('single_inbound') or []
    if si:
        by = Counter(x['section'] for x in si)
        L.append(f"- одна входящая ссылка — {len(si)} (" + ', '.join(f"{s} {n}" for s, n in by.most_common()) + '); первые:')
        def short(u):
            return (urllib.parse.urlsplit(u).path or '/') if u else '—'
        for x in si[:12]:
            L.append(f"  - {short(x['url'])} ← {short(x['from'])}")
    pg = c.get('paged')
    if pg is not None:
        L.append(f"- страниц-продолжений списков (?page=N) учтено источниками ссылок: {pg['fetched']}; не открылись: {len(pg['errors'])}")
        for e in pg['errors'][:5]:
            L.append(f"  - {e}")
    va = c.get('variants')
    if va is not None and (va['fetched'] or va['errors']):
        L.append(f"- адресов с параметрами открыто ради canonical: {va['fetched']}, из них canonical ведёт на адрес без параметров: "
                 f"{va['canonical_here']}; не открылись: {len(va['errors'])}")
        for e in va['errors'][:5]:
            L.append(f"  - {e}")
    og = c['og_images']
    L.append(f"- og:image: уникальных {og['unique']}, проверено {og['checked']}, не открываются {len(og['bad'])}")
    for b in og['bad'][:10]:
        L.append(f"  - {b}")
    if og.get('head_only'):
        L.append(f"- og:image открывается только на GET, HEAD отказан: {len(og['head_only'])} (не поломка превью, но HEAD обязан отвечать как GET)")
        for b in og['head_only'][:3]:
            L.append(f"  - {b}")
    L.append('')
    L.append('### По разделам')
    cols = ['urls', 'ok'] + [k for k in c['checks'] if any(v[k] for v in c['by_section'].values())]
    code_of = {name: code for code, name in c['codes'].items()}
    L.append('| раздел | ' + ' | '.join(code_of.get(k, k) for k in cols) + ' |')
    L.append('|' + '---|' * (len(cols) + 1))
    for s, v in sorted(c['by_section'].items(), key=lambda kv: -kv[1]['urls']):
        L.append(f"| {s} | " + ' | '.join(str(v[k]) for k in cols) + ' |')
    L.append('')
    L.append('Коды: ' + '; '.join(f"`{code}` — {name}" for code, name in c['codes'].items()))
    L.append('')
    L.append('### Адреса с находками')
    flagged = sorted((r for r in c['rows'] if r.get('codes')), key=lambda r: (r['section'], r['url']))
    used = sum(len(x) + 1 for x in L)
    shown = 0
    for r in flagged:
        path = urllib.parse.urlsplit(r['url']).path or '/'
        line = f"- {path} {' '.join(r['codes'])}" + (f" → {r['code'] or r['error']}" if r['code'] != 200 else '')
        if used + len(line) + 1 > budget:
            break
        L.append(line)
        used += len(line) + 1
        shown += 1
    if shown < len(flagged):
        L.append(f"…показано {shown} из {len(flagged)} адресов с находками (бюджет check-run); полный список — в JSON прогона.")
    return '\n'.join(L)


# ─── отчёт ──────────────────────────────────────────────────────────────────

def report(a: dict) -> str:
    L: list[str] = []
    L.append(f"# Аудит {a['host']} — {a['at'][:16].replace('T', ' ')} UTC (только чтение)")
    L.append('')
    hi = sum(1 for i in a['issues'] if i['severity'] == 'high')
    me = sum(1 for i in a['issues'] if i['severity'] == 'medium')
    lo = sum(1 for i in a['issues'] if i['severity'] == 'low')
    L.append(f"Страниц обойдено: {a['crawl']['visited']} из найденных {a['crawl']['discovered']} (потолок {a['crawl']['max_pages']}); "
             f"в sitemap: {a['sitemap_urls_total']}; битых ссылок: {len(a['broken_links'])}; "
             f"находок: {hi} серьёзных, {me} средних, {lo} мелких.")
    L.append('')
    L.append('## Вход')
    for e in a['entry']:
        L.append(f"- `{e['url']}` → {' → '.join(e['chain']) or (e['error'] or '—')}  ({e['ms']} мс)")
    nf = a['not_found']
    L.append(f"- несуществующая страница: {nf['code'] or nf['error']}")
    c = a['cert']
    if c.get('ok'):
        L.append(f"- TLS: {c['tls']}, {c['issuer']}, истекает {c['expires'][:10]} (через {c['days_left']} дн.), SAN: {', '.join(c['sans'][:6])}")
    else:
        L.append(f"- TLS: ОТКАЗ — {c.get('error')}")
    h = a['headers']
    L.append(f"- сервер: {h['server'] or '—'}; сжатие: {h['content_encoding'] or 'нет'}; HSTS: {'есть' if h['hsts'] else 'нет'}; CSP: {'есть' if h['csp'] else 'нет'}; "
             f"X-Frame-Options: {h['x_frame_options'] or 'нет'}; cache-control: {h['cache_control'] or '—'}")
    L.append('')
    L.append('## robots.txt и sitemap')
    r = a['robots']
    L.append(f"- robots.txt: {r['code']}; Disallow: {', '.join(r['disallow'][:10]) or 'нет'}; Sitemap: {', '.join(r['sitemaps']) or 'не указан'}")
    for s in a['sitemaps']:
        L.append(f"- {s['url']}: {s['code']}, адресов {s['urls']}{' (индекс)' if s['index'] else ''}, lastmod у {s['lastmod']}")
    L.append('')
    L.append('## Находки')
    if not a['issues']:
        L.append('- нет')
    for i in a['issues']:
        mark = {'high': 'СЕРЬЁЗНО', 'medium': 'средне', 'low': 'мелочь'}[i['severity']]
        L.append(f"- **[{mark}] {i['what']}** — {i['count']}")
        for u in i['urls'][:6]:
            L.append(f"  - {u}")
        if i['count'] > 6:
            L.append(f"  - … и ещё {i['count'] - 6}")
    L.append('')
    L.append('## Страницы (первые 40)')
    L.append('| страница | код | мс | слов | H1 | title | descr | canonical | img без alt |')
    L.append('|---|---|---|---|---|---|---|---|---|')
    for p in a['pages'][:40]:
        if 'title' in p:
            L.append(f"| {p['url'].replace('https://' + a['host'], '') or '/'} | {p['code']} | {p['ms']} | {p['words']} | {len(p['h1'])} | "
                     f"{len(p['title'])} зн. | {len(p['description'])} зн. | {'да' if p['canonical'] else 'нет'} | {p['imgs_no_alt']}/{p['imgs']} |")
        else:
            L.append(f"| {p['url'].replace('https://' + a['host'], '') or '/'} | {p['code'] or p['error']} | {p['ms']} | — | — | — | — | — | — |")
    gen = next((p.get('generator') for p in a['pages'] if p.get('generator')), '')
    if gen:
        L.append('')
        L.append(f"Движок (meta generator): {gen}")
    return '\n'.join(L)


# ─── Lighthouse: строка таблицы и «что тормозит» ───────────────────────────

def _lh_ms(v) -> str:
    try:
        return f"{round(float(v)):,}".replace(',', ' ') + ' мс'
    except (TypeError, ValueError):
        return '—'


def _lh_kb(v) -> str:
    try:
        return f"{round(float(v) / 1024):,}".replace(',', ' ') + ' КБ'
    except (TypeError, ValueError):
        return '—'


def _lh_short(url: str, page: str) -> str:
    """Свой адрес — путём, чужой — с хостом: «/_next/…/page.js» и «mc.yandex.ru/…»."""
    try:
        u, p = urllib.parse.urlsplit(url), urllib.parse.urlsplit(page)
    except ValueError:
        return url[:90]
    if not u.netloc:
        return url[:90]
    tail = (u.path or '/')[-70:]
    return tail if u.netloc == p.netloc else f"{u.netloc}{tail}"


def _lh_first_node(details) -> dict | None:
    """Узел LCP: в Lighthouse 12 он внутри списка таблиц, в 10–11 — в таблице сразу."""
    if not isinstance(details, dict):
        return None
    for item in details.get('items') or []:
        if isinstance(item, dict) and isinstance(item.get('node'), dict):
            return item['node']
        if isinstance(item, dict) and item.get('type') == 'table':
            for sub in item.get('items') or []:
                if isinstance(sub, dict) and isinstance(sub.get('node'), dict):
                    return sub['node']
    return None


def _lh_lcp_phases(details) -> list[tuple[str, float]]:
    out: list[tuple[str, float]] = []
    if not isinstance(details, dict):
        return out
    for item in details.get('items') or []:
        if isinstance(item, dict) and item.get('type') == 'table':
            for sub in item.get('items') or []:
                if isinstance(sub, dict) and 'phase' in sub and isinstance(sub.get('timing'), (int, float)):
                    out.append((str(sub['phase']), float(sub['timing'])))
    return out


LH_PHASES = {'TTFB': 'ответ сервера', 'Load Delay': 'задержка загрузки', 'Load Time': 'загрузка',
             'Render Delay': 'задержка отрисовки'}


def lighthouse_summary(url: str, lh: dict) -> tuple[str, list[str]]:
    """Строка таблицы итогов и расшифровка «что тормозит» по отчёту Lighthouse.

    Баллы без расшифровки звать на правку не могут: прогон 8 (14.10) показал
    TBT 11,7 с на /map и 1,3 с на главной, а чьи это секунды — отчёт молчал.
    Здесь — что Lighthouse сам называет: элемент LCP и его фазы, работа
    главного потока, скрипты по времени выполнения, сторонние скрипты,
    неиспользуемый JS и длинные задачи. Нет аудита в отчёте — нет и строки:
    молчание не выдаётся за «всё хорошо», оно просто не печатается.
    """
    c = lh.get('categories') or {}
    a = lh.get('audits') or {}

    def sc(k: str) -> str:
        v = (c.get(k) or {}).get('score')
        return '—' if v is None else str(round(v * 100))

    def dv(k: str) -> str:
        return (a.get(k) or {}).get('displayValue', '—')

    def items(k: str) -> list[dict]:
        d = (a.get(k) or {}).get('details') or {}
        return [i for i in (d.get('items') or []) if isinstance(i, dict)]

    row = (f"| {url} | {sc('performance')} | {sc('seo')} | {sc('accessibility')} | {sc('best-practices')} | "
           f"{dv('largest-contentful-paint')} | {dv('cumulative-layout-shift')} | {dv('total-blocking-time')} |")

    det: list[str] = []
    node = _lh_first_node((a.get('largest-contentful-paint-element') or {}).get('details'))
    if node:
        what = node.get('selector') or node.get('nodeLabel') or '—'
        snippet = html.unescape(str(node.get('snippet') or ''))[:120]
        det.append(f"- элемент LCP: `{what}`" + (f" — `{snippet}`" if snippet else ''))
    phases = _lh_lcp_phases((a.get('largest-contentful-paint-element') or {}).get('details'))
    if phases:
        det.append('- фазы LCP: ' + ', '.join(f"{LH_PHASES.get(n, n)} {_lh_ms(t)}" for n, t in phases))
    # Сдвиги вёрстки: в Lighthouse 12 — `layout-shifts` (с причиной), в 10–11 —
    # `layout-shift-elements`. Прогон 9 (14.10): CLS /map 0,171 при пороге 0,1,
    # а что сдвигается — не сказано, и чинить было не по чему.
    shifts: list[dict] = []
    for key in ('layout-shifts', 'layout-shift-elements'):
        shifts = [i for i in items(key) if isinstance(i.get('node'), dict)]
        if shifts:
            break
    shifts = sorted(shifts, key=lambda i: -(i.get('score') or 0))[:3]
    if shifts:
        def shift(i: dict) -> str:
            n = i['node']
            what = str(n.get('selector') or n.get('nodeLabel') or '—')[:80]
            causes = [str(x.get('cause')) for x in ((i.get('subItems') or {}).get('items') or [])
                      if isinstance(x, dict) and x.get('cause')]
            score = i.get('score')
            share = f" {float(score):.3f}" if isinstance(score, (int, float)) else ''
            return f"`{what}`{share}" + (f" ({causes[0]})" if causes else '')
        det.append(f"- сдвиги вёрстки (CLS {dv('cumulative-layout-shift')}): " + '; '.join(shift(i) for i in shifts))
    groups = sorted(items('mainthread-work-breakdown'), key=lambda i: -(i.get('duration') or 0))[:3]
    if groups:
        det.append('- главный поток: ' + ', '.join(
            f"{i.get('groupLabel') or i.get('group')} {_lh_ms(i.get('duration'))}" for i in groups))
    boot = sorted(items('bootup-time'), key=lambda i: -(i.get('total') or 0))[:5]
    if boot:
        det.append('- скрипты по времени выполнения: ' + '; '.join(
            f"{_lh_short(str(i.get('url', '')), url)} {_lh_ms(i.get('total'))}" for i in boot))
    third = sorted(items('third-party-summary'), key=lambda i: -(i.get('blockingTime') or 0))[:4]
    if third:
        def ent(i: dict) -> str:
            e = i.get('entity')
            return str(e.get('text') if isinstance(e, dict) else e or '—')
        det.append('- сторонние: ' + '; '.join(
            f"{ent(i)} — блокировка {_lh_ms(i.get('blockingTime'))}, {_lh_kb(i.get('transferSize'))}" for i in third))
    unused = (a.get('unused-javascript') or {}).get('details') or {}
    waste = sorted(items('unused-javascript'), key=lambda i: -(i.get('wastedBytes') or 0))[:3]
    if waste:
        total = unused.get('overallSavingsBytes') or sum(i.get('wastedBytes') or 0 for i in items('unused-javascript'))
        det.append(f"- неиспользуемый JS: {_lh_kb(total)} (" + '; '.join(
            f"{_lh_short(str(i.get('url', '')), url)} {_lh_kb(i.get('wastedBytes'))}" for i in waste) + ')')
    longs = items('long-tasks')
    if longs:
        det.append(f"- длинных задач: {len(longs)}, самая длинная {_lh_ms(max(i.get('duration') or 0 for i in longs))}")
    weight = (a.get('total-byte-weight') or {}).get('numericValue')
    if weight is not None:
        det.append(f"- вес страницы: {_lh_kb(weight)}")
    if det:
        det.insert(0, f"**{url}** — TBT {dv('total-blocking-time')}, LCP {dv('largest-contentful-paint')}")
        det.append('')
    return row, det


def lighthouse_cli(argv: list[str]) -> int:
    """`site-audit.py lighthouse URL ОТЧЁТ.json РАСШИФРОВКА.md` — строка таблицы в stdout,
    расшифровка дописывается в файл. Отчёт не читается — строка «не измерено», не тишина."""
    url, path, details_path = argv
    try:
        lh = json.load(open(path, encoding='utf-8'))
    except (OSError, ValueError) as e:
        print(f"| {url} | не измерено: отчёт Lighthouse не прочитан ({str(e)[:80]}) | | | | | | |")
        return 0
    row, det = lighthouse_summary(url, lh)
    print(row)
    if det:
        with open(details_path, 'a', encoding='utf-8') as f:
            f.write('\n'.join(det) + '\n')
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--host', required=True)
    ap.add_argument('--max-pages', type=int, default=60)
    ap.add_argument('--link-checks', type=int, default=120)
    ap.add_argument('--json', default='')
    ap.add_argument('--lh-pages', default='')
    ap.add_argument('--scheme', default='https', choices=['https', 'http'])
    ap.add_argument('--sitemap-census', type=int, default=0, help='пройти до N адресов sitemap (0 — не проходить)')
    ap.add_argument('--ua', default='default', choices=['default', *BOT_UA.keys()])
    ap.add_argument('--census-md', default='', help='отчёт переписи — в этот файл (свой check-run), в stdout — только счёт')
    args = ap.parse_args()
    host = args.host.strip().lower().removeprefix('https://').removeprefix('http://').removeprefix('www.').strip('/')
    if args.scheme == 'https' and not re.fullmatch(r'[a-z0-9.-]+\.[a-z]{2,}', host):
        print(f'::error::хост «{args.host}» не похож на домен')
        return 2
    if args.ua != 'default':
        # Чужим краулером представляемся только у себя (и на локальной проверке скрипта).
        # Схема не в счёт: http к чужому домену — тот же чужой сайт.
        bare = host.rsplit(':', 1)[0] if host.count(':') == 1 else host
        if bare not in OWN_HOSTS and bare not in LOOPBACK:
            print(f'::error::заголовок бота ({args.ua}) — только для {", ".join(sorted(OWN_HOSTS))}, не для «{host}»')
            return 2
        global CURRENT_UA
        CURRENT_UA = BOT_UA[args.ua]
    a = audit(host, args.max_pages, args.link_checks, args.scheme)
    if args.sitemap_census > 0:
        a['census'] = census(a['sitemap_urls'], args.sitemap_census)
    if args.json:
        with open(args.json, 'w', encoding='utf-8') as f:
            json.dump(a, f, ensure_ascii=False, indent=1, default=str)
    if args.lh_pages:
        with open(args.lh_pages, 'w', encoding='utf-8') as f:
            f.write('\n'.join(a['lighthouse_pages']) + '\n')
    print(report(a))
    if 'census' in a:
        rc = report_census(a['census'], args.ua)
        if args.census_md:
            with open(args.census_md, 'w', encoding='utf-8') as f:
                f.write(rc + '\n')
            c = a['census']
            print(f"\n## Перепись sitemap: {c['checked']} из {c['of']}, 200 — {c['ok']} (подробно — check-run site-audit-census)")
            for i in c['issues']:
                print(f"- {i['what']} — {i['count']}")
        else:
            print(rc)
        # Перепись, не прошедшая ни одного адреса при непустом sitemap, — отказ, а не «чисто» (§4.0).
        if a['sitemap_urls'] and a['census']['checked'] == 0:
            print('\nПЕРЕПИСЬ НЕ УДАЛАСЬ: sitemap не пуст, а не пройдено ни одного адреса.')
            return 1
    # Отказ входа — красный прогон: «сайт не ответил» не равно «нарушений нет» (§4.0).
    if all(e['code'] == 0 for e in a['entry']):
        print('\nАУДИТ НЕ УДАЛСЯ: ни одно написание адреса не ответило.')
        return 1
    return 0


if __name__ == '__main__':
    if len(sys.argv) == 5 and sys.argv[1] == 'lighthouse':
        sys.exit(lighthouse_cli(sys.argv[2:]))
    sys.exit(main())
