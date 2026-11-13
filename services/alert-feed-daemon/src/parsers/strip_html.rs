//! Plain-text recovery for HTML alert bodies.
//!
//! Twin of `src/infrastructure/realtime/stripHtml.ts`: both use an HTML
//! fragment parser, remove script/style contents, preserve line breaks for
//! `<br>` and block endings, and normalize whitespace after parsing.

use scraper::{ElementRef, Html, Node};

const BLOCK_CLOSE_NAMES: [&str; 15] = [
    "p", "div", "li", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "table", "ul", "ol", "section",
    "article",
];

/// JavaScript `\s`, which `String.prototype.trim` also uses.
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

fn append_text(element: ElementRef<'_>, output: &mut String) {
    for child in element.children() {
        if let Some(child_element) = ElementRef::wrap(child) {
            let tag_name = child_element.value().name();
            match tag_name {
                "script" | "style" => output.push(' '),
                "br" => output.push('\n'),
                _ => {
                    append_text(child_element, output);
                    if BLOCK_CLOSE_NAMES.contains(&tag_name) {
                        output.push('\n');
                    }
                }
            }
        } else if let Node::Text(text) = child.value() {
            output.push_str(text);
        }
    }
}

fn collapse_line(line: &str) -> String {
    line.split(is_js_space)
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Recovers plain text from an HTML fragment. Character references are
/// decoded by the parser once, and malformed tag-like prose remains text.
pub fn strip_html(html: &str) -> String {
    if !html.contains(['<', '&', '\r', '\0']) {
        return html
            .split('\n')
            .map(collapse_line)
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
    }
    let fragment = Html::parse_fragment(html);
    let mut text = String::with_capacity(html.len());
    append_text(fragment.root_element(), &mut text);
    text.split('\n')
        .map(collapse_line)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::strip_html;

    #[test]
    fn recovers_plain_text_from_cms_markup() {
        assert_eq!(
            strip_html(
                "Closed.<br>\n<br>\n112 detours<p><br></p><p><strong>Use</strong>&nbsp;Main &amp; Dock</p>"
            ),
            "Closed.\n112 detours\nUse Main & Dock"
        );
        assert_eq!(
            strip_html("<script>x</script >a<BR/><ul><LI>b</LI><LI>c</LI></ul>"),
            "a\nb\nc"
        );
        assert_eq!(
            strip_html("&#38;lt; &#x41; &foo; 1 < 2"),
            "&lt; A &foo; 1 < 2"
        );
        assert_eq!(strip_html("Fare < $2 … > 3"), "Fare < $2 … > 3");
        assert_eq!(strip_html("&#xD800; &#55296;"), "� �");
        assert_eq!(strip_html("  plain\n\n text  "), "plain\ntext");
    }
}
