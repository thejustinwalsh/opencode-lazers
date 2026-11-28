use cpd_tokenizer::tokenizer::Mode;
use globset::{Glob, GlobSet, GlobSetBuilder};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

pub(super) const JAVASCRIPT_TYPESCRIPT: &[&str] = &["javascript", "jsx", "typescript", "tsx"];

pub(super) enum FormatResolution {
    Selected(String),
    Filtered,
    Unsupported,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ScanConfig {
    #[serde(default)]
    pub(super) mode: String,
    #[serde(default)]
    pub(super) ignore_case: bool,
    #[serde(default)]
    pub(super) ignore_identifiers: bool,
    #[serde(default)]
    pub(super) ignore_literals: bool,
    #[serde(default)]
    pub(super) ignore_annotations: bool,
    #[serde(default, alias = "format")]
    pub(super) formats: Vec<String>,
    #[serde(default)]
    pub(super) formats_exts: HashMap<String, Vec<String>>,
    #[serde(default)]
    pub(super) formats_names: HashMap<String, Vec<String>>,
    #[serde(default)]
    pub(super) ignore: Vec<String>,
    #[serde(default, alias = "ignorePattern")]
    pub(super) code_ignore_patterns: Vec<String>,
    #[serde(default)]
    pub(super) cross_formats: Vec<Vec<String>>,
    #[serde(default)]
    pub(super) max_lines: Option<usize>,
    #[serde(default)]
    pub(super) max_size: Option<String>,
    #[serde(default)]
    pub(super) max_gap_lines: Option<usize>,
    #[serde(default)]
    pub(super) similarity: Option<f32>,
    #[serde(default)]
    pub(super) no_gitignore: bool,
    #[serde(default)]
    pub(super) skip_local: bool,
    #[serde(default)]
    pub(super) skip_isolated: Vec<Vec<String>>,
    #[serde(default)]
    pub(super) pattern: Option<String>,
}

pub(super) fn mode_for(detector: &str, configured: &str) -> Mode {
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

pub(super) fn groups_for(detector: &str, configured: &[Vec<String>]) -> Vec<Vec<String>> {
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

pub(super) fn strip_types_formats(cross_formats: &[Vec<String>]) -> HashSet<String> {
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

fn mapping_format(mappings: &HashMap<String, Vec<String>>, value: &str) -> Option<String> {
    let mut formats = mappings.keys().collect::<Vec<_>>();
    formats.sort();
    formats.into_iter().find_map(|format| {
        mappings
            .get(format)
            .is_some_and(|values| values.iter().any(|candidate| candidate == value))
            .then(|| format.clone())
    })
}

fn format_is_selected(format: &str, selected: &[String]) -> bool {
    selected.is_empty() || selected.iter().any(|candidate| candidate == format)
}

pub(super) fn resolve_format(
    path: &str,
    hint: Option<&str>,
    source: &str,
    config: &ScanConfig,
) -> FormatResolution {
    let file_name = path.rsplit('/').next().unwrap_or(path);
    let mut filtered = false;
    if let Some(format) = mapping_format(&config.formats_names, file_name) {
        if format_is_selected(&format, &config.formats) {
            return FormatResolution::Selected(format);
        }
        filtered = true;
    }
    if let Some(extension) = file_name.rsplit_once('.').map(|(_, extension)| extension)
        && let Some(format) = mapping_format(&config.formats_exts, extension)
    {
        if format_is_selected(&format, &config.formats) {
            return FormatResolution::Selected(format);
        }
        filtered = true;
    }
    let format = hint
        .and_then(cpd_tokenizer::formats::resolve_format)
        .or_else(|| {
            let extension = file_name.rsplit_once('.').map(|(_, ext)| ext)?;
            cpd_tokenizer::formats::get_format_by_extension(&extension.to_ascii_lowercase())
        })
        .or_else(|| {
            source
                .lines()
                .next()
                .and_then(cpd_tokenizer::formats::get_format_by_shebang)
        })
        .map(str::to_string);
    match format {
        Some(format) if format_is_selected(&format, &config.formats) => {
            FormatResolution::Selected(format)
        }
        Some(_) => FormatResolution::Filtered,
        None if filtered => FormatResolution::Filtered,
        None => FormatResolution::Unsupported,
    }
}

fn build_ignore_set(patterns: &[String]) -> Result<GlobSet, ()> {
    let mut builder = GlobSetBuilder::new();
    for raw_pattern in patterns {
        let anchored = raw_pattern.starts_with('/');
        let pattern = raw_pattern.trim_start_matches('/');
        if pattern.is_empty() {
            return Err(());
        }
        builder.add(Glob::new(pattern).map_err(|_| ())?);
        if !anchored && !pattern.contains(':') {
            builder.add(Glob::new(&format!("**/{pattern}")).map_err(|_| ())?);
        }
    }
    builder.build().map_err(|_| ())
}

fn build_pattern_set(pattern: &str) -> Result<GlobSet, ()> {
    let mut builder = GlobSetBuilder::new();
    builder.add(Glob::new(pattern).map_err(|_| ())?);
    if !pattern.starts_with('/') {
        let pattern = format!("**/{}", pattern.trim_start_matches("./"));
        builder.add(Glob::new(&pattern).map_err(|_| ())?);
    }
    builder.build().map_err(|_| ())
}

pub(super) struct CompiledFileFilters {
    ignore: GlobSet,
    pattern: Option<GlobSet>,
    min_lines: usize,
    max_lines: Option<usize>,
    max_size_bytes: u64,
}

impl CompiledFileFilters {
    pub(super) fn new(config: &ScanConfig, min_lines: usize) -> Result<Self, ()> {
        Ok(Self {
            ignore: build_ignore_set(&config.ignore)?,
            pattern: config
                .pattern
                .as_deref()
                .map(build_pattern_set)
                .transpose()?,
            min_lines,
            max_lines: config.max_lines,
            max_size_bytes: parse_max_size(config.max_size.as_deref())?,
        })
    }

    pub(super) fn ignores_path(&self, path: &str) -> bool {
        self.ignore.is_match(path)
            || self
                .pattern
                .as_ref()
                .is_some_and(|pattern| !pattern.is_empty() && !pattern.is_match(path))
    }

    pub(super) fn ignores_source(&self, path: &str, source: &str) -> bool {
        if self.ignores_path(path) || source.len() as u64 > self.max_size_bytes {
            return true;
        }
        let line_feeds = source.bytes().filter(|byte| *byte == b'\n').count();
        let line_count = line_feeds + usize::from(!source.is_empty() && !source.ends_with('\n'));
        line_count < self.min_lines || self.max_lines.is_some_and(|max| line_count > max)
    }
}

fn parse_max_size(value: Option<&str>) -> Result<u64, ()> {
    let Some(value) = value else {
        return Ok(1024 * 1024);
    };
    let value = value.trim().to_ascii_lowercase();
    let (digits, multiplier) = if let Some(value) = value.strip_suffix("gb") {
        (value, 1024_f64 * 1024.0 * 1024.0)
    } else if let Some(value) = value.strip_suffix('g') {
        (value, 1024_f64 * 1024.0 * 1024.0)
    } else if let Some(value) = value.strip_suffix("mb") {
        (value, 1024_f64 * 1024.0)
    } else if let Some(value) = value.strip_suffix('m') {
        (value, 1024_f64 * 1024.0)
    } else if let Some(value) = value.strip_suffix("kb") {
        (value, 1024_f64)
    } else if let Some(value) = value.strip_suffix('k') {
        (value, 1024_f64)
    } else if let Some(value) = value.strip_suffix('b') {
        (value, 1_f64)
    } else {
        (value.as_str(), 1_f64)
    };
    let size = digits.parse::<f64>().map_err(|_| ())?;
    if size < 0.0 || !size.is_finite() {
        return Err(());
    }
    Ok((size * multiplier).round() as u64)
}

pub(super) fn path_filter_paths(config: &ScanConfig) -> (Vec<PathBuf>, Vec<Vec<PathBuf>>) {
    let scan_roots = config
        .skip_local
        .then(|| vec![PathBuf::from("")])
        .unwrap_or_default();
    let isolated_groups = config
        .skip_isolated
        .iter()
        .map(|group| group.iter().map(PathBuf::from).collect())
        .collect();
    (scan_roots, isolated_groups)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_extensions_and_names_obey_the_format_selection() {
        let config = ScanConfig {
            formats: vec!["typescript".to_string()],
            formats_exts: HashMap::from([("typescript".to_string(), vec!["jscpd-ts".to_string()])]),
            formats_names: HashMap::from([(
                "typescript".to_string(),
                vec!["custom-source".to_string()],
            )]),
            ..ScanConfig::default()
        };

        assert!(matches!(
            resolve_format("src/custom.jscpd-ts", None, "", &config),
            FormatResolution::Selected(format) if format == "typescript"
        ));
        assert!(matches!(
            resolve_format("src/custom-source", None, "", &config),
            FormatResolution::Selected(format) if format == "typescript"
        ));
        assert!(matches!(
            resolve_format("src/plain.js", None, "", &config),
            FormatResolution::Filtered
        ));
    }

    #[test]
    fn file_filters_apply_globs_patterns_size_and_native_line_bounds() {
        let config = ScanConfig {
            ignore: vec!["generated/**".to_string()],
            pattern: Some("src/**/*.ts".to_string()),
            max_lines: Some(3),
            max_size: Some("4b".to_string()),
            ..ScanConfig::default()
        };
        let filters = CompiledFileFilters::new(&config, 2).unwrap();

        assert!(filters.ignores_source("generated/a.ts", "a\nb"));
        assert!(filters.ignores_source("src/a.js", "a\nb"));
        assert!(filters.ignores_source("src/a.ts", "a\nb\nc\nd"));
        assert!(filters.ignores_source("src/a.ts", "12345"));
        assert!(!filters.ignores_source("src/a.ts", "a\nb"));
        assert!(filters.ignores_source("src/a.ts", "a\n"));
    }

    #[test]
    fn malformed_file_globs_and_sizes_are_rejected() {
        let invalid_glob = ScanConfig {
            ignore: vec!["[".to_string()],
            ..ScanConfig::default()
        };
        assert!(CompiledFileFilters::new(&invalid_glob, 1).is_err());
        assert!(parse_max_size(Some("not-a-size")).is_err());
        assert_eq!(parse_max_size(Some("1.5kb")).unwrap(), 1536);
    }

    #[test]
    fn detector_modes_override_configured_mode_only_for_explicit_modes() {
        assert!(matches!(mode_for("strict", "weak"), Mode::Strict));
        assert!(matches!(mode_for("weak", "strict"), Mode::Weak));
        assert!(matches!(mode_for("renamed", "strict"), Mode::Strict));
    }
}
