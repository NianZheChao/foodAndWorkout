#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""减脂增肌工作区统计工具。

只读解析 records/*.md 与 targets.md，输出可直接粘贴进 Markdown 的汇总、趋势、
TDEE 反推与格式校验结果。把"数表格里的数字"交给脚本，把"判断和推荐"交给 skill。

用法见 README.md 或 `python scripts/nutrition.py -h`。
"""

import argparse
import csv
import datetime as dt
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
WS = os.path.dirname(HERE)
RECORDS_DIR = os.path.join(WS, 'records')
PLANS_DIR = os.path.join(WS, 'plans')
TARGETS_MD = os.path.join(WS, 'targets.md')
PROFILE_MD = os.path.join(WS, 'profile.md')
FOODS_CSV = os.path.join(WS, 'data', 'foods.csv')
DAILY_TEMPLATE = os.path.join(WS, 'templates', 'daily.md')

WEEKDAY_CN = '一二三四五六日'
MEALS = ('早餐', '午餐', '晚餐', '加餐')
KCAL_PER_KG = 7700.0

INC_COLS = (('kcal', '热量'), ('protein', '蛋白'), ('fat', '脂肪'),
            ('carb', '碳水'), ('fiber', '纤维'), ('sodium', '钠'))
TRAIN_COLS = (('minutes', '时长'), ('burn', '消耗'), ('muscles', '肌群'),
              ('rpe', 'RPE'), ('volume', '重量'), ('kind', '类型'), ('move', '动作'))

FM_RE = re.compile(r'^---[ \t]*\n(.*?)\n---[ \t]*\n', re.S)
ROW_RE = re.compile(r'^\s*\|(.*)\|\s*$')
SEP_CELL_RE = re.compile(r'^:?-{2,}:?$')
NUM_RE = re.compile(r'-?\d+(?:\.\d+)?')
STRICT_NUM_RE = re.compile(r'^\s*(-?\d+(?:\.\d+)?)\s*(kg|g|ml|l|h|min|kcal)?\s*$', re.I)
SETS_RE = re.compile(r'^(\d+)\s*[xх×*]\s*(\d+)\s*[xх×*]\s*([\d.]+|自重|徒手)')
AUTO_RE = re.compile(r'(<!-- AUTO:SUMMARY:BEGIN -->)(.*?)(<!-- AUTO:SUMMARY:END -->)', re.S)
SEC_RE = re.compile(r'^##[ \t]+(.*?)[ \t]*$')

WEIGHT_MIN, WEIGHT_MAX = 25.0, 300.0
WEIGHT_AM, WEIGHT_PM = 'weight_am_kg', 'weight_pm_kg'
BODYWEIGHT_MARKS = ('自重', '徒手')


def out(text=''):
    sys.stdout.write(str(text) + '\n')


def read_text(path):
    # utf-8-sig：兼容 Windows 编辑器写出的 BOM，无 BOM 时行为与 utf-8 相同
    with open(path, 'r', encoding='utf-8-sig') as handle:
        return handle.read()


def write_text(path, text):
    directory = os.path.dirname(path)
    if directory and not os.path.isdir(directory):
        os.makedirs(directory)
    with open(path, 'w', encoding='utf-8', newline='\n') as handle:
        handle.write(text)


def today():
    return dt.date.today().isoformat()


def num(value):
    """从单元格里取出第一个数字，取不到返回 None。"""
    if value is None:
        return None
    value = value.strip().replace(',', '').replace('，', '')
    if not value or value in ('-', '—', '/', 'n/a', 'NA'):
        return None
    match = NUM_RE.search(value)
    return float(match.group(0)) if match else None


def strict_num(value):
    """整串都必须是数字（允许带常见单位），否则返回 None。"""
    if value is None:
        return None
    match = STRICT_NUM_RE.match(value.strip())
    return float(match.group(1)) if match else None


def plausible_weight(value):
    return value is not None and WEIGHT_MIN <= value <= WEIGHT_MAX


def day_weights(day):
    """返回 (晨重, 睡前重, 旧字段 weight_kg)；缺失为 None。"""
    front = day['front']
    return (num(front.get(WEIGHT_AM)), num(front.get(WEIGHT_PM)),
            num(front.get('weight_kg')))


def trend_weight(day):
    """趋势与 TDEE 的唯一基准：优先晨重，旧记录退回 weight_kg。返回 (值, 口径)。"""
    am, _, legacy = day_weights(day)
    if plausible_weight(am):
        return am, 'am'
    if plausible_weight(legacy):
        return legacy, 'legacy'
    return None, ''


def set_load(raw_volume):
    """解析「组x次x重量」，返回 (组数, 次数, 重量kg, 容量kg)。

    自重动作格式正确但重量、容量为 None；格式不符时整体返回 None。
    """
    match = SETS_RE.match(raw_volume.strip()) if raw_volume else None
    if not match:
        return None
    sets, reps = int(match.group(1)), int(match.group(2))
    token = match.group(3)
    weight = None if token in BODYWEIGHT_MARKS else num(token)
    return sets, reps, weight, (sets * reps * weight if weight else None)


def theil_sen(xs, ys):
    """两两斜率取中位数。对个别离群体重远比最小二乘稳健。"""
    slopes = []
    for i in range(len(xs)):
        for j in range(i + 1, len(xs)):
            dx = xs[j] - xs[i]
            if dx:
                slopes.append((ys[j] - ys[i]) / dx)
    if not slopes:
        return None
    slopes.sort()
    mid = len(slopes) // 2
    return slopes[mid] if len(slopes) % 2 else (slopes[mid - 1] + slopes[mid]) / 2


def parse_front_matter(text):
    match = FM_RE.match(text)
    if not match:
        return {}, text
    front = {}
    for line in match.group(1).splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith('#'):
            continue
        if ':' not in stripped:
            continue
        key, val = stripped.split(':', 1)
        front[key.strip()] = val.strip()
    return front, text[match.end():]


def parse_tables(text):
    tables = []
    current = None
    for line in text.splitlines():
        match = ROW_RE.match(line)
        if match:
            cells = [c.strip() for c in match.group(1).split('|')]
            if current is None:
                current = {'headers': cells, 'rows': []}
            elif cells and all(SEP_CELL_RE.match(c) for c in cells):
                continue
            else:
                current['rows'].append(cells)
        elif current is not None:
            tables.append(current)
            current = None
    if current is not None:
        tables.append(current)
    return tables


def split_sections(body):
    sections = {}
    name = None
    buf = []
    for line in body.splitlines():
        match = SEC_RE.match(line)
        if match:
            if name is not None:
                sections[name] = '\n'.join(buf)
            name = match.group(1).strip()
            buf = []
        elif name is not None:
            buf.append(line)
    if name is not None:
        sections[name] = '\n'.join(buf)
    return sections


def pick_section(sections, keyword):
    for name, text in sections.items():
        if keyword in name:
            return text
    return ''


def pick_table(tables, keywords):
    for table in tables:
        joined = ''.join(table['headers'])
        if all(k in joined for k in keywords):
            return table
    return None


def col(headers, keyword):
    for i, header in enumerate(headers):
        if keyword in header:
            return i
    return None


def cell(row, index):
    if index is None or index >= len(row):
        return ''
    return row[index]


def iso_week(day):
    year, week, _ = day.isocalendar()
    return '%d-W%02d' % (year, week)


def week_bounds(day):
    start = day - dt.timedelta(days=day.weekday())
    return start, start + dt.timedelta(days=6)


def load_day(date):
    path = os.path.join(RECORDS_DIR, date + '.md')
    if not os.path.isfile(path):
        return None
    text = read_text(path)
    front, body = parse_front_matter(text)
    sections = split_sections(body)
    inc_table = pick_table(parse_tables(pick_section(sections, '摄入')), ('热量',))
    trn_table = pick_table(parse_tables(pick_section(sections, '训练')), ('时长',))
    intake, rows = {}, 0
    for key, _ in INC_COLS:
        intake[key] = 0.0
    if inc_table:
        index = {key: col(inc_table['headers'], token) for key, token in INC_COLS}
        for row in inc_table['rows']:
            for key, i in index.items():
                value = num(cell(row, i))
                if value is not None:
                    intake[key] += value
            rows += 1
    training = {'minutes': 0.0, 'burn': 0.0, 'sets': 0, 'muscles': {}, 'rows': 0, 'rpe': [],
                'muscle_load': {}, 'load': 0.0, 'loaded_sets': 0, 'bodyweight_sets': 0,
                'moves': {}}
    if trn_table:
        index = {key: col(trn_table['headers'], token) for key, token in TRAIN_COLS}
        for row in trn_table['rows']:
            training['rows'] += 1
            rpe = num(cell(row, index['rpe']))
            if rpe:
                training['rpe'].append(rpe)
            minutes = num(cell(row, index['minutes']))
            if minutes:
                training['minutes'] += minutes
            burn = num(cell(row, index['burn']))
            if burn:
                training['burn'] += burn
            raw_sets = cell(row, index['volume']).strip()
            parsed = set_load(raw_sets)
            sets = parsed[0] if parsed else 1
            load = parsed[3] if parsed else None
            training['sets'] += sets
            if load:
                training['load'] += load
                training['loaded_sets'] += sets
            else:
                training['bodyweight_sets'] += sets
            muscle_names = []
            for part in re.split(r'[、,，/＋+]', cell(row, index['muscles'])):
                part = part.strip()
                if part:
                    muscle_names.append(part)
                    training['muscles'][part] = training['muscles'].get(part, 0) + sets
                    if load:
                        training['muscle_load'][part] = training['muscle_load'].get(part, 0.0) + load
            move = cell(row, index['move']).strip()
            if move:
                entry = training['moves'].setdefault(
                    move, {'sets': 0, 'load': 0.0, 'volume': '', 'muscles': ''})
                entry['sets'] += sets
                entry['load'] += load or 0.0
                entry['volume'] = raw_sets or entry['volume']
                entry['muscles'] = '/'.join(muscle_names) or entry['muscles']
    return {'date': date, 'path': path, 'front': front, 'intake': intake,
            'rows': rows, 'training': training, 'text': text,
            'inc_table': inc_table, 'trn_table': trn_table}


def record_dates():
    if not os.path.isdir(RECORDS_DIR):
        return []
    dates = []
    for name in os.listdir(RECORDS_DIR):
        if name.endswith('.md'):
            stem = name[:-3]
            try:
                dt.date.fromisoformat(stem)
            except ValueError:
                continue
            dates.append(stem)
    return sorted(dates)


def load_targets():
    if not os.path.isfile(TARGETS_MD):
        return {}
    front, _ = parse_front_matter(read_text(TARGETS_MD))
    return front


def fmt(value):
    if value is None:
        return '-'
    return ('%.1f' % value).rstrip('0').rstrip('.') if abs(value - round(value)) > 1e-9 else str(int(round(value)))


def fmt_signed(value):
    if value is None:
        return '-'
    return ('+' if value > 0 else '') + fmt(value)


def moving_average(weights, date, window):
    end = dt.date.fromisoformat(date)
    start = end - dt.timedelta(days=window - 1)
    values = [w for d, w in weights.items() if start <= dt.date.fromisoformat(d) <= end]
    return sum(values) / len(values) if values else None


def summary_lines(date, day, targets):
    intake = day['intake']
    pairs = (
        ('热量(kcal)', intake['kcal'], num(targets.get('kcal_target')), ''),
        ('蛋白质(g)', intake['protein'], num(targets.get('protein_target_g')), ''),
        ('脂肪(g)', intake['fat'], num(targets.get('fat_target_g')), ''),
        ('碳水(g)', intake['carb'], num(targets.get('carb_target_g')), ''),
        ('纤维(g)', intake['fiber'], num(targets.get('fiber_target_g')), ''),
        ('钠(mg)', intake['sodium'], num(targets.get('sodium_max_mg')), 'max'),
    )
    lines = ['| 项目 | 摄入 | 目标 | 差额 | 占比 |',
             '| --- | ---: | ---: | ---: | ---: |']
    for label, got, want, mode in pairs:
        if want is None:
            lines.append('| %s | %s | - | - | - |' % (label, fmt(got)))
            continue
        diff = got - want
        prefix = '≤' if mode == 'max' else ''
        share = '%.0f%%' % (got / want * 100) if want else '-'
        lines.append('| %s | %s | %s%s | %s | %s |'
                     % (label, fmt(got), prefix, fmt(want), fmt_signed(diff), share))

    train = day['training']
    am, pm, legacy = day_weights(day)
    weight_parts = []
    if am is not None:
        weight_parts.append('晨重 %s kg' % fmt(am))
    elif legacy is not None:
        weight_parts.append('旧字段体重 %s kg（未区分晨晚）' % fmt(legacy))
    if pm is not None:
        weight_parts.append('睡前 %s kg' % fmt(pm))
    if am is not None and pm is not None:
        weight_parts.append('当日净增 %s kg' % fmt_signed(pm - am))
    lines.append('')
    if weight_parts:
        lines.append('**体重**：%s' % ' · '.join(weight_parts))
        lines.append('')
    if train['rows']:
        pieces = ['%d 个动作' % train['rows']]
        if train['minutes']:
            pieces.append('%s 分钟' % fmt(train['minutes']))
        pieces.append('合计 %d 组' % train['sets'])
        if train['load']:
            pieces.append('容量负荷 %s kg' % fmt(train['load']))
        if train['bodyweight_sets']:
            pieces.append('自重 %d 组' % train['bodyweight_sets'])
        pieces.append('估算消耗 %s kcal' % fmt(train['burn']))
        pieces.append('RPE %s' % (fmt(sum(train['rpe']) / len(train['rpe']))
                                  if train['rpe'] else '-'))
        lines.append('**训练**：' + ' · '.join(pieces))
        muscles = '、'.join('%s %d组' % (k, v) for k, v in train['muscles'].items())
        if muscles:
            lines.append('**涉及肌群**：%s' % muscles)
    else:
        lines.append('**训练**：无记录（休息日）')

    notes = []
    kcal_target = num(targets.get('kcal_target'))
    if kcal_target and intake['kcal']:
        ratio = intake['kcal'] / kcal_target
        if ratio > 1.1:
            notes.append('热量超出目标 %.0f%%，若为计划内的高热量日请忽略' % ((ratio - 1) * 100))
        elif ratio < 0.7:
            notes.append('热量明显低于目标（%.0f%%），长期过低会掉肌肉并降低 TDEE' % (ratio * 100))
    protein_target = num(targets.get('protein_target_g'))
    if protein_target and intake['protein'] < protein_target * 0.9:
        notes.append('蛋白质差 %.0f g，优先补乳清、鸡胸、蛋、脱脂奶' % (protein_target - intake['protein']))
    sodium_max = num(targets.get('sodium_max_mg'))
    if sodium_max and intake['sodium'] > sodium_max:
        notes.append('钠超出上限 %.0f mg，注意酱油、加工肉、外食' % (intake['sodium'] - sodium_max))
    fiber_target = num(targets.get('fiber_target_g'))
    if fiber_target and intake['fiber'] < fiber_target:
        notes.append('纤维差 %.0f g，加蔬菜、燕麦或豆类' % (fiber_target - intake['fiber']))
    if notes:
        lines.append('')
        for note in notes:
            lines.append('- %s' % note)
    return lines


def cmd_new(args):
    date = args.date or today()
    try:
        day = dt.date.fromisoformat(date)
    except ValueError:
        out('日期格式应为 YYYY-MM-DD：%s' % date)
        return 2
    path = os.path.join(RECORDS_DIR, date + '.md')
    if os.path.exists(path) and not args.force:
        out('已存在，未改动：records/%s.md（需要覆盖请加 --force）' % date)
        return 0
    text = (read_text(DAILY_TEMPLATE)
            .replace('{{DATE}}', date)
            .replace('{{WEEKDAY}}', WEEKDAY_CN[day.weekday()]))
    write_text(path, text)
    out('已创建：records/%s.md' % date)
    previous = [d for d in record_dates() if d < date]
    if previous:
        last = load_day(previous[-1])
        label = ''
        if last:
            am, pm, legacy = day_weights(last)
            if am is not None:
                label = '（晨重 %s kg）' % fmt(am)
            elif legacy is not None:
                label = '（体重 %s kg，旧字段）' % fmt(legacy)
            elif pm is not None:
                label = '（睡前 %s kg）' % fmt(pm)
        out('上一记录日：%s%s' % (previous[-1], label))
    targets = load_targets()
    target = targets.get('kcal_target')
    out('每日热量目标：%s' % ('%s kcal' % target if target else '未设置，先完成首次校准'))
    week = iso_week(day)
    plan = os.path.join(PLANS_DIR, week + '.md')
    out('本周计划：%s' % ('plans/%s.md 已存在' % week if os.path.isfile(plan)
                          else 'plans/%s.md 缺失（可用 fatloss-plan 生成）' % week))
    return 0


def cmd_totals(args):
    date = args.date or today()
    day = load_day(date)
    if day is None:
        out('没有记录文件：records/%s.md（先运行 new）' % date)
        return 1
    targets = load_targets()
    body = '\n'.join(summary_lines(date, day, targets))
    out(body)
    if args.write:
        text = read_text(day['path'])
        block = '<!-- AUTO:SUMMARY:BEGIN -->\n%s\n<!-- AUTO:SUMMARY:END -->' % body
        if AUTO_RE.search(text):
            text = AUTO_RE.sub(lambda _: block, text, count=1)
        else:
            text = text.rstrip('\n') + '\n\n' + block + '\n'
        write_text(day['path'], text)
        out('')
        out('已写回 records/%s.md 的 AUTO:SUMMARY 区块' % date)
    return 0


def training_detail(days):
    """按动作汇总区间内的容量负荷，用于看同一动作是否在渐进超负荷。"""
    moves = {}
    for day in days:
        for name, entry in day['training']['moves'].items():
            item = moves.setdefault(name, {'dates': [], 'sets': 0, 'load': 0.0,
                                           'volume': '', 'muscles': ''})
            item['dates'].append(day['date'])
            item['sets'] += entry['sets']
            item['load'] += entry['load']
            item['volume'] = entry['volume'] or item['volume']
            item['muscles'] = entry['muscles'] or item['muscles']
    if not moves:
        return '**训练明细**：区间内无训练记录。'
    lines = ['**训练明细**', '',
             '| 动作 | 目标肌群 | 出现 | 组数 | 最近一次 | 区间容量(kg) |',
             '| --- | --- | ---: | ---: | --- | ---: |']
    for name, item in sorted(moves.items(), key=lambda kv: (-kv[1]['load'], kv[0])):
        lines.append('| %s | %s | %d 次 | %d | %s | %s |' % (
            name, item['muscles'] or '-', len(item['dates']), item['sets'],
            item['volume'] or '-', fmt(item['load']) if item['load'] else '-'))
    lines.append('')
    lines.append('区间容量按窗口内同名动作求和：跑 `trend --days 7` 与 `--days 14` 对比同一动作的容量，'
                 '就是渐进超负荷的量化视角（自重动作不计容量）。')
    return '\n'.join(lines)


def cmd_trend(args):
    dates = [d for d in record_dates() if d <= args.end][-args.days:]
    if not dates:
        out('没有可统计的记录。')
        return 1
    days = [load_day(d) for d in dates]
    weights, legacy_days, pm_only = {}, [], []
    for day in days:
        weight, basis = trend_weight(day)
        _, pm, _ = day_weights(day)
        if weight:
            weights[day['date']] = weight
            if basis == 'legacy':
                legacy_days.append(day['date'])
        elif plausible_weight(pm):
            pm_only.append(day['date'])
    lines = ['| 日期 | 晨重(kg) | 睡前(kg) | 夜间净流失 | %d日均线 | 热量 | 蛋白(g) | 脂肪(g) | 碳水(g) | 训练(min) | 组数 |'
             % args.window,
             '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |']
    for day in days:
        train = day['training']
        am, pm, legacy = day_weights(day)
        shown, basis = trend_weight(day)
        if not plausible_weight(pm):
            pm = None
        overnight = None
        if plausible_weight(am):
            prev = (dt.date.fromisoformat(day['date']) - dt.timedelta(days=1)).isoformat()
            prev_day = load_day(prev)
            if prev_day:
                _, prev_pm, _ = day_weights(prev_day)
                if plausible_weight(prev_pm):
                    overnight = am - prev_pm
        lines.append('| %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |' % (
            day['date'],
            ('%s*' % fmt(shown)) if basis == 'legacy' else fmt(shown),
            fmt(pm), fmt_signed(overnight),
            fmt(moving_average(weights, day['date'], args.window)),
            fmt(day['intake']['kcal']), fmt(day['intake']['protein']),
            fmt(day['intake']['fat']), fmt(day['intake']['carb']),
            fmt(train['minutes']) if train['minutes'] else '-', train['sets'] or '-'))
    out('\n'.join(lines))
    notes = []
    if legacy_days:
        notes.append('- 带 `*` 的是旧字段 `weight_kg`（没有晨重的历史记录，口径不明），只作兜底。')
    if pm_only:
        notes.append('- 只有睡前体重的日期（%s）：不进入均线与 TDEE，需要补晨重。'
                     % '、'.join(pm_only))
    if notes:
        out('')
        out('\n'.join(notes))
    out('')
    out(trend_summary(dates, days, weights, load_targets()))
    out('')
    out(training_detail(days))
    return 0


def trend_summary(dates, days, weights, targets):
    lines = ['**区间小结**（%s ~ %s，%d 天）' % (dates[0], dates[-1], len(dates))]
    ordered = [weights[d] for d in dates if d in weights]
    if len(ordered) >= 2:
        change = ordered[-1] - ordered[0]
        span_days = (dt.date.fromisoformat(max(d for d in dates if d in weights))
                     - dt.date.fromisoformat(min(d for d in dates if d in weights))).days or 1
        per_week = change / span_days * 7
        lines.append('- 体重：%s → %s kg（%s，周均 %s kg，%s%% 体重/周）'
                     % (fmt(ordered[0]), fmt(ordered[-1]), fmt_signed(change),
                        fmt_signed(per_week), fmt(per_week / ordered[0] * 100)))
        last = moving_average(weights, max(weights), 7)
        if last:
            lines.append('- 最新 %d 日均线：%s kg' % (7, fmt(last)))
    else:
        lines.append('- 体重：数据不足（至少需要 2 天有体重记录）')
    intake_days = [d for d in days if d['rows']]
    if intake_days:
        avg_kcal = sum(d['intake']['kcal'] for d in intake_days) / len(intake_days)
        avg_protein = sum(d['intake']['protein'] for d in intake_days) / len(intake_days)
        lines.append('- 摄入：平均 %s kcal / %s g 蛋白（%d 天有记录）'
                     % (fmt(avg_kcal), fmt(avg_protein), len(intake_days)))
        kcal_target = num(targets.get('kcal_target'))
        if kcal_target:
            hit = sum(1 for d in intake_days if abs(d['intake']['kcal'] - kcal_target) <= kcal_target * 0.1)
            lines.append('- 热量达标（±10%%）：%d/%d 天' % (hit, len(intake_days)))
        protein_target = num(targets.get('protein_target_g'))
        if protein_target:
            hit = sum(1 for d in intake_days if d['intake']['protein'] >= protein_target * 0.9)
            lines.append('- 蛋白达标：%d/%d 天' % (hit, len(intake_days)))
    train_days = [d for d in days if d['training']['rows']]
    if train_days:
        total_minutes = sum(d['training']['minutes'] for d in train_days)
        total_sets = sum(d['training']['sets'] for d in train_days)
        total_load = sum(d['training']['load'] for d in train_days)
        extras = ' · 合计 %d 组' % total_sets
        if total_load:
            extras += ' · 容量负荷 %s kg' % fmt(total_load)
        weeks = (len(dates) / 7.0) if len(dates) >= 7 else None
        if weeks:
            lines.append('- 训练：%d 天 · 合计 %s 分钟%s · 周均 %.1f 次'
                         % (len(train_days), fmt(total_minutes), extras,
                            len(train_days) / weeks))
        else:
            lines.append('- 训练：%d 天 · 合计 %s 分钟%s（区间不足 7 天，不外推周均）'
                         % (len(train_days), fmt(total_minutes), extras))
        muscles, muscle_load = {}, {}
        for day in train_days:
            for name, sets in day['training']['muscles'].items():
                muscles[name] = muscles.get(name, 0) + sets
            for name, load in day['training']['muscle_load'].items():
                muscle_load[name] = muscle_load.get(name, 0.0) + load
        if muscles:
            def load_suffix(name):
                load = muscle_load.get(name)
                return '（容量 %s kg）' % fmt(load) if load else ''

            ranked = sorted(muscles.items(), key=lambda kv: -kv[1])
            if weeks:
                lines.append('- 各肌群组数：%s'
                             % '、'.join('%s %.1f 组/周%s' % (k, v / weeks, load_suffix(k))
                                         for k, v in ranked))
                floor = num(targets.get('weekly_sets_per_muscle'))
                if floor:
                    low = [k for k, v in muscles.items() if v / weeks < floor]
                    if low:
                        lines.append('- 低于每周有效组数下限（%s 组）：%s' % (fmt(floor), '、'.join(low)))
            else:
                lines.append('- 各肌群组数（区间合计）：%s'
                             % '、'.join('%s %d 组%s' % (k, v, load_suffix(k))
                                         for k, v in ranked))
    else:
        lines.append('- 训练：区间内无记录')
    return '\n'.join(lines)


def cmd_tdee(args):
    dates = [d for d in record_dates() if d <= args.end][-args.days:]
    points = []
    base = None
    basis_days = {'am': 0, 'legacy': 0}
    for date in dates:
        day = load_day(date)
        weight, basis = trend_weight(day)
        if not day['rows'] or weight is None or day['intake']['kcal'] <= 0:
            continue
        basis_days[basis] += 1
        current = dt.date.fromisoformat(date)
        if base is None:
            base = current
        points.append(((current - base).days, weight, day['intake']['kcal']))
    if len(points) < args.min_points:
        out('有效数据不足：需要至少 %d 天同时有体重和饮食记录，当前 %d 天。' % (args.min_points, len(points)))
        return 1
    span = points[-1][0] - points[0][0]
    if span < 10:
        out('时间跨度只有 %d 天，反推结果不可靠，建议至少 14 天。' % span)
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    mean_x = sum(xs) / len(xs)
    mean_y = sum(ys) / len(ys)
    var = sum((x - mean_x) ** 2 for x in xs)
    least_squares = (sum((p[0] - mean_x) * (p[1] - mean_y) for p in points) / var) if var else 0.0
    slope = theil_sen(xs, ys)
    if slope is None:
        out('体重数据不足以估计斜率。')
        return 1
    mean_intake = sum(p[2] for p in points) / len(points)
    balance = slope * KCAL_PER_KG
    tdee = mean_intake - balance
    targets = load_targets()
    rate = num(targets.get('target_rate_kg_per_week'))
    lines = ['| 指标 | 数值 |', '| --- | ---: |',
             '| 样本 | %d 天（跨度 %d 天） |' % (len(points), span),
             '| 体重口径 | 晨重 %d 天%s |' % (
                 basis_days['am'],
                 '，旧字段 weight_kg %d 天' % basis_days['legacy'] if basis_days['legacy'] else ''),
             '| 平均摄入 | %s kcal |' % fmt(mean_intake),
             '| 体重斜率（稳健） | %.3f kg/天 |' % slope,
             '| 体重斜率（最小二乘，仅参考） | %.3f kg/天 |' % least_squares,
             '| 每日能量差 | %s kcal |' % fmt_signed(balance),
             '| 实测 TDEE | %s kcal |' % fmt(tdee)]
    if rate:
        suggested = tdee + rate * KCAL_PER_KG / 7
        lines.append('| 目标速率 %s kg/周 对应热量 | %s kcal |' % (fmt(rate), fmt(suggested)))
    out('\n'.join(lines))
    out('')
    out('估算 TDEE 建议取 50 的整数倍（%s kcal），并由 fatloss-review 回写 targets.md。' % fmt(round(tdee / 50) * 50))
    out('注意：水分与糖原波动、记录漏记、体脂秤误差都会污染该估算；只作为调整方向的依据。')
    return 0


def cmd_lookup(args):
    if not os.path.isfile(FOODS_CSV):
        out('缺少 data/foods.csv')
        return 1
    with open(FOODS_CSV, 'r', encoding='utf-8-sig') as handle:
        rows = [r for r in csv.DictReader(handle)
                if not args.query or args.query.lower() in r['name'].lower()]
    if not rows:
        out('未找到「%s」。可直接在 data/foods.csv 补一行（每 100g/100ml 可食部数值）。' % args.query)
        return 1
    scale = (args.g / 100.0) if args.g else 1.0
    label = ('%.0f g/ml' % args.g) if args.g else '每 100 g/ml'
    out('| 食材 | %s | 热量 | 蛋白 | 脂肪 | 碳水 | 纤维 | 钠 |' % label)
    out('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |')
    for row in rows[:args.limit]:
        def scaled(key):
            value = num(row.get(key))
            return fmt(value * scale) if value is not None else '-'
        out('| %s | %s | %s kcal | %s g | %s g | %s g | %s g | %s mg |'
            % (row['name'], row['unit'], scaled('kcal'), scaled('protein_g'),
               scaled('fat_g'), scaled('carb_g'), scaled('fiber_g'), scaled('sodium_mg')))
    if len(rows) > args.limit:
        out('')
        out('（共 %d 条匹配，只显示前 %d 条）' % (len(rows), args.limit))
    return 0


def cmd_week(args):
    date = args.date or today()
    day = dt.date.fromisoformat(date)
    start, end = week_bounds(day)
    week = iso_week(day)
    out('%s  ->  %s ~ %s' % (week, start.isoformat(), end.isoformat()))
    plan = os.path.join(PLANS_DIR, week + '.md')
    out('计划文件：%s' % ('plans/%s.md 已存在' % week if os.path.isfile(plan)
                          else 'plans/%s.md 缺失' % week))
    return 0


def classify_goal(text):
    value = text or ''
    if '减脂' in value and '增肌' in value:
        return '重组', -0.10
    if '减脂' in value:
        return '减脂', -0.15
    if '增肌' in value:
        return '增肌', 0.10
    return '维持', 0.0


def activity_factor(days):
    if days <= 0:
        return 1.2, '久坐'
    if days <= 2:
        return 1.375, '轻度（每周 1-2 练）'
    if days <= 4:
        return 1.55, '中度（每周 3-4 练）'
    if days <= 6:
        return 1.725, '活跃（每周 5-6 练）'
    return 1.9, '非常活跃（每周 7 练）'


def set_front_matter(path, values):
    """只替换 front-matter 里同名键的值，保留注释与键顺序。"""
    text = read_text(path)
    match = FM_RE.match(text)
    if not match:
        return False
    lines = match.group(1).splitlines()
    for i, line in enumerate(lines):
        stripped = line.strip()
        if not stripped or stripped.startswith('#') or ':' not in stripped:
            continue
        key = stripped.split(':', 1)[0].strip()
        if key in values:
            lines[i] = '%s: %s' % (key, values[key])
    write_text(path, '---\n' + '\n'.join(lines) + '\n---\n' + text[match.end():])
    return True


def cmd_init(args):
    profile, _ = parse_front_matter(read_text(PROFILE_MD)) if os.path.isfile(PROFILE_MD) else ({}, '')
    missing = [k for k in ('sex', 'age', 'height_cm') if not profile.get(k)]
    weight = None
    weight_from = ''
    for date in reversed(record_dates()):
        day = load_day(date)
        value = num(day['front'].get('weight_kg')) if day else None
        if plausible_weight(value):
            weight, weight_from = value, '最近记录 %s' % date
            break
    if weight is None:
        value = num(profile.get('weight_kg'))
        if plausible_weight(value):
            weight, weight_from = value, 'profile.md'
    if missing or weight is None:
        out('首次校准前需要补齐 profile.md：')
        if missing:
            out('- 缺少字段：%s' % '、'.join(missing))
        if weight is None:
            out('- 缺少体重：填 profile.md 的 weight_kg，或先记录一天体重')
        return 1
    raw_sex = (profile.get('sex') or '').strip().lower()
    if raw_sex.startswith('m') or '男' in raw_sex:
        is_male = True
    elif raw_sex.startswith('f') or '女' in raw_sex:
        is_male = False
    else:
        out('profile.md 的 sex 无法识别：%s（填 male/female 或 男/女）' % profile.get('sex'))
        return 1
    age = num(profile.get('age'))
    height = num(profile.get('height_cm'))
    bmr = 10 * weight + 6.25 * height - 5 * age + (5 if is_male else -161)
    targets = load_targets()
    days = num(targets.get('weekly_training_days'))
    if not days:
        level = profile.get('training_level') or ''
        days = 3 if '新' in level else 5 if '高' in level else 4
    factor, factor_label = activity_factor(days)
    tdee = bmr * factor
    phase, adjust = classify_goal(profile.get('goal'))
    kcal_target = round(tdee * (1 + adjust) / 10) * 10
    protein_factor = 2.0 if phase in ('减脂', '重组') else 1.8 if phase == '增肌' else 1.6
    protein = round(protein_factor * weight)
    fat = round(0.8 * weight)
    carb = round((kcal_target - protein * 4 - fat * 9) / 4 / 5) * 5
    rate = (kcal_target - tdee) * 7 / KCAL_PER_KG
    level = profile.get('training_level') or ''
    sets = 18 if '高' in level else 10 if '新' in level else 14
    lines = ['| 项目 | 数值 | 说明 |', '| --- | ---: | --- |',
             '| 基础代谢 BMR | %s kcal | Mifflin-St Jeor |' % fmt(bmr),
             '| 活动系数 | %s | %s，每周 %s 练 |' % (factor, factor_label, fmt(days)),
             '| TDEE | %s kcal | BMR x 活动系数 |' % fmt(tdee),
             '| 阶段 | %s | 热量调整 %s |' % (phase, fmt_signed(adjust * 100) + '%'),
             '| 热量目标 | %s kcal | |' % fmt(kcal_target),
             '| 蛋白质 | %s g | %.1f g/kg |' % (fmt(protein), protein_factor),
             '| 脂肪 | %s g | 0.8 g/kg |' % fmt(fat),
             '| 碳水 | %s g | 剩余热量 |' % fmt(carb),
             '| 目标速率 | %.2f kg/周 | 由热量调整反推，%s |' % (rate, weight_from)]
    out('\n'.join(lines))
    if carb < weight * 1.5:
        out('')
        out('注意：碳水偏低（%.1f g/kg），热量目标或蛋白目标可能需要重新权衡。' % (carb / weight))
    values = {
        'tdee_kcal': int(round(tdee)),
        'kcal_target': int(kcal_target),
        'protein_target_g': int(protein),
        'fat_target_g': int(fat),
        'carb_target_g': int(carb),
        'weekly_training_days': int(days),
        'weekly_sets_per_muscle': sets,
        'target_rate_kg_per_week': round(rate, 2),
        'last_calibrated': today(),
    }
    out('')
    if args.write:
        if set_front_matter(TARGETS_MD, values):
            out('已写入 targets.md 的 front-matter：%s'
                % '、'.join('%s=%s' % (k, v) for k, v in values.items()))
            out('这是首次估算，请按 2-4 周的实际体重变化用 tdee 命令重新校准。')
        else:
            out('targets.md 缺少 front-matter，未写入。')
            return 1
    else:
        out('把下面这些值填进 targets.md 的 front-matter（或加 --write 自动写入）：')
        out('')
        for key, value in values.items():
            out('%s: %s' % (key, value))
    return 0


def cmd_check(args):
    dates = record_dates() if args.all else [args.date or today()]
    if not dates:
        out('没有记录文件。')
        return 1
    errors = 0
    warnings = 0
    for date in dates:
        day = load_day(date)
        if day is None:
            out('%s: 文件不存在' % date)
            errors += 1
            continue
        issues = []
        if not day['front']:
            issues.append('缺少 front-matter')
        elif day['front'].get('date') != date:
            issues.append('front-matter 的 date 与文件名不一致')
        for key, low, high in (('weight_kg', WEIGHT_MIN, WEIGHT_MAX),
                               (WEIGHT_AM, WEIGHT_MIN, WEIGHT_MAX),
                               (WEIGHT_PM, WEIGHT_MIN, WEIGHT_MAX),
                               ('sleep_hours', 0, 24),
                               ('energy', 1, 5),
                               ('soreness', 1, 5),
                               ('water_ml', 0, 10000)):
            raw = day['front'].get(key, '')
            if not raw:
                continue
            value = strict_num(raw)
            if value is None:
                issues.append('front-matter %s 不是纯数字：%s' % (key, raw))
            elif not low <= value <= high:
                issues.append('front-matter %s 超出合理范围 %s-%s：%s'
                              % (key, fmt(low), fmt(high), fmt(value)))
        am, pm, _ = day_weights(day)
        if (plausible_weight(am) and plausible_weight(pm) and abs(pm - am) > 3):
            warnings += 1
            out('%s: 晨重 %s 与睡前 %s 相差 %s kg，检查单位或输入'
                % (date, fmt(am), fmt(pm), fmt(abs(pm - am))))
        inc_table, trn_table = day['inc_table'], day['trn_table']
        if inc_table is None:
            issues.append('缺少「摄入」表')
        else:
            for token in ('餐次', '食材', '份量', '热量', '蛋白', '脂肪', '碳水'):
                if col(inc_table['headers'], token) is None:
                    issues.append('摄入表缺少列：%s' % token)
            index = {key: col(inc_table['headers'], token) for key, token in INC_COLS}
            meal_col = col(inc_table['headers'], '餐次')
            food_col = col(inc_table['headers'], '食材')
            for i, row in enumerate(inc_table['rows'], 1):
                meal = cell(row, meal_col).strip()
                if not meal:
                    issues.append('摄入第 %d 行缺少餐次' % i)
                elif meal not in MEALS:
                    issues.append('摄入第 %d 行餐次不在 %s 内：%s' % (i, '/'.join(MEALS), meal))
                if not cell(row, food_col).strip():
                    issues.append('摄入第 %d 行缺少食材名' % i)
                for key, i_col in index.items():
                    raw = cell(row, i_col).strip()
                    if raw and num(raw) is None:
                        issues.append('摄入第 %d 行 %s 不是数字：%s' % (i, key, raw))
                kcal_value = num(cell(row, index['kcal']))
                if kcal_value is not None and kcal_value > 3000:
                    warnings += 1
                    out('%s: 摄入第 %d 行热量 %s kcal 异常偏大，检查份量或单位'
                        % (date, i, fmt(kcal_value)))
        if trn_table is None:
            issues.append('缺少「训练」表')
        else:
            index = {key: col(trn_table['headers'], token) for key, token in TRAIN_COLS}
            for i, row in enumerate(trn_table['rows'], 1):
                rpe = num(cell(row, index['rpe']))
                if rpe is not None and not 1 <= rpe <= 10:
                    issues.append('训练第 %d 行 RPE 超出 1-10：%s' % (i, fmt(rpe)))
                if not cell(row, index['muscles']).strip():
                    issues.append('训练第 %d 行缺少目标肌群' % i)
                raw_sets = cell(row, index['volume']).strip()
                if raw_sets and not SETS_RE.match(raw_sets):
                    warnings += 1
                    out('%s: 训练第 %d 行组次重量「%s」不符合 组x次x重量，按 1 组统计' % (date, i, raw_sets))
        if issues:
            errors += len(issues)
            for issue in issues:
                out('%s: %s' % (date, issue))
        else:
            out('%s: OK' % date)
    out('')
    out('检查完成：%d 个文件，%d 个问题，%d 个警告。' % (len(dates), errors, warnings))
    return 1 if errors else 0


def build_parser():
    parser = argparse.ArgumentParser(description='减脂增肌工作区统计工具')
    sub = parser.add_subparsers(dest='command')

    p = sub.add_parser('init', help='首次估算热量与宏量目标，并写入 targets.md')
    p.add_argument('--write', action='store_true', help='直接写入 targets.md 的 front-matter')
    p.set_defaults(func=cmd_init)

    p = sub.add_parser('new', help='从模板创建当日记录文件（幂等）')
    p.add_argument('--date', help='YYYY-MM-DD，默认今天')
    p.add_argument('--force', action='store_true', help='覆盖已存在的文件')
    p.set_defaults(func=cmd_new)

    p = sub.add_parser('totals', help='汇总某日摄入与训练并对比目标')
    p.add_argument('date', nargs='?', default=None)
    p.add_argument('--write', action='store_true', help='把汇总写回记录的 AUTO:SUMMARY 区块')
    p.set_defaults(func=cmd_totals)

    p = sub.add_parser('trend', help='最近 n 日趋势与达标率')
    p.add_argument('--days', type=int, default=14)
    p.add_argument('--window', type=int, default=7, help='体重均线窗口天数')
    p.add_argument('--end', default=today())
    p.set_defaults(func=cmd_trend)

    p = sub.add_parser('tdee', help='由摄入与体重变化反推 TDEE')
    p.add_argument('--days', type=int, default=28)
    p.add_argument('--min-points', type=int, default=7)
    p.add_argument('--end', default=today())
    p.set_defaults(func=cmd_tdee)

    p = sub.add_parser('lookup', help='查询食材营养库')
    p.add_argument('query', nargs='?', default='')
    p.add_argument('--g', type=float, help='按指定克数换算')
    p.add_argument('--limit', type=int, default=8)
    p.set_defaults(func=cmd_lookup)

    p = sub.add_parser('check', help='校验记录文件格式')
    p.add_argument('date', nargs='?', default=None)
    p.add_argument('--all', action='store_true')
    p.set_defaults(func=cmd_check)

    p = sub.add_parser('week', help='查看某日期所属周与计划文件状态')
    p.add_argument('date', nargs='?', default=None)
    p.set_defaults(func=cmd_week)
    return parser


def main():
    parser = build_parser()
    args = parser.parse_args()
    if not getattr(args, 'func', None):
        parser.print_help()
        return 0
    return args.func(args) or 0


if __name__ == '__main__':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass
    sys.exit(main())
