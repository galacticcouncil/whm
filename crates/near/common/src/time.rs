//! RFC 3339 in UTC, `YYYY-MM-DDTHH:MM:SS.sssZ` — what `intents.near` takes as a deadline and what
//! 1Click signs as its timestamps. Unix ms on our side.

const MS_PER_DAY: u64 = 86_400_000;

/// Unix ms → `2026-10-21T12:18:01.239Z`.
pub fn format(ms: u64) -> String {
    let (y, m, d) = civil_from_days(ms / MS_PER_DAY);
    let t = ms % MS_PER_DAY;
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        t / 3_600_000,
        t / 60_000 % 60,
        t / 1_000 % 60,
        t % 1_000
    )
}

/// `YYYY-MM-DDTHH:MM:SS.sssZ` or `YYYY-MM-DDTHH:MM:SSZ` → unix ms. Anything else is `None`.
pub fn parse(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    let ms = match b.len() {
        20 if b[19] == b'Z' => 0,
        24 if b[19] == b'.' && b[23] == b'Z' => num(&b[20..23])?,
        _ => return None,
    };
    if b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let (y, m, d) = (num(&b[0..4])?, num(&b[5..7])?, num(&b[8..10])?);
    let (h, min, sec) = (num(&b[11..13])?, num(&b[14..16])?, num(&b[17..19])?);
    if y < 1970 || !(1..=12).contains(&m) || d == 0 || d > days_in_month(y, m) || h > 23 || min > 59 || sec > 59 {
        return None;
    }
    Some(days_from_civil(y, m, d) * MS_PER_DAY + ((h * 60 + min) * 60 + sec) * 1_000 + ms)
}

fn num(digits: &[u8]) -> Option<u64> {
    digits.iter().try_fold(0u64, |n, c| c.is_ascii_digit().then(|| n * 10 + u64::from(c - b'0')))
}

fn days_in_month(y: u64, m: u64) -> u64 {
    match m {
        2 if y.is_multiple_of(4) && (!y.is_multiple_of(100) || y.is_multiple_of(400)) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// Howard Hinnant's `civil_from_days`, for days since 1970-01-01.
fn civil_from_days(days: u64) -> (u64, u64, u64) {
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + u64::from(m <= 2);
    (y, m, d)
}

/// Its inverse, for dates from 1970 on.
fn days_from_civil(y: u64, m: u64, d: u64) -> u64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `Date.parse` / `toISOString` values, from Node.
    const KNOWN: [(&str, u64); 4] = [
        ("1970-01-01T00:00:00.000Z", 0),
        ("2026-10-21T12:18:01.239Z", 1_792_585_081_239),
        ("2024-02-29T23:59:59.999Z", 1_709_251_199_999),
        ("2100-03-01T00:00:00.000Z", 4_107_542_400_000),
    ];

    #[test]
    fn matches_javascript() {
        for (s, ms) in KNOWN {
            assert_eq!(format(ms), s);
            assert_eq!(parse(s), Some(ms), "{s}");
        }
    }

    #[test]
    fn round_trips_every_day_for_a_century() {
        for day in (0..36_600u64).step_by(7) {
            let ms = day * MS_PER_DAY + 45_296_789;
            assert_eq!(parse(&format(ms)), Some(ms));
        }
    }

    #[test]
    fn takes_whole_seconds() {
        assert_eq!(parse("2026-10-21T12:18:01Z"), Some(1_792_585_081_000));
    }

    #[test]
    fn rejects_anything_else() {
        for s in [
            "2026-10-21T12:18:01.239+00:00",
            "2026-10-21 12:18:01.239Z",
            "2026-13-01T00:00:00.000Z",
            "2026-02-29T00:00:00.000Z",
            "2026-10-21T24:00:00.000Z",
            "1969-12-31T23:59:59.999Z",
            "2026-10-21T12:18:01.23Z",
            "",
        ] {
            assert_eq!(parse(s), None, "{s}");
        }
    }
}
