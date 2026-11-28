use cpd_core::detect::{PathFilters, PreparedSource, detect_prepared, merge_gapped_clones};
use cpd_core::models::{CpdClone, SimilarityMethod};
use cpd_core::similarity::{FunctionSig, collect_function_sources, find_similar_functions};
use cpd_tokenizer::functions::{extract_functions, supports_functions};
use cpd_tokenizer::tokenizer::{
    Mode, TokenizeOptions, code_ignore_ranges, tokenize_to_detection_maps,
};
use globset::{Glob, GlobSet, GlobSetBuilder};
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};

const DETECTORS: &[&str] = &[
    "strict",
    "mild",
    "weak",
    "renamed",
    "gap",
    "ast",
    "cross-language",
];
const JAVASCRIPT_TYPESCRIPT: &[&str] = &["javascript", "jsx", "typescript", "tsx"];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    files: Vec<InputFile>,
    detectors: Vec<String>,
    #[serde(default = "default_min_tokens")]
    min_tokens: usize,
    #[serde(default = "default_min_lines")]
    min_lines: usize,
    #[serde(default)]
    config: ScanConfig,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InputFile {
    path: String,
    #[serde(default)]
    format: Option<String>,
    source: String,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScanConfig {
    #[serde(default)]
    mode: String,
    #[serde(default)]
    ignore_case: bool,
    #[serde(default)]
    ignore_identifiers: bool,
    #[serde(default)]
    ignore_literals: bool,
    #[serde(default)]
    ignore_annotations: bool,
    #[serde(default)]
    ignore: Vec<String>,
    #[serde(default)]
    code_ignore_patterns: Vec<String>,
    #[serde(default)]
    cross_formats: Vec<Vec<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    detectors: Vec<DetectorReport>,
    coverage: ScanCoverage,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanCoverage {
    files_received: usize,
    files_scanned: usize,
    files_unsupported: usize,
    files_ignored: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DetectorReport {
    detector: String,
    clones: Vec<ClonePair>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClonePair {
    fingerprint: String,
    format: String,
    kind: String,
    tokens: u32,
    lines: u32,
    first: CloneLocation,
    second: CloneLocation,
    #[serde(skip_serializing_if = "Option::is_none")]
    similarity: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CloneLocation {
    path: String,
    start_line: u32,
    end_line: u32,
}

struct SourceRecord<'a> {
    path: &'a str,
    source: &'a str,
}

fn default_min_tokens() -> usize {
    50
}

fn default_min_lines() -> usize {
    5
}

fn mode_for(detector: &str, configured: &str) -> Mode {
    match detector {
        "strict" => Mode::Strict,
        "mild" => Mode::Mild,
        "weak" => Mode::Weak,
        _ => match configured {
            "strict" => Mode::Strict,
            "weak" => Mode::Weak,
            _ => Mode::Mild,
        },
    }
}

fn groups_for(detector: &str, configured: &[Vec<String>]) -> Vec<Vec<String>> {
    if detector == "cross-language" {
        return vec![
            JAVASCRIPT_TYPESCRIPT
                .iter()
                .map(|format| (*format).to_string())
                .collect(),
        ];
    }
    configured.to_vec()
}

fn strip_types_formats(cross_formats: &[Vec<String>]) -> HashSet<String> {
    cross_formats
        .iter()
        .filter(|group| {
            group
                .iter()
                .any(|format| matches!(format.as_str(), "javascript" | "jsx"))
        })
        .flat_map(|group| {
            group
                .iter()
                .filter(|format| matches!(format.as_str(), "typescript" | "tsx"))
                .cloned()
        })
        .collect()
}

fn pool_key(format: &str, groups: &[Vec<String>]) -> String {
    match groups
        .iter()
        .position(|group| group.iter().any(|member| member == format))
    {
        Some(index) => format!("cross:{index:04}"),
        None => format!("format:{format}"),
    }
}

fn build_pools(
    mut prepared: Vec<PreparedSource>,
    cross_formats: &[Vec<String>],
) -> Vec<Vec<PreparedSource>> {
    prepared.sort_unstable_by(|left, right| {
        left.format.cmp(&right.format).then(left.id.cmp(&right.id))
    });
    let mut pools: HashMap<String, Vec<PreparedSource>> = HashMap::new();
    for source in prepared {
        pools
            .entry(pool_key(&source.format, cross_formats))
            .or_default()
            .push(source);
    }
    let mut pools: Vec<_> = pools.into_iter().collect();
    pools.sort_by(|left, right| left.0.cmp(&right.0));
    pools.into_iter().map(|(_, sources)| sources).collect()
}

fn prepare_sources<'a>(
    files: &'a [InputFile],
    detector: &str,
    config: &ScanConfig,
    ignore_regexes: &[Regex],
    ignore_set: &GlobSet,
) -> (
    Vec<PreparedSource>,
    HashMap<String, SourceRecord<'a>>,
    (usize, usize),
) {
    let cross_formats = groups_for(detector, &config.cross_formats);
    let strip_types = strip_types_formats(&cross_formats);
    let mut prepared = Vec::new();
    let mut records = HashMap::new();
    let mut unsupported = 0;
    let mut ignored = 0;

    for file in files {
        if ignore_set.is_match(file.path.replace('\\', "/")) {
            ignored += 1;
            continue;
        }
        let format = file
            .format
            .as_deref()
            .and_then(cpd_tokenizer::formats::resolve_format)
            .or_else(|| {
                let extension = file.path.rsplit_once('.').map(|(_, ext)| ext)?;
                cpd_tokenizer::formats::get_format_by_extension(&extension.to_ascii_lowercase())
            })
            .or_else(|| {
                file.source
                    .lines()
                    .next()
                    .and_then(cpd_tokenizer::formats::get_format_by_shebang)
            })
            .map(str::to_string);
        let Some(format) = format else {
            unsupported += 1;
            continue;
        };
        let mode = mode_for(detector, &config.mode);
        let options = TokenizeOptions {
            mode,
            ignore_case: config.ignore_case,
            ignore_identifiers: config.ignore_identifiers || detector == "renamed",
            ignore_literals: config.ignore_literals || detector == "renamed",
            ignore_annotations: config.ignore_annotations,
            ignore_ranges: code_ignore_ranges(&file.source, ignore_regexes),
            code_ignore_regexes: ignore_regexes.to_vec(),
            strip_types_formats: strip_types.clone(),
        };
        let maps = tokenize_to_detection_maps(&format, &file.source, &options);
        for (map_index, map) in maps.into_iter().enumerate() {
            if map.tokens.is_empty() {
                continue;
            }
            let id = format!("{}:{}:{map_index:04}", file.path, map.format);
            let is_embedded = map.format != format;
            let mut source =
                PreparedSource::from_detection_tokens(id.clone(), map.format, &map.tokens);
            source.embedded = is_embedded;
            if detector == "ast" && !is_embedded && supports_functions(&format) {
                source.functions = extract_functions(&file.source, &format)
                    .into_iter()
                    .filter_map(|function| {
                        FunctionSig::build(
                            function.grammar,
                            function.name,
                            function.start,
                            function.end,
                            &function.kinds,
                            &source.spans,
                        )
                    })
                    .collect();
            }
            records.insert(
                id,
                SourceRecord {
                    path: &file.path,
                    source: &file.source,
                },
            );
            prepared.push(source);
        }
    }
    (prepared, records, (unsupported, ignored))
}

fn digest_fragment<'a>(clone: &CpdClone, records: &HashMap<String, SourceRecord<'a>>) -> String {
    let candidates = [
        (&clone.fragment_a, clone.fragment_a.range),
        (&clone.fragment_b, clone.fragment_b.range),
    ];
    let fragment = candidates
        .into_iter()
        .max_by_key(|(fragment, _)| fragment.end.offset.saturating_sub(fragment.start.offset))
        .and_then(|(fragment, _)| {
            let source = records.get(&fragment.source_id)?;
            source
                .source
                .get(fragment.start.offset as usize..fragment.end.offset as usize)
        })
        .unwrap_or_default();
    let normalized = fragment.split_whitespace().collect::<Vec<_>>().join(" ");
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

fn lines(clone: &CpdClone, index: usize) -> u32 {
    let fragment = if index == 0 {
        &clone.fragment_a
    } else {
        &clone.fragment_b
    };
    fragment
        .end
        .line
        .saturating_sub(fragment.start.line)
        .saturating_add(1)
        .saturating_sub(clone.unmatched_lines[index])
}

fn pair_report<'a>(clone: &CpdClone, records: &HashMap<String, SourceRecord<'a>>) -> ClonePair {
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
        lines: lines(clone, 0).max(lines(clone, 1)),
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

fn report_detector(
    request: &Request,
    detector: &str,
    ignore_regexes: &[Regex],
    ignore_set: &GlobSet,
) -> DetectorReport {
    let (prepared, records, _) = prepare_sources(
        &request.files,
        detector,
        &request.config,
        ignore_regexes,
        ignore_set,
    );
    let cross_formats = groups_for(detector, &request.config.cross_formats);
    let function_sources = collect_function_sources(&prepared);
    let mut clones = detect_prepared(
        build_pools(prepared, &cross_formats),
        request.min_tokens,
        request.min_lines,
        &PathFilters::default(),
    );
    let max_gap_lines = if detector == "gap" { 3 } else { 0 };
    clones = merge_gapped_clones(clones, max_gap_lines);
    let similarity = if detector == "ast" { 0.85 } else { 1.0 };
    if similarity > 0.0 && similarity < 1.0 {
        clones.extend(find_similar_functions(
            function_sources,
            similarity,
            request.min_tokens,
            request.min_lines,
            &clones,
        ));
    }
    clones.sort_by(|left, right| left.position_key().cmp(&right.position_key()));
    DetectorReport {
        detector: detector.to_string(),
        clones: clones
            .iter()
            .map(|clone| pair_report(clone, &records))
            .collect(),
    }
}

fn scan(request: Request) -> Result<Response, ()> {
    if request.min_tokens == 0
        || request.min_lines == 0
        || request
            .detectors
            .iter()
            .any(|detector| !DETECTORS.contains(&detector.as_str()))
    {
        return Err(());
    }
    let ignore_regexes = request
        .config
        .code_ignore_patterns
        .iter()
        .map(|pattern| Regex::new(pattern).map_err(|_| ()))
        .collect::<Result<Vec<_>, _>>()?;
    let mut ignore_builder = GlobSetBuilder::new();
    for pattern in &request.config.ignore {
        let pattern = pattern.trim_start_matches('/');
        if let Ok(glob) = Glob::new(pattern) {
            ignore_builder.add(glob);
        }
        if !pattern.starts_with('/')
            && !pattern.contains(':')
            && let Ok(glob) = Glob::new(&format!("**/{pattern}"))
        {
            ignore_builder.add(glob);
        }
    }
    let ignore_set = ignore_builder.build().map_err(|_| ())?;
    let mut detectors = request.detectors.clone();
    detectors.sort_by_key(|detector| {
        DETECTORS
            .iter()
            .position(|name| *name == detector.as_str())
            .unwrap_or(usize::MAX)
    });
    detectors.dedup();
    let (_, _, (files_unsupported, files_ignored)) = prepare_sources(
        &request.files,
        "mild",
        &request.config,
        &ignore_regexes,
        &ignore_set,
    );
    Ok(Response {
        detectors: detectors
            .iter()
            .map(|detector| report_detector(&request, detector, &ignore_regexes, &ignore_set))
            .collect(),
        coverage: ScanCoverage {
            files_received: request.files.len(),
            files_scanned: request
                .files
                .len()
                .saturating_sub(files_unsupported + files_ignored),
            files_unsupported,
            files_ignored,
        },
    })
}

fn main() {
    let mut input = String::new();
    let response = if std::io::stdin().read_to_string(&mut input).is_ok() {
        serde_json::from_str::<Request>(&input)
            .ok()
            .and_then(|request| scan(request).ok())
    } else {
        None
    };
    let output = match response {
        Some(response) => serde_json::to_vec(&response).unwrap_or_default(),
        None => br#"{"error":{"code":"invalid-request"}}"#.to_vec(),
    };
    let _ = std::io::stdout().write_all(&output);
    let _ = std::io::stdout().write_all(b"\n");
}
