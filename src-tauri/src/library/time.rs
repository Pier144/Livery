//! RFC 3339 UTC timestamps without a date crate: the civil-date conversion is Howard Hinnant's
//! `civil_from_days` (proleptic Gregorian calendar, exact for every day in years 0000–9999).

use std::time::{SystemTime, UNIX_EPOCH};

/// 0000-01-01T00:00:00Z and 9999-12-31T23:59:59Z: RFC 3339 years have exactly four digits.
const MIN_SECS: i64 = -62_167_219_200;
const MAX_SECS: i64 = 253_402_300_799;

/// `t` as `YYYY-MM-DDTHH:MM:SSZ` (whole seconds, rounded down).
pub fn rfc3339_utc(t: SystemTime) -> String {
    format_unix_secs(unix_secs(t))
}

/// Whole seconds since the Unix epoch, rounded towards the past on both sides of it.
pub fn unix_secs(t: SystemTime) -> i64 {
    match t.duration_since(UNIX_EPOCH) {
        Ok(d) => i64::try_from(d.as_secs()).unwrap_or(i64::MAX),
        // Before 1970: round towards the past so the fraction never pushes the time forward.
        Err(e) => {
            let d = e.duration();
            let whole = i64::try_from(d.as_secs()).unwrap_or(i64::MAX);
            -whole.saturating_add(i64::from(d.subsec_nanos() > 0))
        }
    }
}

/// Seconds since the Unix epoch of an RFC 3339 timestamp: `YYYY-MM-DDTHH:MM:SS`, an optional
/// fraction (dropped), then `Z` or a `±HH:MM` offset. `None` when it isn't one.
pub fn parse_rfc3339(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    let separators = b.len() >= 20
        && b[4] == b'-'
        && b[7] == b'-'
        && matches!(b[10], b'T' | b't' | b' ')
        && b[13] == b':'
        && b[16] == b':';
    if !separators || !s.is_char_boundary(19) {
        return None;
    }
    let num = |from: usize, to: usize| s.get(from..to).and_then(num_of);
    let (year, month, day) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (hour, minute, second) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    if !(1..=12).contains(&month) || day < 1 || day > month_len(year, month) || hour > 23 || minute > 59 || second > 60
    {
        return None;
    }
    let mut rest = &s[19..];
    if let Some(fraction) = rest.strip_prefix('.') {
        let digits = fraction.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return None;
        }
        rest = &fraction[digits..];
    }
    let offset = match rest.as_bytes() {
        [b'Z' | b'z'] => 0,
        [sign @ (b'+' | b'-'), _, _, b':', _, _] => {
            let (h, m) = (rest.get(1..3).and_then(num_of)?, rest.get(4..6).and_then(num_of)?);
            if h > 23 || m > 59 {
                return None;
            }
            let secs = h * 3600 + m * 60;
            if *sign == b'+' {
                secs
            } else {
                -secs
            }
        }
        _ => return None,
    };
    let days = days_from_civil(year, month as u32, day as u32);
    Some(days * 86_400 + hour * 3600 + minute * 60 + second - offset)
}

/// A run of ASCII digits (no sign, no spaces) as a number.
fn num_of(part: &str) -> Option<i64> {
    if part.is_empty() || !part.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    part.parse().ok()
}

fn month_len(year: i64, month: i64) -> i64 {
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    match month {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Hinnant's `days_from_civil`).
pub fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400); // 0..=399
    let m = i64::from(month);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + i64::from(day) - 1; // 0..=365
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // 0..=146_096
    era * 146_097 + doe - 719_468
}

/// The current time as RFC 3339 UTC.
pub fn now_rfc3339() -> String {
    rfc3339_utc(SystemTime::now())
}

/// Seconds since the Unix epoch as RFC 3339 UTC, clamped to years 0000–9999.
pub fn format_unix_secs(secs: i64) -> String {
    let secs = secs.clamp(MIN_SECS, MAX_SECS);
    let days = secs.div_euclid(86_400);
    let of_day = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z", of_day / 3600, of_day % 3600 / 60, of_day % 60)
}

/// (year, month 1–12, day 1–31) for a count of days since 1970-01-01.
pub fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097); // day of era, 0..=146_096
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // year of era, 0..=399
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // day of year from March 1st, 0..=365
    let mp = (5 * doy + 2) / 153; // month from March, 0..=11
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    // Both are small and positive by construction.
    (year, month as u32, day as u32)
}
