//! RFC 3339 UTC timestamps without a date crate: the civil-date conversion is Howard Hinnant's
//! `civil_from_days` (proleptic Gregorian calendar, exact for every day in years 0000–9999).

use std::time::{SystemTime, UNIX_EPOCH};

/// 0000-01-01T00:00:00Z and 9999-12-31T23:59:59Z: RFC 3339 years have exactly four digits.
const MIN_SECS: i64 = -62_167_219_200;
const MAX_SECS: i64 = 253_402_300_799;

/// `t` as `YYYY-MM-DDTHH:MM:SSZ` (whole seconds, rounded down).
pub fn rfc3339_utc(t: SystemTime) -> String {
    let secs = match t.duration_since(UNIX_EPOCH) {
        Ok(d) => i64::try_from(d.as_secs()).unwrap_or(i64::MAX),
        // Before 1970: round towards the past so the fraction never pushes the time forward.
        Err(e) => {
            let d = e.duration();
            let whole = i64::try_from(d.as_secs()).unwrap_or(i64::MAX);
            -whole.saturating_add(i64::from(d.subsec_nanos() > 0))
        }
    };
    format_unix_secs(secs)
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
