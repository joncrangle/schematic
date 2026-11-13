pub fn slug(value: &str) -> String {
    value
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

pub fn title_case(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        None => String::new(),
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
    }
}

pub fn clean_cms_description(raw_text: &str, title: &str) -> String {
    let mut lines = Vec::new();
    for line in raw_text.lines() {
        let trimmed = line.trim();
        let lower = trimmed.to_lowercase();
        if trimmed.is_empty()
            || trimmed == title
            || lower.starts_with("posted on")
            || lower == "read more"
        {
            continue;
        }
        let words: Vec<&str> = trimmed.split_whitespace().collect();
        lines.push(words.join(" "));
    }
    lines.join("\n")
}

/// Parses route tokens: one uppercase letter, or 1-3 digits with an optional trailing letter.
pub fn parse_standard_route_tokens(text: &str) -> Vec<String> {
    let mut routes = Vec::new();
    let raw_tokens: Vec<&str> = text
        .split(|c: char| c == ',' || c == '/' || c.is_whitespace())
        .map(|t| t.trim_matches(|c: char| !c.is_alphanumeric()))
        .filter(|t| !t.is_empty())
        .collect();

    for (i, &cleaned) in raw_tokens.iter().enumerate() {
        if cleaned.eq_ignore_ascii_case("and")
            || cleaned.eq_ignore_ascii_case("route")
            || cleaned.eq_ignore_ascii_case("highway")
            || cleaned.eq_ignore_ascii_case("hwy")
        {
            continue;
        }

        // Exclude roadway numbers, which follow a roadway word
        if i > 0 {
            let prev = raw_tokens[i - 1];
            if prev.eq_ignore_ascii_case("highway")
                || prev.eq_ignore_ascii_case("hwy")
                || prev.eq_ignore_ascii_case("avenue")
                || prev.eq_ignore_ascii_case("ave")
                || prev.eq_ignore_ascii_case("street")
                || prev.eq_ignore_ascii_case("st")
                || prev.eq_ignore_ascii_case("road")
                || prev.eq_ignore_ascii_case("rd")
            {
                continue;
            }
        }

        let chars: Vec<char> = cleaned.chars().collect();
        let is_route = match chars.len() {
            1 if chars[0].is_ascii_uppercase() => true,
            1..=3 if chars.iter().all(|c| c.is_ascii_digit()) => true,
            2..=4
                if chars[..chars.len() - 1].iter().all(|c| c.is_ascii_digit())
                    && chars.last().is_some_and(|c| c.is_ascii_alphabetic()) =>
            {
                true
            }
            _ => false,
        };

        if is_route {
            let canonical = cleaned.to_uppercase();
            if !routes.contains(&canonical) {
                routes.push(canonical);
            }
        }
    }

    routes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_standard_route_tokens() {
        let raw = "Routes affected: 101, 77A, and 202B / 303; Detour via a highway and a street";
        let tokens = parse_standard_route_tokens(raw);
        assert_eq!(tokens, vec!["101", "77A", "202B", "303"]);
    }

    #[test]
    fn test_clean_cms_description() {
        let raw = "Posted on March 15, 2026\nDetour active\nRead more";
        let cleaned = clean_cms_description(raw, "Title");
        assert_eq!(cleaned, "Detour active");
    }
}
