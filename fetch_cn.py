#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
国内信源采集器 —— WAR GAME 情报站（国内周）
================================================
采集 SDGUN 水弹论坛 + B站（视频检索 / 专栏长文），输出原始素材供 AI 撰写。

【用法】
    python fetch_cn.py [输出目录]
    默认输出到 D:\\blog-hugo\\.cache\\fetch-cn

【产物】
    sdgun_list_<fid>.json     SDGUN 各版块帖子列表（标题/tid/作者/时间）
    sdgun_thread_<tid>.json   SDGUN 帖子详情（正文/图片/楼层）
    bili_video.json           B站视频检索结果
    bili_article.json         B站专栏检索结果
    bili_article_body_<cv>.json  B站专栏正文
    sources.json              采集汇总与状态

【两个必须遵守的实现约束（踩过坑）】
1. 网络：本机 Clash 为 TUN 模式，在系统层劫持 DNS 到 fake-IP(198.18.x.x)。
   本脚本【不走代理】，直连国内站点 —— 国内站对境外 IP 会拦截
   （百度 403），而本机代理出口为境外，故国内源必须直连。
   ⚠️ 实测：SDGUN / B站 直连可用；若网络环境变化需重新评估。
2. SDGUN 必须带会话 Cookie（discuz_2132_saltkey）：
   部分版块（如 fid=153 卫星区）直接访问会 302 跳 misc.php?mod=mobile。
   脚本先访问首页拿 Cookie，再带 Cookie 请求各版块。

【已实测结论（2026-09-20）】
- SDGUN：域名 bbs.sdgun.com.cn（sdgun.net 已废弃）
         PC 版被 closedonpc 插件屏蔽，【必须加 &mobile=2】
- B站：wbi 签名算法已复现；专栏正文走 x/article/view?id=<cv号>
"""

import json
import os
import re
import sys
import time
import gzip
import zlib
import hashlib
import urllib.parse
import urllib.request
import http.cookiejar

# ---------------- 配置 ----------------

UA_PC = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
         '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')
UA_MOBILE = ('Mozilla/5.0 (Linux; Android 12; RMX3161) AppleWebKit/537.36 '
             '(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36')

SDGUN_BASE = 'https://bbs.sdgun.com.cn/'
# 采集版块：只取与 wargame 内容最相关的
#   190 电玩讨论区(70万帖) / 153 卫星区(新品爆料) / 198 新无余(精华)
SDGUN_FORUMS = [
    ('190', '电玩讨论区'),
    ('153', '卫星区'),
    ('198', '新无余'),
]
SDGUN_LIST_LIMIT = 25      # 每版块取前 N 个帖子
SDGUN_THREAD_LIMIT = 8     # 全局最多抓 N 个帖子详情（控制耗时）

BILI_KEYWORDS = ['wargame', 'wargame下场', '水弹枪下场', '真人CS']

# 关键词污染过滤：某些词在中文里是多义词，会命中完全无关的内容。
# 实测（2026-09-20）：
#   「下场」→ 大量二次元同人文（《崩坏三》舰长、《女武神吃醋了》）、
#              以及 K-Pop「水弹音乐节」；「战术装备」→ MC 游戏模组。
#   故一律带上限定词（wargame / 水弹枪 / 真人CS），并做黑名单过滤。
BILI_BLOCK = re.compile(
    r'音乐节|K-Pop|Kpop|直拍|女武神|舰长|病娇|纯爱|同人|原神|崩坏|'
    r'模板|教程课|游戏内|我的世界|Minecraft|MC模组|模组码|'
    r'手工|折纸|儿歌|儿童|动画片|恶搞配音',
    re.I)

# 垂直度正向信号：命中才算 wargame 内容（减少噪声）
BILI_POSITIVE = re.compile(
    r'wargame|war\s?game|下场|真人\s?cs|水弹|发射器|战术|装备|'
    r'cqb|军推|掩体|突击|射击|对枪|橡皮|场次',
    re.I)

BILI_LIMIT = 20            # 每个关键词取 N 条（服务端上限 20）
BILI_KEEP = 10             # 过滤后每个关键词保留 N 条
BILI_ARTICLE_BODY_LIMIT = 6  # 最多抓 N 篇专栏正文

# 请求间隔（秒）—— 控制节奏，避免触发风控
DELAY_SDGUN = 2.0
DELAY_BILI = 1.5

# wbi 签名重排表（B站现行算法）
MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
    33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
    26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
    20, 34, 44, 52,
]


# ---------------- HTTP ----------------

class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """返回 3xx 而不自动跳转。"""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def fetch(url, headers=None, cookie_jar=None, timeout=30, follow=False, max_hops=5):
    """直连请求（不走代理）。返回 (status, bytes, headers) 或 (None, None, err)

    ⚠️ follow=True 的必要性（2026-09-20 实测）：
      SDGUN 的 `forum.php?mobile=2` 会 302 跳到 `portal.php`，
      **全部 4 个 Cookie（saltkey/lastvisit/lastact/bygsjw）都在跳转后**才下发。
      不跟随重定向 → jar 里只剩一个带 secure 的 lastact（被 jar 拒收）→ 实际 0 个。
      故会话建立必须 follow=True。
    """
    h = {'User-Agent': UA_PC, 'Accept-Encoding': 'gzip, deflate'}
    if headers:
        h.update(headers)
    try:
        # ⚠️ 必须用 `is not None` —— http.cookiejar.CookieJar 实现了 __len__，
        #    空 jar 的布尔值为 False（bool(CookieJar()) == False）。
        #    若写成 `if cookie_jar`，会造成「传进来的 jar 被丢弃、改用临时 jar」，
        #    症状是会话永远拿不到任何 Cookie（2026-09-20 踩坑，排查耗时最久）。
        opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(cookie_jar if cookie_jar is not None
                                               else http.cookiejar.CookieJar()),
            (urllib.request.HTTPRedirectHandler() if follow else _NoRedirect()),
        )
        req = urllib.request.Request(url, headers=h)
        for _ in range(max_hops if follow else 1):
            with opener.open(req, timeout=timeout) as r:
                raw = r.read()
                enc = (r.headers.get('Content-Encoding') or '').lower()
                if enc == 'gzip':
                    try:
                        raw = gzip.decompress(raw)
                    except Exception:
                        pass
                elif enc == 'deflate':
                    try:
                        raw = zlib.decompress(raw)
                    except Exception:
                        pass
                return r.status, raw, dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read() if e.fp else b'', {}
    except Exception as e:
        return None, None, str(e)
        with opener.open(req, timeout=timeout) as r:
            raw = r.read()
            enc = (r.headers.get('Content-Encoding') or '').lower()
            if enc == 'gzip':
                try:
                    raw = gzip.decompress(raw)
                except Exception:
                    pass
            elif enc == 'deflate':
                try:
                    raw = zlib.decompress(raw)
                except Exception:
                    pass
            return r.status, raw, dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read() if e.fp else b'', {}
    except Exception as e:
        return None, None, str(e)


def save(outdir, name, obj):
    p = os.path.join(outdir, name)
    with open(p, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
    return p


# ---------------- SDGUN ----------------

def strip_tags(s):
    s = re.sub(r'<script[\s\S]*?</script>', ' ', s, flags=re.I)
    s = re.sub(r'<style[\s\S]*?</style>', ' ', s, flags=re.I)
    s = re.sub(r'<[^>]+>', ' ', s)
    s = s.replace('&nbsp;', ' ').replace('&amp;', '&').replace('&lt;', '<').replace('&gt;', '>')
    return re.sub(r'\s+', ' ', s).strip()


def sdgun_session(retries=5):
    """先访问首页拿 Cookie（discuz_2132_saltkey），否则部分版块 302。

    ⚠️ 三个坑（2026-09-20 实测）：
      1. 必须 follow=True —— 首个 3xx 响应只带 1 个 secure cookie，
         全部 Cookie 在跳转到 portal.php 后的 200 响应里。
      2. 必须用 https —— 带 secure 标记的 cookie 在 http 请求下会被
         http.cookiejar 依据 RFC 6265 拒收，jar 恒为空。
      3. **下发是概率性的** —— 同一 header、同一 URL，实测有时给 5 个 Cookie，
         有时一个不给（边缘节点轮询）。故必须重试直到拿到 saltkey。
    """
    jar = http.cookiejar.CookieJar()
    st = None
    for attempt in range(retries):
        if attempt:
            time.sleep(1.5 + attempt)
        st, body, hdr = fetch('https://bbs.sdgun.com.cn/forum.php?mobile=2',
                              cookie_jar=jar, follow=True,
                              headers={'User-Agent': UA_MOBILE})
        names = [c.name for c in jar]
        if any('saltkey' in n for n in names):
            return jar, names, st
    return jar, [c.name for c in jar], st


def sdgun_list(jar, fid, fname):
    """抓版块帖子列表"""
    url = '%sforum.php?mod=forumdisplay&fid=%s&mobile=2' % (SDGUN_BASE, fid)
    st, body, hdr = fetch(url, cookie_jar=jar,
                          headers={'User-Agent': UA_MOBILE,
                                   'Accept': 'text/html,application/xhtml+xml,*/*'})
    if st != 200 or not body:
        return {'fid': fid, 'name': fname, 'error': 'HTTP %s' % st, 'threads': []}
    html = body.decode('utf-8', 'replace')

    # 帖子：forum.php?mod=viewthread&tid=NNN  + 标题 + 作者 uid
    threads = []
    seen = set()
    for m in re.finditer(
        r'href="forum\.php\?mod=viewthread&amp;tid=(\d+)[^"]*"[^>]*>(.{0,200}?)</a>',
        html, flags=re.S
    ):
        tid, raw = m.group(1), m.group(2)
        title = strip_tags(raw)
        # 过滤掉空标题 / 纯符号
        if not title or len(title) < 4 or tid in seen:
            continue
        seen.add(tid)
        threads.append({'tid': tid, 'title': title[:120]})
        if len(threads) >= SDGUN_LIST_LIMIT:
            break

    # 时间戳（列表页有「最后回复」时间）
    times = re.findall(r'\d{4}-\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2}', html)

    return {'fid': fid, 'name': fname, 'threads': threads,
            'times': times[:SDGUN_LIST_LIMIT]}


def sdgun_thread(jar, tid):
    """抓帖子详情：标题 / 作者 / 时间 / 正文 / 图片 / 楼层"""
    url = '%sthread-%s-1-1.html?mobile=2' % (SDGUN_BASE, tid)
    st, body, hdr = fetch(url, cookie_jar=jar,
                          headers={'User-Agent': UA_MOBILE,
                                   'Accept': 'text/html,application/xhtml+xml,*/*'})
    if st != 200 or not body:
        return {'tid': tid, 'error': 'HTTP %s' % st}
    html = body.decode('utf-8', 'replace')

    # 标题：<h1> 内是干净标题。
    # ⚠️ 不要用 <title> —— 它是「SDGun版块名+标题+SDGUN,水弹,水弹枪,水弹论坛」
    #    黏连格式，切分容易误伤（标题本身可能含"SDGUN"字样）。
    title = ''
    mh = re.search(r'<h1[^>]*>([\s\S]*?)</h1>', html)
    if mh:
        title = strip_tags(mh.group(1)).strip()
    if not title:
        mt = re.search(r'<title>([\s\S]*?)</title>', html)
        if mt:
            title = strip_tags(mt.group(1))
            title = re.sub(r'^(SDGun|SDgun)[^！!?？]{0,10}区', '', title)   # 去版块前缀
            title = re.split(r'\s*SDGUN,|SDGun,|\s+-\s+手机版', title)[0].strip()

    # 楼层：class="post_author" 内 <em class="post_number">N#</em> + <a class="blue">用户名</a>
    floors_meta = []
    for m in re.finditer(r'class="post_author"[^>]*>([\s\S]{0,700}?)</ul>', html):
        seg = m.group(1)
        no = re.search(r'class="post_number">\s*(\d+)\s*<sup>#', seg)
        who = re.search(r'class="blue">([^<]{1,40})</a>', seg)
        wen = re.search(r'<span class="z">([^<]{1,30})</span>', seg)
        floors_meta.append({
            'no': no.group(1) if no else '',
            'author': who.group(1).strip() if who else '',
            'when': wen.group(1).strip().replace('&nbsp;', ' ') if wen else '',
        })

    # 正文：class="message"
    msgs = re.findall(r'<div[^>]*class="message"[^>]*>([\s\S]*?)</div>\s*</div>', html)
    bodies = []
    for i, m in enumerate(msgs):
        imgs = re.findall(r'src="([^"]+)"', m)
        imgs = [u for u in imgs if not re.search(r'face|static|template/|iconfont|avatar', u)]
        txt = strip_tags(m)
        if not txt and not imgs:
            continue
        meta = floors_meta[i] if i < len(floors_meta) else {}
        bodies.append({
            'floor': meta.get('no') or str(i + 1),
            'author': meta.get('author', ''),
            'when': meta.get('when', ''),
            'text': txt,
            'images': imgs,
        })

    # 时间
    times = re.findall(r'\d{4}-\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?', html)

    main = bodies[0] if bodies else {}
    return {
        'tid': tid, 'url': url, 'title': title,
        'author': main.get('author', ''),
        'time_first': times[0] if times else main.get('when', ''),
        'text_main': main.get('text', ''),
        'images_main': main.get('images', []),
        'floor_count': len(bodies),
        'floors': bodies[:10],
    }


# ---------------- B站 ----------------

def bili_mixin_key(orig):
    return ''.join(orig[i] for i in MIXIN_KEY_ENC_TAB)[:32]


def bili_sign(params, img_key, sub_key):
    mk = bili_mixin_key(img_key + sub_key)
    p = dict(params)
    p['wts'] = int(time.time())
    q = '&'.join('%s=%s' % (urllib.parse.quote(str(k), safe=''),
                            urllib.parse.quote(str(p[k]).replace("'", '').replace('!', '')
                                               .replace('(', '').replace(')', '').replace('*', ''), safe=''))
                 for k in sorted(p.keys()))
    w_rid = hashlib.md5((q + mk).encode()).hexdigest()
    return q + '&w_rid=' + w_rid


def bili_keys():
    """取 wbi 密钥（nav 接口 code=-101 未登录不影响密钥下发）"""
    st, body, hdr = fetch('https://api.bilibili.com/x/web-interface/nav',
                          headers={'Referer': 'https://www.bilibili.com/'})
    if st != 200 or not body:
        return None, None
    try:
        j = json.loads(body.decode('utf-8'))
        wi = j['data']['wbi_img']
        ik = wi['img_url'].rsplit('/', 1)[-1].split('.')[0]
        sk = wi['sub_url'].rsplit('/', 1)[-1].split('.')[0]
        return ik, sk
    except Exception:
        return None, None


def bili_search(search_type, keyword, ik, sk, page=1):
    q = bili_sign({'search_type': search_type, 'keyword': keyword,
                   'page': page, 'page_size': BILI_LIMIT}, ik, sk)
    url = 'https://api.bilibili.com/x/web-interface/wbi/search/type?' + q
    st, body, hdr = fetch(url, headers={'Referer': 'https://www.bilibili.com/'})
    if st != 200 or not body:
        return None
    try:
        j = json.loads(body.decode('utf-8'))
        return j if j.get('code') == 0 else {'code': j.get('code'),
                                             'message': j.get('message')}
    except Exception:
        return None


def bili_relevant(item):
    """判断检索结果是否与 wargame 垂直相关。
    先排除黑名单噪声，再要求命中至少一个正向信号。"""
    blob = ' '.join([
        str(item.get('title', '')), str(item.get('desc', '')),
        str(item.get('description', '')), str(item.get('author', '')),
    ])
    if BILI_BLOCK.search(blob):
        return False
    return bool(BILI_POSITIVE.search(blob))


def bili_video_clean(v):
    return {
        'bvid': v.get('bvid', ''),
        'title': strip_tags(v.get('title', '')),
        'author': v.get('author', ''),
        'play': v.get('play', 0),
        'duration': v.get('duration', ''),
        'pubdate': time.strftime('%Y-%m-%d', time.localtime(v.get('pubdate', 0)))
                   if v.get('pubdate') else '',
        'desc': strip_tags(v.get('description', ''))[:200],
        'cover': ('https:' + v['pic']) if v.get('pic', '').startswith('//') else v.get('pic', ''),
    }


def bili_article_clean(v):
    urls = v.get('image_urls') or []
    cover = ''
    if urls:
        cover = ('https:' + urls[0]) if urls[0].startswith('//') else urls[0]
    return {
        'cv': str(v.get('id', '')),
        'title': strip_tags(v.get('title', '')),
        'author': v.get('author', ''),
        'view': v.get('view', 0),
        'like': v.get('like', 0),
        'reply': v.get('reply', 0),
        'pubdate': time.strftime('%Y-%m-%d', time.localtime(v.get('pubdate', 0)))
                   if v.get('pubdate') else '',
        'desc': strip_tags(v.get('desc', ''))[:200],
        'cover': cover,
    }


def bili_session():
    """建立 B站匿名会话：取 buvid3 / buvid4（风控必需）。
    返回 (cookie_jar, cookie_header)"""
    jar = http.cookiejar.CookieJar()
    try:
        fetch('https://www.bilibili.com/', cookie_jar=jar)
        time.sleep(0.6)
        st, body, _ = fetch('https://api.bilibili.com/x/frontend/finger/spi',
                            cookie_jar=jar,
                            headers={'Referer': 'https://www.bilibili.com/'})
        d = json.loads(body.decode('utf-8'))
        b3, b4 = d['data']['b_3'], d['data']['b_4']
        buvid3 = b3
        for c in jar:
            if c.name == 'buvid3':
                buvid3 = c.value
        ck = 'buvid3=%s; buvid4=%s; b_nut=%d' % (buvid3, b4, int(time.time()))
        return jar, ck
    except Exception:
        return jar, None


def bili_article_meta(cv, cookie_hdr=None):
    """专栏元数据 —— `x/article/viewinfo` 对匿名请求稳定可用（不同于 view）。
    即使正文拿不到，也能保底给出标题/作者/数据，供 AI 据摘要改写。"""
    try:
        hdr = {'User-Agent': UA_PC, 'Referer': 'https://www.bilibili.com/read/cv%s' % cv,
               'Accept': 'application/json,*/*'}
        if cookie_hdr:
            hdr['Cookie'] = cookie_hdr
        req = urllib.request.Request(
            'https://api.bilibili.com/x/article/viewinfo?id=%s' % cv, headers=hdr)
        with urllib.request.urlopen(req, timeout=30) as r:
            j = json.loads(r.read().decode('utf-8'))
        if j.get('code') == 0:
            d = j['data']
            st = d.get('stats') or {}
            return {
                'title': strip_tags(d.get('title', '')),
                'author': d.get('author_name', ''),
                'view': st.get('view', 0),
                'like': st.get('like', 0),
                'reply': st.get('reply', 0),
                'summary': strip_tags(d.get('summary', '')),
            }
    except Exception:
        pass
    return None


def bili_article_body(cv, cookie_hdr=None, retries=8):
    """专栏正文。
    ⚠️ 两条路径的可用性差异（2026-09-20 实测）：
      - API `x/article/view` 对匿名直连稳定返回 -352（接口级风控），不可用
      - 网页 SSR 可用，但**随机返回 3318 B 空壳页**，且不同文章放行概率不同
        （实测有文章 1 次即中，有文章连续 6 次空壳）。故重试上限设为 8 次，
        间隔递增；即便全部失败，调用方仍可用 viewinfo 元数据保底。
    正文容器：<div class="opus-module-content">（新版专栏）
    """
    for attempt in range(retries):
        if attempt:
            time.sleep(2.0 + attempt * 1.5)
        try:
            hdr = {'User-Agent': UA_PC,
                   'Accept': 'text/html,application/xhtml+xml,*/*',
                   'Accept-Language': 'zh-CN,zh;q=0.9',
                   'Referer': 'https://www.bilibili.com/'}
            if cookie_hdr:
                hdr['Cookie'] = cookie_hdr
            req = urllib.request.Request('https://www.bilibili.com/read/cv%s/' % cv,
                                         headers=hdr)
            with urllib.request.urlopen(req, timeout=30) as r:
                html = r.read().decode('utf-8', 'replace')
            if len(html) < 10000:
                continue        # 空壳页，重试
            m = re.search(
                r'<div[^>]*class="[^"]*opus-module-content[^"]*"[^>]*>([\s\S]*?)</div>\s*</div>',
                html)
            if not m:
                m = re.search(
                    r'<div[^>]*class="[^"]*opus-module-content[^"]*"[^>]*>([\s\S]{0,30000})',
                    html)
            if not m:
                continue
            inner = m.group(1)
            imgs = [u for u in re.findall(r'src="([^"]+)"', inner)
                    if 'hdslb' in u or 'bili' in u]
            text = strip_tags(inner)
            if not text:
                continue
            return {'cv': cv, 'text': text, 'text_len': len(text),
                    'images': imgs, 'retries': attempt}
        except Exception:
            continue
    return {'cv': cv, 'error': 'SSR 正文获取失败（重试 %d 次）' % retries}


# ---------------- 主流程 ----------------

def main():
    outdir = sys.argv[1] if len(sys.argv) > 1 else r'D:\blog-hugo\.cache\fetch-cn'
    os.makedirs(outdir, exist_ok=True)

    print('=' * 64)
    print('国内信源采集 —— WAR GAME 情报站')
    print('输出目录:', outdir)
    print('=' * 64)

    sources = {'sdgun': {}, 'bili': {}, 'collected_at': time.strftime('%Y-%m-%d %H:%M:%S')}

    # ---------- SDGUN ----------
    print('\n【SDGUN 论坛】')
    jar, ck_names, st = sdgun_session()
    print('  会话建立: HTTP %s | Cookie %d 个: %s' % (
        st, len(ck_names), ', '.join(ck_names[:4])))

    sdgun_lists = []
    all_threads = []
    for fid, fname in SDGUN_FORUMS:
        print('  版块 %s (%s) ...' % (fid, fname), end=' ', flush=True)
        info = sdgun_list(jar, fid, fname)
        n = len(info.get('threads', []))
        print('%d 帖' % n)
        sdgun_lists.append(info)
        for t in info.get('threads', []):
            t['forum'] = fname
            t['fid'] = fid
            all_threads.append(t)
        time.sleep(DELAY_SDGUN)

    save(outdir, 'sdgun_list.json', sdgun_lists)

    # 帖子详情：优先卫星区（新品爆料）与精华区，再按版块顺序补齐
    print('  抓取帖子详情（最多 %d 个）...' % SDGUN_THREAD_LIMIT)
    prio = [t for t in all_threads if t.get('fid') in ('153', '198')]
    rest = [t for t in all_threads if t.get('fid') not in ('153', '198')]
    picked = (prio + rest)[:SDGUN_THREAD_LIMIT]
    details = []
    for i, t in enumerate(picked, 1):
        d = sdgun_thread(jar, t['tid'])
        if 'error' not in d:
            d['forum'] = t.get('forum', '')
            d['list_title'] = t.get('title', '')
            details.append(d)
            print('    [%d/%d] %s' % (i, len(picked), (d.get('title') or '')[:44]))
        else:
            print('    [%d/%d] tid=%s 失败: %s' % (i, len(picked), t['tid'], d['error']))
        time.sleep(DELAY_SDGUN)

    save(outdir, 'sdgun_thread.json', details)
    sources['sdgun'] = {
        'session': 'HTTP %s' % st,
        'forums': [{'fid': f['fid'], 'name': f['name'],
                    'threads': len(f.get('threads', [])),
                    'error': f.get('error')} for f in sdgun_lists],
        'threads_total': len(all_threads),
        'details_fetched': len(details),
    }

    # ---------- B站 ----------
    print('\n【B站】')
    jar_b, ck_b = bili_session()
    print('  会话: %s' % ('OK' if ck_b else '失败（部分接口可能被风控）'))
    ik, sk = bili_keys()
    if not ik:
        print('  ❌ 未取到 wbi 密钥，跳过 B站')
        sources['bili'] = {'error': 'no wbi key'}
    else:
        print('  wbi 密钥: %s / %s' % (ik[:12], sk[:12]))

        videos, arts = [], []
        for kw in BILI_KEYWORDS:
            # 视频
            j = bili_search('video', kw, ik, sk)
            n_raw = n_keep = 0
            if j and j.get('code') == 0:
                for v in (j.get('data', {}).get('result') or []):
                    c = bili_video_clean(v)
                    if not c['bvid']:
                        continue
                    n_raw += 1
                    if not bili_relevant(c):
                        continue
                    c['keyword'] = kw
                    videos.append(c)
                    n_keep += 1
                    if n_keep >= BILI_KEEP:
                        break
            print('  视频「%s」: %d 条（过滤前 %d，滤除 %d 条噪声）' % (
                kw, n_keep, n_raw, n_raw - n_keep))
            time.sleep(DELAY_BILI)

            # 专栏
            j = bili_search('article', kw, ik, sk)
            n_raw = n_keep = 0
            if j and j.get('code') == 0:
                for v in (j.get('data', {}).get('result') or []):
                    c = bili_article_clean(v)
                    if not c['cv']:
                        continue
                    n_raw += 1
                    if not bili_relevant(c):
                        continue
                    c['keyword'] = kw
                    arts.append(c)
                    n_keep += 1
                    if n_keep >= BILI_KEEP:
                        break
            print('  专栏「%s」: %d 条（过滤前 %d，滤除 %d 条噪声）' % (
                kw, n_keep, n_raw, n_raw - n_keep))
            time.sleep(DELAY_BILI)

        save(outdir, 'bili_video.json', videos)
        save(outdir, 'bili_article.json', arts)

        # 专栏正文：优先取阅读+点赞高的（内容质量代理指标）
        # 去重（同一篇可能被多个关键词命中）
        uniq = {}
        for a in arts:
            cv = a['cv']
            if cv not in uniq or a.get('view', 0) > uniq[cv].get('view', 0):
                uniq[cv] = a
        arts_sorted = sorted(uniq.values(),
                             key=lambda x: (x.get('view', 0) + x.get('like', 0) * 5),
                             reverse=True)
        bodies = []
        print('  抓取专栏正文（最多 %d 篇，SSR 空壳自动重试 + 元数据保底）...'
              % BILI_ARTICLE_BODY_LIMIT)
        for a in arts_sorted[:BILI_ARTICLE_BODY_LIMIT]:
            b = bili_article_body(a['cv'], ck_b)
            b['title'] = a.get('title', '')
            b['author'] = a.get('author', '')
            b['view'] = a.get('view', 0)
            b['like'] = a.get('like', 0)
            b['url'] = 'https://www.bilibili.com/read/cv%s' % a['cv']
            if 'error' in b:
                # 正文失败 → 用 viewinfo 元数据保底（标题/数据/摘要）
                meta = bili_article_meta(a['cv'], ck_b)
                if meta:
                    b['meta_fallback'] = True
                    b['title'] = meta.get('title') or b['title']
                    b['author'] = meta.get('author') or b['author']
                    b['view'] = meta.get('view', b['view'])
                    b['like'] = meta.get('like', b['like'])
                    b['summary'] = meta.get('summary', '')
                    print('    cv%s 正文失败，元数据保底：%s' % (
                        a['cv'], b['title'][:36]))
                else:
                    print('    cv%s 失败: %s' % (a['cv'], b['error']))
                bodies.append(b)
            else:
                bodies.append(b)
                print('    cv%s %d 字 (重试%d) | %s' % (
                    b['cv'], b['text_len'], b.get('retries', 0), b['title'][:36]))
            time.sleep(DELAY_BILI)

        save(outdir, 'bili_article_body.json', bodies)
        sources['bili'] = {
            'wbi': 'ok',
            'videos': len(videos),
            'articles': len(arts),
            'article_bodies': len(bodies),
        }

    # ---------- 汇总 ----------
    save(outdir, 'sources.json', sources)

    print('\n' + '=' * 64)
    print('采集完成')
    print('  SDGUN: %d 版块 / %d 帖列表 / %d 帖详情' % (
        len(sdgun_lists), len(all_threads), len(details)))
    print('  B站  : %d 视频 / %d 专栏 / %d 正文' % (
        len(videos) if 'videos' in dir() else 0,
        len(arts) if 'arts' in dir() else 0,
        len(bodies) if 'bodies' in dir() else 0))
    print('  产物目录:', outdir)
    print('=' * 64)


if __name__ == '__main__':
    main()
