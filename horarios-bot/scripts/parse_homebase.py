#!/usr/bin/env python3
"""
Parse a Homebase Schedule Builder PDF (Save-as-PDF from Chrome) into a JSON
compatible with /horario-import.

Usage: python3 parse_homebase.py <pdf_file> <year>

Outputs JSON to stdout. The year arg disambiguates dates near month boundaries
(the calendar shows neighboring-month days at the start/end).
"""
import sys
import re
import json
import pdfplumber
from collections import defaultdict
from datetime import date

# Hardcoded mapping: agent name (as appears in PDF) -> planner_id (per handoff)
NAME_TO_PID = {
    'Moisés Cardona': 1,
    'Karol Cabrera': 2,
    'Alejandra Henao': 3,
    'Johan Muñoz': 4,
    'Nuviangi Ramirez': 5,
    'Jerónimo García': 6,
    'Laura Zambrano': 7,
    'Esteban Santa': 8,
    'Alixander Maldonado': 9,
    'Michael Cano': 10,
    'Nelly Riera': 11,
    'Rosana Gomez': 12,
    'Maribel Hernandez': 13,
    'Juan Carlos Tamayo': 14,
    'Maria Velarde M': 15,
    'William Vega': 16,
    'Cindy Benitez': 17,
}

# Column x-ranges for Mon..Sun (left edges + width)
COL_LEFT = [46, 214, 380, 547, 713, 878, 1044]
COL_WIDTH = 165  # approximate

# Time range -> (dept, shift_id)
TIME_TO_SHIFT = {
    ('12am', '8am'):  ('L1', 'M'),
    ('8am',  '4pm'):  ('L1', 'T'),
    ('12pm', '8pm'):  ('L1', 'E'),
    ('4pm',  '12am'): ('L1', 'N'),
    ('3am',  '11am'): ('L2', 'M'),
    ('11am', '7pm'):  ('L2', 'T'),
    ('3pm',  '11pm'): ('L2', 'E'),
    ('7pm',  '3am'):  ('L2', 'N'),
}

# Hour map for time strings
def parse_hour(s):
    """Convert '12am' -> 0, '8am' -> 8, '12pm' -> 12, '4pm' -> 16, '3am' next day -> 27 etc."""
    m = re.match(r'^(\d+)(am|pm)$', s)
    if not m:
        return None
    h = int(m.group(1))
    ap = m.group(2)
    if ap == 'am':
        return 0 if h == 12 else h
    else:
        return 12 if h == 12 else h + 12


MONTH_NAMES = {
    'Jan': 1, 'Feb': 2, 'Mar': 3, 'Apr': 4, 'May': 5, 'Jun': 6,
    'Jul': 7, 'Aug': 8, 'Sep': 9, 'Oct': 10, 'Nov': 11, 'Dec': 12,
}


def col_for_x(x):
    """Given x coordinate, return column index 0..6 (Mon..Sun) or None if outside."""
    for i in range(6, -1, -1):
        if x >= COL_LEFT[i] - 8:
            return i
    return 0


def group_words_to_lines(words, y_tolerance=3):
    """Group words by similar y, return [(y_avg, [words])] sorted by y."""
    lines = []
    sorted_words = sorted(words, key=lambda w: (w['top'], w['x0']))
    current = []
    current_y = None
    for w in sorted_words:
        if current_y is None or abs(w['top'] - current_y) <= y_tolerance:
            current.append(w)
            current_y = w['top'] if current_y is None else (current_y + w['top']) / 2
        else:
            lines.append((current_y, sorted(current, key=lambda x: x['x0'])))
            current = [w]
            current_y = w['top']
    if current:
        lines.append((current_y, sorted(current, key=lambda x: x['x0'])))
    return lines


def line_text_by_col(line_words):
    """Split a line's words into 7 column buckets, each as a string."""
    buckets = ['', '', '', '', '', '', '']
    for w in line_words:
        c = col_for_x(w['x0'])
        if c is None:
            continue
        buckets[c] = (buckets[c] + ' ' + w['text']).strip()
    return buckets


def extract_all_pages(pdf_path):
    """Return list of (page_idx, line_y_global, [(col, text)]). y_global is per-page y + page offset."""
    with pdfplumber.open(pdf_path) as pdf:
        all_lines = []
        for pi, page in enumerate(pdf.pages):
            words = page.extract_words()
            lines = group_words_to_lines(words)
            for y, lw in lines:
                buckets = line_text_by_col(lw)
                all_lines.append((pi, y, buckets))
        return all_lines


def get_target_month(pdf_path):
    """Read the page-1 title 'April 2026' / 'May 2026' etc. Returns (year, month)."""
    with pdfplumber.open(pdf_path) as pdf:
        words = pdf.pages[0].extract_words()
        # First two words at top of page should be month and year
        top_words = sorted(words, key=lambda w: w['top'])[:5]
        for w in top_words:
            t = w['text']
            if t in MONTH_NAMES_FULL:
                month = MONTH_NAMES_FULL[t]
                # Find year nearby
                for w2 in top_words:
                    if re.match(r'^\d{4}$', w2['text']):
                        return int(w2['text']), month
        return None, None


MONTH_NAMES_FULL = {
    'January': 1, 'February': 2, 'March': 3, 'April': 4, 'May': 5, 'June': 6,
    'July': 7, 'August': 8, 'September': 9, 'October': 10, 'November': 11, 'December': 12,
}


def parse_calendar(pdf_path, year):
    """
    Parse the calendar PDF. Returns (entries, days_off).

    Strategy:
    1. Extract all lines per page with column buckets.
    2. Identify "date header rows" — rows where multiple columns contain just
       a number (or "Mon Apr 1" etc). These mark the start of a week-row.
    3. For each week-row, accumulate cell content per column until next week-row.
    4. Parse each cell into entries.
    """
    all_lines = extract_all_pages(pdf_path)

    # Drop the very first line of each page if it's the month header / day-name header
    # Detect headers: lines with day-name words (Mon, Tue, ...).
    DAY_NAMES = {'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'}

    # Find date-header rows. Pattern per column: optional month name + day number.
    # E.g., "30", "31", "Apr 1", "2", "3", "4", "5"
    def is_date_header(buckets):
        nonempty = [b for b in buckets if b.strip()]
        if len(nonempty) < 4:
            return False
        # Each non-empty bucket should match: optional month + integer
        for b in buckets:
            b = b.strip()
            if not b:
                continue
            # Match like "30", "Apr 1", "May 1"
            if not re.match(r'^([A-Z][a-z]{2}\s)?\d{1,2}$', b):
                return False
        return True

    from datetime import timedelta

    # Determine target month from PDF title
    target_year, target_month = get_target_month(pdf_path)
    if target_year is None:
        target_year, target_month = year, 4  # fallback

    # PASS 1: collect all date header rows as (week_idx, col_buckets).
    # Then find pivot: any column with explicit "MonName X" — compute its date,
    # and derive every other (week_idx, col) date by offset.

    date_rows = []  # list of (line_idx, col_buckets[7])
    # Walk lines, identifying date header rows
    for idx, (pi, y, buckets) in enumerate(all_lines):
        # Skip month/year header
        if any(re.match(r'^(January|February|March|April|May|June|July|August|September|October|November|December)$', b.strip()) for b in buckets):
            continue
        # Skip day-name header
        if any(b.strip() in DAY_NAMES for b in buckets):
            continue
        if is_date_header(buckets):
            date_rows.append((idx, buckets))

    # Find pivot
    pivot_date = None
    pivot_week = None
    pivot_col = None
    for week_idx, (line_idx, buckets) in enumerate(date_rows):
        for col, b in enumerate(buckets):
            m = re.match(r'^([A-Z][a-z]{2})\s+(\d{1,2})$', b.strip())
            if m:
                month = MONTH_NAMES[m.group(1)]
                day = int(m.group(2))
                # Determine year: target_year ± 1 if month differs greatly
                yr = target_year
                if target_month == 1 and month == 12:
                    yr = target_year - 1
                elif target_month == 12 and month == 1:
                    yr = target_year + 1
                pivot_date = date(yr, month, day)
                pivot_week = week_idx
                pivot_col = col
                break
        if pivot_date:
            break

    if pivot_date is None:
        sys.stderr.write("ERROR: could not find pivot date in PDF\n")
        return [], []

    # Compute date for every (week_idx, col)
    def date_at(week_idx, col):
        delta_days = (week_idx - pivot_week) * 7 + (col - pivot_col)
        return pivot_date + timedelta(days=delta_days)

    # PASS 2: walk lines, identifying date header rows and accumulating cells
    weeks = []  # list of (dates[7], cells_dict)
    week_idx = -1
    current_dates = None
    current_cells = defaultdict(list)

    def commit_week_inner():
        if current_dates is not None:
            weeks.append((current_dates, dict(current_cells)))

    def commit_week():
        if current_dates is not None:
            weeks.append((current_dates, dict(current_cells)))

    for pi, y, buckets in all_lines:
        # Skip month header (very top of page)
        if any(re.match(r'^(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}$', b.strip()) for b in buckets):
            continue
        # Skip day-name header
        if any(b.strip() in DAY_NAMES for b in buckets):
            continue

        if is_date_header(buckets):
            # Commit previous week
            commit_week_inner()
            current_cells = defaultdict(list)
            week_idx += 1

            # Build dates for this row using pivot offset
            current_dates = [date_at(week_idx, col) for col in range(7)]
            continue

            # === unused legacy below (kept to preserve diff context) ===
            current_dates_legacy = [None] * 7
            # Pre-pass: explicit month markers (e.g., "Apr 1", "May 1") set last_month
            for col, b in enumerate(buckets):
                b = b.strip()
                m = re.match(r'^([A-Z][a-z]{2})\s+(\d{1,2})$', b)
                if m:
                    explicit_month = MONTH_NAMES[m.group(1)]
                    explicit_day = int(m.group(2))
                    # Determine year for this column based on prior month/year
                    yr = last_year
                    if last_month is not None:
                        if explicit_month == 1 and last_month == 12:
                            yr = last_year + 1
                    last_month = explicit_month
                    last_year = yr

            # If we still don't know the month after pre-pass, infer from target_month:
            # - If first non-empty col day > 7, it's the previous month (calendar shows preceding days)
            # - Otherwise it's the target month
            if last_month is None:
                first_day = None
                for b in buckets:
                    b = b.strip()
                    m = re.match(r'^(\d{1,2})$', b)
                    if m:
                        first_day = int(m.group(1))
                        break
                if first_day is not None and first_day > 7:
                    # Previous month
                    if target_month == 1:
                        last_month = 12
                        last_year = target_year - 1
                    else:
                        last_month = target_month - 1
                        last_year = target_year
                else:
                    last_month = target_month
                    last_year = target_year

            # Now walk columns left-to-right, computing dates with rollover
            cur_month = last_month
            cur_year = last_year
            # We need to figure out starting month for col 0. If first day in row is large
            # (>7) and target_month is set, col 0 is previous month.
            # If row contains "Apr 1" / similar, that fixes the rollover point.
            for col, b in enumerate(buckets):
                b = b.strip()
                if not b:
                    current_dates[col] = None
                    continue
                m = re.match(r'^([A-Z][a-z]{2})\s+(\d{1,2})$', b)
                if m:
                    cur_month = MONTH_NAMES[m.group(1)]
                    day = int(m.group(2))
                    # Year rollover Dec->Jan
                    if col > 0 and current_dates[col-1] is not None:
                        prev = current_dates[col-1]
                        if cur_month == 1 and prev.month == 12:
                            cur_year = prev.year + 1
                        elif cur_month != prev.month:
                            cur_year = prev.year
                else:
                    m = re.match(r'^(\d{1,2})$', b)
                    if not m:
                        current_dates[col] = None
                        continue
                    day = int(m.group(1))
                    # Detect rollover: if day < prev day, month rolled
                    if col > 0 and current_dates[col-1] is not None:
                        prev = current_dates[col-1]
                        if day < prev.day:
                            if prev.month == 12:
                                cur_month = 1
                                cur_year = prev.year + 1
                            else:
                                cur_month = prev.month + 1
                                cur_year = prev.year

                try:
                    current_dates[col] = date(cur_year, cur_month, day)
                except ValueError:
                    current_dates[col] = None
            # Persist for next row
            last_month = cur_month
            last_year = cur_year
            first_date_row = False
        else:
            # Body line — accumulate per column
            for col, b in enumerate(buckets):
                b = b.strip()
                if b:
                    current_cells[col].append(b)

    commit_week_inner()

    # Now parse each week's cells
    entries = []
    days_off = []

    TIME_RE = re.compile(r'^(\d+(?:am|pm))\s*[-–]\s*(\d+(?:am|pm))$')
    NAME_TAG_RE = re.compile(r'^(.+?)\s+\((L1|L2)\)$')

    for dates, cells in weeks:
        for col in range(7):
            d = dates[col]
            if d is None:
                continue
            lines = cells.get(col, [])
            parse_cell(lines, d, entries, days_off)

    return entries, days_off


def parse_cell(lines, the_date, entries, days_off):
    """
    Parse a single day cell's lines into shift entries and day-off entries.

    Within a cell, content is a sequence of "blocks":
      - Shift block: time-range line + name line + optional annotation lines
      - Day-off block: "Time-off (all day)" + name (no L1/L2 tag)

    Lines may also contain inline pairs like "3am-11am Nelly Riera (L2)" on a
    single line — handle those as one block.
    """
    TIME_RE = re.compile(r'(\d+(?:am|pm))\s*[-–]\s*(\d+(?:am|pm))')
    NAME_TAG_RE = re.compile(r'(.+?)\s+\((L1|L2)\)\s*$')

    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if not line:
            i += 1
            continue

        # Time-off block
        if line.startswith('Time-off (all day)'):
            # Name might be on same line (after "Time-off (all day)") or next line
            rest = line[len('Time-off (all day)'):].strip()
            if rest:
                name = rest
                i += 1
            else:
                if i + 1 >= len(lines):
                    i += 1
                    continue
                name = lines[i+1].strip()
                # Remove (L1)/(L2) tag if present
                m = NAME_TAG_RE.match(name)
                if m:
                    name = m.group(1).strip()
                i += 2
            pid = NAME_TO_PID.get(name)
            if pid:
                days_off.append({
                    'date': the_date.isoformat(),
                    'planner_id': pid,
                    'reason': 'time_off'
                })
            else:
                sys.stderr.write(f"WARN: unknown name in time-off: '{name}' on {the_date}\n")
            continue

        # Try to match a time range at start of line
        time_match = TIME_RE.match(line)
        if not time_match:
            # Annotation lines like "Trade approved" or "Seeking trade" without a preceding shift?
            # Skip and warn.
            if line not in ('Trade approved', 'Seeking trade'):
                sys.stderr.write(f"WARN: unrecognized line on {the_date} col cell: '{line}'\n")
            i += 1
            continue

        start_str = time_match.group(1)
        end_str = time_match.group(2)
        rest = line[time_match.end():].strip()

        # Look for the agent name. Could be on this line (after time) or next line.
        name_text = rest
        if not name_text:
            if i + 1 < len(lines):
                name_text = lines[i+1].strip()
                i += 2
            else:
                i += 1
                continue
        else:
            i += 1

        # Parse name + (L1)/(L2) tag
        m = NAME_TAG_RE.match(name_text)
        if not m:
            sys.stderr.write(f"WARN: missing L1/L2 tag in '{name_text}' on {the_date}\n")
            continue
        name = m.group(1).strip()
        # ignore agent_dept = m.group(2) — we use the time range to determine slot
        pid = NAME_TO_PID.get(name)
        if not pid:
            sys.stderr.write(f"WARN: unknown name '{name}' on {the_date}\n")
            continue

        # Resolve dept/shift_id from time range
        key = (start_str, end_str)
        if key not in TIME_TO_SHIFT:
            # Partial shift — store custom hours
            sh = parse_hour(start_str)
            eh = parse_hour(end_str)
            if sh is None or eh is None:
                sys.stderr.write(f"WARN: bad time range {start_str}-{end_str} on {the_date}\n")
                continue
            # Normalize end < start (overnight) → eh + 24
            if eh <= sh:
                eh += 24
            # Map to closest standard slot for dept assignment
            # Heuristic: pick the L1/L2 slot whose start is closest
            best = None
            for (ss, ee), (dept, sid) in TIME_TO_SHIFT.items():
                ssh = parse_hour(ss)
                if best is None or abs(ssh - sh) < best[0]:
                    eeh = parse_hour(ee)
                    if eeh <= ssh:
                        eeh += 24
                    best = (abs(ssh - sh), dept, sid)
            entry = {
                'date': the_date.isoformat(),
                'planner_id': pid,
                'dept': best[1],
                'shift_id': best[2],
                'custom_start_hour': sh,
                'custom_end_hour': eh,
                'note': f'partial {start_str}-{end_str}'
            }
            entries.append(entry)
        else:
            dept, sid = TIME_TO_SHIFT[key]
            entries.append({
                'date': the_date.isoformat(),
                'planner_id': pid,
                'dept': dept,
                'shift_id': sid,
            })

        # Skip following annotation lines (Trade approved, Seeking trade)
        while i < len(lines) and lines[i].strip() in ('Trade approved', 'Seeking trade'):
            i += 1


def main():
    if len(sys.argv) < 3:
        print("Usage: parse_homebase.py <pdf> <year>", file=sys.stderr)
        sys.exit(1)
    pdf_path = sys.argv[1]
    year = int(sys.argv[2])

    entries, days_off = parse_calendar(pdf_path, year)

    # Range
    all_dates = [e['date'] for e in entries] + [d['date'] for d in days_off]
    if all_dates:
        rng = {'start': min(all_dates), 'end': max(all_dates)}
    else:
        rng = None

    out = {
        'entries': entries,
        'days_off': days_off,
    }
    if rng:
        out['range'] = rng

    print(json.dumps(out, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()
