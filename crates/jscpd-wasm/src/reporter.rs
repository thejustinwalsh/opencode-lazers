use cpd_core::models::{CpdClone, SimilarityMethod};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DetectorReport {
    pub(super) detector: String,
    pub(super) clones: Vec<ClonePair>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ClonePair {
    pub(super) fingerprint: String,
    pub(super) format: String,
    pub(super) kind: String,
    pub(super) tokens: u32,
    pub(super) lines: u32,
    pub(super) first: CloneLocation,
    pub(super) second: CloneLocation,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) similarity: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CloneLocation {
    pub(super) path: String,
    pub(super) start_line: u32,
    pub(super) end_line: u32,
}

pub(super) struct SourceRecord<'a> {
    pub(super) path: &'a str,
    pub(super) source: &'a str,
}

fn fragment_lines(source: &str, start_line: u32, end_line: u32) -> String {
    source
        .lines()
        .skip(start_line.saturating_sub(1) as usize)
        .take(end_line.saturating_sub(start_line).saturating_add(1) as usize)
        .collect::<Vec<_>>()
        .join("\n")
}

fn javascript_whitespace(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'..='\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

fn normalize_fragment(fragment: &str) -> String {
    let mut normalized = String::with_capacity(fragment.len());
    let mut pending_space = false;
    for character in fragment.chars() {
        if javascript_whitespace(character) {
            pending_space |= !normalized.is_empty();
            continue;
        }
        if pending_space {
            normalized.push(' ');
            pending_space = false;
        }
        normalized.push(character);
    }
    normalized
}

fn digest_fragment(clone: &CpdClone, records: &HashMap<String, SourceRecord<'_>>) -> String {
    let fragment = &clone.fragment_a;
    let source = records
        .get(&fragment.source_id)
        .map(|record| record.source)
        .unwrap_or_default();
    let fragment = fragment_lines(source, fragment.start.line, fragment.end.line);
    let normalized = normalize_fragment(&fragment);
    let digest = Sha256::digest(normalized.as_bytes());
    let mut hex = String::with_capacity(12);
    for byte in digest.iter().take(6) {
        use std::fmt::Write as _;
        let _ = write!(hex, "{byte:02x}");
    }
    format!("jscpd:{hex}")
}

fn source_path<'a>(id: &str, records: &'a HashMap<String, SourceRecord<'a>>) -> &'a str {
    records.get(id).map(|source| source.path).unwrap_or("")
}

fn fragment_span_lines(clone: &CpdClone) -> u32 {
    clone
        .fragment_a
        .end
        .line
        .saturating_sub(clone.fragment_a.start.line)
        .saturating_add(1)
}

pub(super) fn pair_report(
    clone: &CpdClone,
    records: &HashMap<String, SourceRecord<'_>>,
) -> ClonePair {
    let kind = match clone.similarity_method {
        Some(SimilarityMethod::Gap) => "gap",
        Some(SimilarityMethod::Ast) => "similar",
        None => clone.kind.as_str(),
    };
    ClonePair {
        fingerprint: digest_fragment(clone, records),
        format: clone.format.clone(),
        kind: kind.to_string(),
        tokens: clone.token_count,
        lines: fragment_span_lines(clone),
        first: CloneLocation {
            path: source_path(&clone.fragment_a.source_id, records).to_string(),
            start_line: clone.fragment_a.start.line,
            end_line: clone.fragment_a.end.line,
        },
        second: CloneLocation {
            path: source_path(&clone.fragment_b.source_id, records).to_string(),
            start_line: clone.fragment_b.start.line,
            end_line: clone.fragment_b.end.line,
        },
        similarity: clone.similarity_rounded(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cpd_core::models::{Fragment, Location};

    fn fragment(source_id: &str, start: u32, end: u32) -> Fragment {
        Fragment::new(
            source_id,
            Location::new(start, 0, 0),
            Location::new(end, 0, 0),
            [0, 0],
        )
    }

    fn fingerprint(text: &str) -> String {
        let digest = Sha256::digest(text.as_bytes());
        format!(
            "jscpd:{}",
            digest[..6]
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        )
    }

    #[test]
    fn reports_the_fragment_a_whole_lines_and_span() {
        let source_a = "before_a(); export function copied() {\n  return 1\n} after_a();\n";
        let source_b = "before_b(); export function copied() {\n  return 1\n} after_b();\n";
        let mut clone = CpdClone::exact(
            "javascript",
            fragment("a.js", 1, 3),
            fragment("b.js", 1, 4),
            72,
        );
        clone.unmatched_lines = [1, 0];
        let records = HashMap::from([
            (
                "a.js".to_string(),
                SourceRecord {
                    path: "src/a.js",
                    source: source_a,
                },
            ),
            (
                "b.js".to_string(),
                SourceRecord {
                    path: "src/b.js",
                    source: source_b,
                },
            ),
        ]);

        let report = pair_report(&clone, &records);
        assert_eq!(
            report.fingerprint,
            fingerprint("before_a(); export function copied() { return 1 } after_a();")
        );
        assert_eq!(report.lines, 3);
        assert_eq!(report.first.end_line, 3);
        assert_eq!(report.second.end_line, 4);
    }

    #[test]
    fn normalizes_javascript_whitespace_across_unicode_and_crlf_lines() {
        let source = "skip\r\n\u{FEFF}alpha\u{00A0}beta\r\n💀 end\r\n";
        let clone = CpdClone::exact(
            "javascript",
            fragment("a.js", 2, 3),
            fragment("b.js", 1, 2),
            50,
        );
        let records = HashMap::from([(
            "a.js".to_string(),
            SourceRecord {
                path: "a.js",
                source,
            },
        )]);

        let report = pair_report(&clone, &records);
        assert_eq!(report.fingerprint, fingerprint("alpha beta 💀 end"));
        assert_eq!(report.lines, 2);
    }
}
