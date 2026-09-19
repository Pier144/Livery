//! RFC 3339 formatting against known dates (checked with `date -u -d @<secs>`), leap years
//! included.

use livery_lib::library::time::{
    civil_from_days, days_from_civil, format_unix_secs, parse_rfc3339, rfc3339_utc, unix_secs,
};
use std::time::{Duration, UNIX_EPOCH};

#[test]
fn parse_reads_back_what_format_writes() {
    for secs in [0, -1, 951_782_400, 1_789_832_245, 4_107_542_400, 253_402_300_799, -62_167_219_200] {
        assert_eq!(parse_rfc3339(&format_unix_secs(secs)), Some(secs), "{secs}");
    }
    // Every day for a few years, at an odd time of day.
    for day in (-800..800).map(|d| d * 3) {
        let secs = day * 86_400 + 45_296;
        assert_eq!(parse_rfc3339(&format_unix_secs(secs)), Some(secs));
    }
}

#[test]
fn parse_accepts_fractions_and_offsets() {
    let base = 1_789_832_245;
    assert_eq!(parse_rfc3339("2026-09-19T15:37:25.999Z"), Some(base), "the fraction is dropped");
    assert_eq!(parse_rfc3339("2026-09-19t15:37:25z"), Some(base));
    assert_eq!(parse_rfc3339("2026-09-19T17:37:25+02:00"), Some(base));
    assert_eq!(parse_rfc3339("2026-09-19T10:07:25-05:30"), Some(base));
}

#[test]
fn parse_rejects_what_is_not_rfc3339() {
    for bad in [
        "",
        "yesterday",
        "2026-09-19",
        "2026-09-19T15:37:25",
        "2026-13-01T00:00:00Z",
        "2026-02-29T00:00:00Z",
        "2026-04-31T00:00:00Z",
        "2026-09-19T24:00:00Z",
        "2026-09-19T15:60:00Z",
        "2026-09-19T15:37:25.Z",
        "2026-09-19T15:37:25+2:00",
        "2026-09-19T15:37:25+24:00",
        "+026-09-19T15:37:25Z",
        "2026-09-19T15:37:25Zjunk",
        "2026-09-19T15:37:2\u{e9}Z",
    ] {
        assert_eq!(parse_rfc3339(bad), None, "{bad:?}");
    }
    assert_eq!(parse_rfc3339("2024-02-29T00:00:00Z"), Some(1_709_164_800), "leap day");
}

#[test]
fn days_from_civil_inverts_civil_from_days() {
    for days in (-150_000..150_000).step_by(7) {
        let (y, m, d) = civil_from_days(days);
        assert_eq!(days_from_civil(y, m, d), days);
    }
    assert_eq!(unix_secs(UNIX_EPOCH - Duration::from_millis(1)), -1);
}

#[test]
fn known_instants() {
    let cases: [(i64, &str); 9] = [
        (0, "1970-01-01T00:00:00Z"),
        (-1, "1969-12-31T23:59:59Z"),
        (951_782_400, "2000-02-29T00:00:00Z"),   // divisible by 400: leap
        (1_709_164_800, "2024-02-29T00:00:00Z"), // divisible by 4: leap
        (4_107_456_000, "2100-02-28T00:00:00Z"), // divisible by 100: not leap…
        (4_107_542_400, "2100-03-01T00:00:00Z"), // …so March follows Feb 28
        (1_789_832_245, "2026-09-19T15:37:25Z"),
        (253_402_300_799, "9999-12-31T23:59:59Z"),
        (-62_167_219_200, "0000-01-01T00:00:00Z"),
    ];
    for (secs, expected) in cases {
        assert_eq!(format_unix_secs(secs), expected, "{secs}");
    }
}

#[test]
fn out_of_range_is_clamped_to_four_digit_years() {
    assert_eq!(format_unix_secs(i64::MAX), "9999-12-31T23:59:59Z");
    assert_eq!(format_unix_secs(i64::MIN), "0000-01-01T00:00:00Z");
}

#[test]
fn every_day_of_a_leap_cycle_round_trips() {
    // Walk 400 years day by day from 1970 and check the calendar never skips or repeats.
    let (mut year, mut month, mut day) = (1970_i64, 1_u32, 1_u32);
    for days in 0..146_097 {
        assert_eq!(civil_from_days(days), (year, month, day), "day {days}");
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
        let month_len = match month {
            2 if leap => 29,
            2 => 28,
            4 | 6 | 9 | 11 => 30,
            _ => 31,
        };
        day += 1;
        if day > month_len {
            day = 1;
            month += 1;
            if month > 12 {
                month = 1;
                year += 1;
            }
        }
    }
}

#[test]
fn system_time_rounds_down_on_both_sides_of_the_epoch() {
    assert_eq!(rfc3339_utc(UNIX_EPOCH + Duration::from_millis(1_999)), "1970-01-01T00:00:01Z");
    assert_eq!(rfc3339_utc(UNIX_EPOCH - Duration::from_millis(500)), "1969-12-31T23:59:59Z");
    assert_eq!(rfc3339_utc(UNIX_EPOCH - Duration::from_secs(86_400)), "1969-12-31T00:00:00Z");
}
