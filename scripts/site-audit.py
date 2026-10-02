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
"""
from __future__ import annotations

import argparse
import html
import json
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
PAUSE = 0.4


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
            'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
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
        self.imgs_no_alt = 0
        self.scripts = 0
        self.jsonld: list[str] = []
        self._in_jsonld = False
        self.http_assets = 0
        self.hreflang = 0
        self.favicon = False
        self._skip = 0
        self.words = 0
        self.forms = 0
        self.iframes = 0

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == 'html' and a.get('lang'):
            self.lang = a['lang']
        elif tag == 'title':
            self._in_title = True
        elif tag == 'meta':
            name = (a.get('name') or '').lower()
            prop = (a.get('property') or '').lower()
            content = a.get('content') or ''
            if name in ('description', 'robots', 'viewport', 'yandex-verification', 'google-site-verification', 'generator'):
                self.meta[name] = content
                if name == 'viewport':
                    self.viewport = True
            if prop.startswith('og:'):
                self.og[prop[3:]] = content
        elif tag == 'link':
            rel = (a.get('rel') or '').lower()
            if 'canonical' in rel:
                self.canonical = urllib.parse.urljoin(self.base, a.get('href') or '')
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
            if not (a.get('alt') or '').strip():
                self.imgs_no_alt += 1
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
        elif tag == 'form':
            self.forms += 1
        elif tag == 'iframe':
            self.iframes += 1

    def handle_endtag(self, tag):
        if tag == 'title':
            self._in_title = False
        elif tag in ('h1', 'h2'):
            self._in_h = None
        elif tag in ('script', 'style', 'noscript', 'svg'):
            self._skip = max(0, self._skip - 1)
            if tag == 'script':
                self._in_jsonld = False

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        elif self._in_jsonld:
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
        locs = re.findall(r'<loc>\s*([^<\s]+)\s*</loc>', txt)
        is_index = '<sitemapindex' in txt
        sm_report.append({'url': sm, 'code': r['code'], 'urls': len(locs), 'index': is_index,
                          'lastmod': len(re.findall(r'<lastmod>', txt))})
        if is_index:
            for child in locs[:5]:
                rc = fetch(child)
                ctxt = rc['body'].decode('utf-8', 'replace') if rc['code'] == 200 else ''
                clocs = re.findall(r'<loc>\s*([^<\s]+)\s*</loc>', ctxt)
                sm_report.append({'url': child, 'code': rc['code'], 'urls': len(clocs), 'index': False,
                                  'lastmod': len(re.findall(r'<lastmod>', ctxt))})
                sm_urls += clocs
                time.sleep(PAUSE)
        else:
            sm_urls += locs
        time.sleep(PAUSE)
    out['sitemaps'] = sm_report
    out['sitemap_urls_total'] = len(sm_urls)

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
    add('low', '<title> длиннее 60 знаков (в выдаче обрежется)', [p['url'] for p in ok_pages if len(p['title']) > 60])
    add('high', 'нет meta description', [p['url'] for p in ok_pages if not p['description']])
    add('medium', 'одинаковый description на нескольких страницах', [f'«{d[:60]}» × {n}' for d, n in descs.items() if n > 1])
    add('low', 'description короче 70 или длиннее 160 знаков', [p['url'] for p in ok_pages if p['description'] and not (70 <= len(p['description']) <= 160)])
    add('high', 'нет H1', [p['url'] for p in ok_pages if not p['h1']])
    add('medium', 'больше одного H1', [p['url'] for p in ok_pages if len(p['h1']) > 1])
    add('medium', 'нет canonical', [p['url'] for p in ok_pages if not p['canonical']])
    add('high', 'canonical указывает на другой адрес', [f"{p['url']} -> {p['canonical']}" for p in ok_pages if p['canonical'] and norm(p['canonical']) != norm(p['final'])])
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


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--host', required=True)
    ap.add_argument('--max-pages', type=int, default=60)
    ap.add_argument('--link-checks', type=int, default=120)
    ap.add_argument('--json', default='')
    ap.add_argument('--lh-pages', default='')
    ap.add_argument('--scheme', default='https', choices=['https', 'http'])
    args = ap.parse_args()
    host = args.host.strip().lower().removeprefix('https://').removeprefix('http://').removeprefix('www.').strip('/')
    if args.scheme == 'https' and not re.fullmatch(r'[a-z0-9.-]+\.[a-z]{2,}', host):
        print(f'::error::хост «{args.host}» не похож на домен')
        return 2
    a = audit(host, args.max_pages, args.link_checks, args.scheme)
    if args.json:
        with open(args.json, 'w', encoding='utf-8') as f:
            json.dump(a, f, ensure_ascii=False, indent=1, default=str)
    if args.lh_pages:
        with open(args.lh_pages, 'w', encoding='utf-8') as f:
            f.write('\n'.join(a['lighthouse_pages']) + '\n')
    print(report(a))
    # Отказ входа — красный прогон: «сайт не ответил» не равно «нарушений нет» (§4.0).
    if all(e['code'] == 0 for e in a['entry']):
        print('\nАУДИТ НЕ УДАЛСЯ: ни одно написание адреса не ответило.')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
