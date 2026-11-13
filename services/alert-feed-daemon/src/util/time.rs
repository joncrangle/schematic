use crate::gtfs::TimeRange;
use chrono::{Datelike, NaiveDate};
use chrono_tz::Tz;

pub struct ParsedTime {
    pub hour: u32,
    pub minute: u32,
    pub is_pm: bool,
}

impl ParsedTime {
    pub fn to_24_hour(&self) -> (u32, u32) {
        let mut h = self.hour;
        if self.is_pm && h < 12 {
            h += 12;
        } else if !self.is_pm && h == 12 {
            h = 0;
        }
        if h > 23 {
            h = 23;
        }
        (h, self.minute)
    }
}

/// Prepositions that put the end of a period after them.
///
/// `Extended until Thursday, December 31` names a retirement, not an opening.
/// These are the only spellings real advisory pages use, and `up to` is the one
/// two-word member, matched on its first word.
const TERMINAL_PREPOSITIONS: &[&str] = &["until", "through", "till"];
/// The two-word member of the same class.
const TWO_WORD_TERMINAL_PREPOSITION: [&str; 2] = ["up", "to"];

/// Reads the period a `When` field states.
///
/// An absent or unparseable field yields one empty range rather than the current
/// time, because the caller anchors a missing period to the posting date: a
/// posting that says nothing would otherwise look like it begins today. A field
/// that states only a retirement yields a range with no start for the same
/// reason, leaving the posting date as the honest opening.
pub fn parse_period_lexical(
    when: Option<&str>,
    time_zone: &Tz,
    default_year: i32,
) -> Vec<TimeRange> {
    let text = match when {
        Some(t) if !t.trim().is_empty() => t,
        _ => return vec![TimeRange::default()],
    };

    let dates = extract_dates(text, default_year);
    if dates.is_empty() {
        return vec![TimeRange::default()];
    }

    let times = extract_times(text);

    if states_only_a_retirement(text, default_year) {
        let end_time = times.last();
        return vec![TimeRange {
            start: None,
            end: Some(make_zoned_timestamp(
                dates[0],
                end_time,
                end_time.is_none(),
                time_zone,
            )),
        }];
    }

    let (start_time, end_time) = match (dates.len(), times.len()) {
        (_, 0) => (None, None),
        (1, _) => (times.first(), times.get(1)),
        (_, 1) => (None, times.first()),
        (_, _) => (times.first(), times.last()),
    };

    let start_ts = make_zoned_timestamp(dates[0], start_time, false, time_zone);
    let end_ts = if dates.len() > 1 || end_time.is_some() {
        let end_date = dates[dates.len() - 1];
        Some(make_zoned_timestamp(
            end_date,
            end_time,
            end_time.is_none(),
            time_zone,
        ))
    } else {
        None
    };

    vec![TimeRange {
        start: Some(start_ts),
        end: end_ts,
    }]
}

/// Whether a `When` field states a retirement and no opening.
///
/// The discriminator against `Tuesday September 22, 2026 until further notice` is
/// what, if anything, precedes the terminal preposition. A date there is the
/// start, and so is a clock time, because "from 7 a.m. until 7 p.m. on
/// September 30" opens its own beginning and only then ends. With one date in the
/// field and nothing bounding a beginning ahead of the preposition, the
/// preposition terminates nothing but that date, so the date is the end.
fn states_only_a_retirement(text: &str, default_year: i32) -> bool {
    if extract_dates(text, default_year).len() != 1 {
        return false;
    }
    let tokens = tokenize(text);
    let Some(bound) = index_of_terminal_preposition(&tokens) else {
        return false;
    };
    let opening = tokens[..bound].join(" ");
    extract_dates(&opening, default_year).is_empty() && extract_times(&opening).is_empty()
}

/// The first word that introduces the end of a period, if the field uses one.
fn index_of_terminal_preposition(tokens: &[&str]) -> Option<usize> {
    tokens.iter().enumerate().find_map(|(index, token)| {
        let word = normalized_word(token);
        if TERMINAL_PREPOSITIONS.contains(&word.as_str()) {
            return Some(index);
        }
        let next = tokens.get(index + 1).map(|token| normalized_word(token));
        (word == TWO_WORD_TERMINAL_PREPOSITION[0]
            && next.as_deref() == Some(TWO_WORD_TERMINAL_PREPOSITION[1]))
        .then_some(index)
    })
}

fn normalized_word(token: &str) -> String {
    token
        .trim_matches(|c: char| !c.is_ascii_alphanumeric())
        .to_lowercase()
}

/// Reads every date a line of advisory prose states.
///
/// A month name, or the three-letter abbreviation the newer GHD templates use,
/// followed by a day. The year is the next year-shaped token the text carries;
/// `default_year` covers an operator that writes no year at all, which is what
/// DRT's `When: Wednesday, September 30, …` does. Falling back to the current
/// year instead would have made the two implementations disagree and would have
/// read a bare "September 9" as no period at all.
pub fn extract_dates(text: &str, default_year: i32) -> Vec<NaiveDate> {
    const MONTHS: &[(&str, u32)] = &[
        ("january", 1),
        ("jan", 1),
        ("february", 2),
        ("feb", 2),
        ("march", 3),
        ("mar", 3),
        ("april", 4),
        ("apr", 4),
        ("may", 5),
        ("june", 6),
        ("jun", 6),
        ("july", 7),
        ("jul", 7),
        ("august", 8),
        ("aug", 8),
        ("september", 9),
        ("sep", 9),
        ("october", 10),
        ("oct", 10),
        ("november", 11),
        ("nov", 11),
        ("december", 12),
        ("dec", 12),
    ];

    let tokens = tokenize(text);

    let mut dates = Vec::new();

    for i in 0..tokens.len() {
        let lower = tokens[i].to_lowercase();
        let Some(&(_, month)) = MONTHS.iter().find(|&&(m, _)| m == lower) else {
            continue;
        };
        if i + 1 >= tokens.len() {
            continue;
        }

        let cleaned_day = tokens[i + 1].trim_matches(|c: char| !c.is_ascii_digit());
        let Ok(day) = cleaned_day.parse::<u32>() else {
            continue;
        };

        if (1..=31).contains(&day) {
            let year = (i + 2..tokens.len())
                .find_map(|index| {
                    let cleaned = tokens[index].trim_matches(|c: char| !c.is_ascii_digit());
                    let year: i32 = cleaned.parse().ok()?;
                    (2020..=2050).contains(&year).then_some(year)
                })
                .unwrap_or(default_year);

            if let Some(date) = NaiveDate::from_ymd_opt(year, month, day) {
                dates.push(date);
            }
        }
    }
    dates
}

/// The words of a line, the way the TypeScript decoder tokenizes one before
/// reading dates, so both read the same word at the same position.
fn tokenize(text: &str) -> Vec<&str> {
    text.split(|c: char| c.is_whitespace() || c == ',')
        .filter(|token| !token.is_empty())
        .collect()
}

pub fn extract_times(text: &str) -> Vec<ParsedTime> {
    let mut times = Vec::new();
    let tokens: Vec<&str> = text.split_whitespace().collect();

    for (i, token) in tokens.iter().enumerate() {
        let cleaned = token.replace(['a', 'p', 'm', 'A', 'P', 'M', '.'], "");
        let (hour_str, min_str) = match cleaned.split_once(':') {
            Some((h, m)) => (h, m),
            None => (cleaned.as_str(), "0"),
        };

        let Ok(h) = hour_str.parse::<u32>() else {
            continue;
        };
        let Ok(m) = min_str.parse::<u32>() else {
            continue;
        };

        if (1..=12).contains(&h) && m < 60 {
            let token_lower = token.to_lowercase();
            let next_token_lower = tokens
                .get(i + 1)
                .map(|t| t.to_lowercase())
                .unwrap_or_default();

            let is_am = token_lower.contains("a.m")
                || token_lower.contains("am")
                || next_token_lower.starts_with("a.m")
                || next_token_lower == "am";
            let is_pm = token_lower.contains("p.m")
                || token_lower.contains("pm")
                || next_token_lower.starts_with("p.m")
                || next_token_lower == "pm";

            if is_am || is_pm {
                times.push(ParsedTime {
                    hour: h,
                    minute: m,
                    is_pm,
                });
            }
        }
    }
    times
}

/// Resolves a wall clock written in `time_zone` to a UTC timestamp.
pub fn make_zoned_timestamp(
    date: NaiveDate,
    time: Option<&ParsedTime>,
    end_of_day: bool,
    time_zone: &Tz,
) -> u64 {
    let (hour, minute) = match time {
        Some(t) => t.to_24_hour(),
        None => (
            if end_of_day { 23 } else { 0 },
            if end_of_day { 59 } else { 0 },
        ),
    };

    let (name, data) = jiff_tzdb::get(time_zone.name()).expect("timezone exists in bundled tzdb");
    let zone = jiff::tz::TimeZone::tzif(name, data).expect("valid bundled tzdb");
    let date = jiff::civil::date(date.year() as i16, date.month() as i8, date.day() as i8);
    let wall = date.at(hour as i8, minute as i8, if end_of_day { 59 } else { 0 }, 0);
    zone.to_ambiguous_timestamp(wall)
        .compatible()
        .expect("valid local time")
        .as_second() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_daylight_saving_gaps_and_overlaps() {
        let zone = chrono_tz::America::Toronto;
        let spring = NaiveDate::from_ymd_opt(2026, 3, 8).unwrap();
        let autumn = NaiveDate::from_ymd_opt(2026, 11, 1).unwrap();
        let clock = |hour| ParsedTime {
            hour,
            minute: 30,
            is_pm: false,
        };
        assert_eq!(
            make_zoned_timestamp(spring, Some(&clock(2)), false, &zone),
            1772955000
        );
        assert_eq!(
            make_zoned_timestamp(autumn, Some(&clock(1)), false, &zone),
            1793511000
        );
    }

    #[test]
    fn test_parse_period_lexical() {
        let text = "Monday, March 16th to Friday, March 20th, 2026 6:00 p.m.";
        let ranges = parse_period_lexical(Some(text), &chrono_tz::America::Toronto, 2026);
        assert_eq!(ranges.len(), 1);

        let range = &ranges[0];
        assert_eq!(range.start, Some(1773633600)); // 2026-03-16 00:00:00 EDT
        assert_eq!(range.end, Some(1774044000)); // 2026-03-20 18:00:00 EDT
    }
}
