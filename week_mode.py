#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
双轨周轮换判定 —— WAR GAME 情报站
=====================================
一周国内、一周国际，按周一为锚点的自然周轮换。

【判定规则】
以 ISO 周数（ISO 8601 week number）的奇偶性判定：
    偶数周 → 国内周（CN）
    奇数周 → 国际周（INTL）

【为什么用 ISO 周数而不是「自起始日累计周数」】
ISO 周数由 Python 标准库 `date.isocalendar()` 提供，跨年自动正确衔接
（每年第 1 周是包含当年首个周四的那一周），无需自己维护起始日、
也不会因闰年或跨年出现漂移。

【用法】
    python week_mode.py              # 输出当前模式
    python week_mode.py --json       # JSON 格式
    python week_mode.py --date 2026-09-21   # 指定日期

【输出】
    CN    国内周
    INTL  国际周

【切换锚点】
每个自然周一开始（周一 00:00）。自动化任务在周一 08:00 运行，
此时拿到的是新一周的模式，确保切换干净。
"""

import sys
import json
import datetime

# 奇数周还是偶数周对应国内？这里定为「偶数周 = 国内」。
# 若需反转，只需把下面的 CN_PARITY 从 'even' 改成 'odd'。
CN_PARITY = 'even'


def get_mode(d: datetime.date = None):
    """返回 (mode, week_no, year)"""
    if d is None:
        d = datetime.date.today()
    iso = d.isocalendar()
    week_no = iso[1]
    is_even = (week_no % 2 == 0)
    if CN_PARITY == 'even':
        mode = 'CN' if is_even else 'INTL'
    else:
        mode = 'INTL' if is_even else 'CN'
    return mode, week_no, iso[0]


def describe(mode):
    return {
        'CN': '国内周',
        'INTL': '国际周',
    }.get(mode, mode)


def main():
    args = sys.argv[1:]
    d = None
    as_json = False
    i = 0
    while i < len(args):
        if args[i] == '--json':
            as_json = True
        elif args[i] == '--date' and i + 1 < len(args):
            try:
                d = datetime.date.fromisoformat(args[i + 1])
            except Exception:
                print('日期格式错误，应为 YYYY-MM-DD', file=sys.stderr)
                sys.exit(2)
            i += 1
        i += 1

    mode, week_no, year = get_mode(d)
    target = d or datetime.date.today()

    # 本周一与下周一（便于提示切换时点）
    monday = target - datetime.timedelta(days=target.weekday())
    next_monday = monday + datetime.timedelta(days=7)
    next_mode, _, _ = get_mode(next_monday)

    if as_json:
        print(json.dumps({
            'mode': mode,
            'label': describe(mode),
            'week_no': week_no,
            'year': year,
            'date': target.isoformat(),
            'week_start': monday.isoformat(),
            'next_switch': next_monday.isoformat(),
            'next_mode': next_mode,
        }, ensure_ascii=False, indent=2))
    else:
        print('%s\t%s\t(ISO %s 年第 %d 周, %s)' % (
            mode, describe(mode), year, week_no, target.isoformat()))


if __name__ == '__main__':
    main()
