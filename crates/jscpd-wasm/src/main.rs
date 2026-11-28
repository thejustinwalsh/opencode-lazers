mod config;
mod ignore_rules;
mod reporter;

use cpd_core::detect::{PathFilters, PreparedSource, detect_prepared, merge_gapped_clones};
use cpd_core::similarity::{FunctionSig, collect_function_sources, find_similar_functions};
use cpd_tokenizer::functions::{extract_functions, supports_functions};
use cpd_tokenizer::tokenizer::{TokenizeOptions, code_ignore_ranges, tokenize_to_detection_maps};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};

use config::{
    CompiledFileFilters, FormatResolution, ScanConfig, groups_for, mode_for, path_filter_paths,
    resolve_format, strip_types_formats,
};
use ignore_rules::{CapturedIgnoreFiles, IgnoreFile};
use reporter::{DetectorReport, SourceRecord, pair_report};

const DETECTORS: &[&str] = &[
    "strict",
    "mild",
    "weak",
    "renamed",
    "gap",
    "ast",
    "cross-language",
];
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    files: Vec<InputFile>,
    #[serde(default)]
    ignore_files: Vec<IgnoreFile>,
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

fn default_min_tokens() -> usize {
    50
}

fn default_min_lines() -> usize {
    5
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
    ignore_files: &CapturedIgnoreFiles,
    detector: &str,
    config: &ScanConfig,
    ignore_regexes: &[Regex],
    file_filters: &CompiledFileFilters,
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
        if file_filters.ignores_source(&file.path, &file.source)
            || ignore_files.ignores(&file.path, config.no_gitignore)
        {
            ignored += 1;
            continue;
        }
        let format = match resolve_format(&file.path, file.format.as_deref(), &file.source, config)
        {
            FormatResolution::Selected(format) => format,
            FormatResolution::Filtered => {
                ignored += 1;
                continue;
            }
            FormatResolution::Unsupported => {
                unsupported += 1;
                continue;
            }
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

fn report_detector(
    request: &Request,
    detector: &str,
    ignore_regexes: &[Regex],
    file_filters: &CompiledFileFilters,
    ignore_files: &CapturedIgnoreFiles,
    path_filters: &PathFilters<'_>,
) -> DetectorReport {
    let (prepared, records, _) = prepare_sources(
        &request.files,
        ignore_files,
        detector,
        &request.config,
        ignore_regexes,
        file_filters,
    );
    let cross_formats = groups_for(detector, &request.config.cross_formats);
    let function_sources = collect_function_sources(&prepared);
    let mut clones = detect_prepared(
        build_pools(prepared, &cross_formats),
        request.min_tokens,
        request.min_lines,
        &PathFilters::default(),
    );
    let max_gap_lines = if detector == "gap" {
        3
    } else {
        request.config.max_gap_lines.unwrap_or(0)
    };
    clones = merge_gapped_clones(clones, max_gap_lines);
    let similarity = if detector == "ast" {
        request.config.similarity.unwrap_or(0.85)
    } else {
        request.config.similarity.unwrap_or(1.0)
    };
    if similarity > 0.0 && similarity < 1.0 {
        clones.extend(find_similar_functions(
            function_sources,
            similarity,
            request.min_tokens,
            request.min_lines,
            &clones,
        ));
    }
    clones.retain(|clone| {
        let path_a = records
            .get(&clone.fragment_a.source_id)
            .map(|source| source.path)
            .unwrap_or_default();
        let path_b = records
            .get(&clone.fragment_b.source_id)
            .map(|source| source.path)
            .unwrap_or_default();
        !path_filters.should_skip(path_a, path_b)
    });
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
        || (!request.config.mode.is_empty()
            && !matches!(request.config.mode.as_str(), "strict" | "mild" | "weak"))
        || request.config.similarity.is_some_and(|similarity| {
            !similarity.is_finite() || similarity <= 0.0 || similarity > 1.0
        })
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
        .filter_map(|pattern| Regex::new(pattern).ok())
        .collect::<Vec<_>>();
    let file_filters = CompiledFileFilters::new(&request.config, request.min_lines)?;
    let ignore_files = CapturedIgnoreFiles::new(&request.ignore_files);
    let (scan_roots, isolated_groups) = path_filter_paths(&request.config);
    let path_filters = PathFilters {
        skip_local: request.config.skip_local,
        scan_roots: &scan_roots,
        isolated_groups: &isolated_groups,
    };
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
        &ignore_files,
        "mild",
        &request.config,
        &ignore_regexes,
        &file_filters,
    );
    Ok(Response {
        detectors: detectors
            .iter()
            .map(|detector| {
                report_detector(
                    &request,
                    detector,
                    &ignore_regexes,
                    &file_filters,
                    &ignore_files,
                    &path_filters,
                )
            })
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
