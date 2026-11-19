//! A project held in memory: relative paths with contents plus the config.

use crate::{Failure, Outcome, failure};
use fallow_config::FallowConfig;
use fallow_types::discover::{DiscoveredFile, FileId};
use globset::{Glob, GlobSet, GlobSetBuilder};
use rustc_hash::FxHashMap;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Overrides a caller may pass per duplication run.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct DuplicationOptions {
    mode: Option<String>,
    min_tokens: Option<usize>,
    min_lines: Option<usize>,
}

const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Instance {
    file: String,
    start_line: usize,
    end_line: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Group {
    token_count: usize,
    line_count: usize,
    instances: Vec<Instance>,
}

pub struct Project {
    root: PathBuf,
    files: Vec<DiscoveredFile>,
    sources: FxHashMap<PathBuf, String>,
    config: Result<FallowConfig, String>,
    config_code: &'static str,
}

fn load_config(config_path: &str) -> Result<FallowConfig, (&'static str, String)> {
    if config_path.is_empty() {
        return Ok(FallowConfig::default());
    }
    FallowConfig::load(std::path::Path::new(config_path)).map_err(|error| {
        let message = format!("{error:?}");
        let code = if message.contains("remote-extends-unsupported") {
            "remote-extends-unsupported"
        } else if message.contains("extends") {
            "extends-unsupported"
        } else {
            "config-invalid"
        };
        (code, message)
    })
}

/// Discovery skips hidden directories that are not on its allowlist.
fn in_unlisted_hidden_dir(path: &str) -> bool {
    let mut parts = path.split('/').peekable();
    while let Some(part) = parts.next() {
        if parts.peek().is_some()
            && part.starts_with('.')
            && !fallow_core::discover::is_allowed_hidden_dir(std::ffi::OsStr::new(part))
        {
            return true;
        }
    }
    false
}

fn globs(patterns: &[String]) -> GlobSet {
    let mut builder = GlobSetBuilder::new();
    for pattern in patterns {
        if let Ok(glob) = Glob::new(pattern) {
            builder.add(glob);
        }
    }
    builder.build().unwrap_or_else(|_| GlobSet::empty())
}

impl Project {
    /// `paths` are relative to `root`; files are read through the WASI preopen and unreadable
    /// or oversized (over 4 MiB) ones are skipped. `config_path` is absolute or empty.
    pub fn new(root: &str, paths: Vec<String>, config_path: &str) -> Project {
        let root = PathBuf::from(root);
        let (config, config_code) = match load_config(config_path) {
            Ok(config) => (Ok(config), ""),
            Err((code, message)) => (Err(message), code),
        };
        let ignore = match &config {
            Ok(config) => {
                let mut patterns = config.ignore_patterns.clone();
                patterns.push("**/node_modules/**".to_owned());
                globs(&patterns)
            }
            Err(_) => GlobSet::empty(),
        };
        let mut rows: Vec<(String, String)> = paths
            .into_iter()
            .filter(|path| {
                let extension = path.rsplit_once('.').map_or("", |(_, ext)| ext);
                fallow_core::discover::SOURCE_EXTENSIONS.contains(&extension)
                    && !ignore.is_match(path)
                    && !in_unlisted_hidden_dir(path)
            })
            .filter_map(|path| {
                let absolute = root.join(&path);
                let size = std::fs::metadata(&absolute).ok()?.len();
                if size > MAX_FILE_BYTES {
                    return None;
                }
                let content = std::fs::read_to_string(&absolute).ok()?;
                Some((path, content))
            })
            .collect();
        // File ids follow path order, as native discovery does.
        rows.sort_by(|a, b| a.0.cmp(&b.0));
        let mut files = Vec::with_capacity(rows.len());
        let mut sources = FxHashMap::default();
        for (index, (path, content)) in rows.into_iter().enumerate() {
            let absolute = root.join(&path);
            files.push(DiscoveredFile {
                id: FileId(index as u32),
                path: absolute.clone(),
                size_bytes: content.len() as u64,
            });
            sources.insert(absolute, content);
        }
        Project {
            root,
            files,
            sources,
            config,
            config_code,
        }
    }

    /// Clone groups of the full run. With `changed` non-empty, only the groups that touch a
    /// changed path are reported, exactly as the full run groups them.
    pub fn duplication(&self, changed: &[String], options_json: &str) -> Outcome {
        self.run_duplication(changed, options_json)
    }

    /// Feature-flag uses the extractor recognises: environment variables with a
    /// flag prefix, SDK calls and config-object reads. `paths` limits the files
    /// (all files when empty).
    pub fn feature_flags(&self, paths: &[String]) -> Outcome {
        self.run_feature_flags(paths)
    }

    /// Functions over the configured complexity thresholds in `paths` (all files
    /// when empty), worst first.
    pub fn complexity(&self, paths: &[String]) -> Outcome {
        self.run_complexity(paths)
    }
}

impl Project {
    pub(crate) fn config(&self) -> Result<&FallowConfig, Failure> {
        self.config
            .as_ref()
            .map_err(|message| failure(self.config_code, message.clone()))
    }

    fn relative(&self, path: &std::path::Path) -> String {
        path.strip_prefix(&self.root)
            .unwrap_or(path)
            .to_string_lossy()
            .into_owned()
    }

    fn run_duplication(&self, changed: &[String], options_json: &str) -> Outcome {
        let config = self.config()?;
        let mut duplicates = config.duplicates.clone();
        if !options_json.trim().is_empty() {
            let options: DuplicationOptions = serde_json::from_str(options_json)
                .map_err(|error| failure("options-invalid", error.to_string()))?;
            if let Some(mode) = options.mode {
                duplicates.mode = mode
                    .parse()
                    .map_err(|_| failure("options-invalid", format!("unknown mode {mode}")))?;
            }
            if let Some(value) = options.min_tokens {
                duplicates.min_tokens = value;
            }
            if let Some(value) = options.min_lines {
                duplicates.min_lines = value;
            }
        }
        let changed_paths: std::collections::HashSet<PathBuf> =
            changed.iter().map(|path| self.root.join(path)).collect();
        let analysis = fallow_engine::duplicates::find_duplicates_in_memory(
            &self.root,
            &self.files,
            &self.sources,
            &duplicates,
        );
        let report = analysis.report;
        let groups: Vec<Group> = report
            .clone_groups
            .iter()
            // The full report is the reference. Upstream's focused detection prunes the corpus
            // and can group the same code differently, so the changed set only filters.
            .filter(|group| {
                changed_paths.is_empty()
                    || group
                        .instances
                        .iter()
                        .any(|i| changed_paths.contains(&i.file))
            })
            .map(|group| Group {
                token_count: group.token_count,
                line_count: group.line_count,
                instances: group
                    .instances
                    .iter()
                    .map(|instance| Instance {
                        file: self.relative(&instance.file),
                        start_line: instance.start_line,
                        end_line: instance.end_line,
                    })
                    .collect(),
            })
            .collect();
        Ok(serde_json::json!({
            "groups": groups,
            "stats": {
                "totalFiles": report.stats.total_files,
                "totalLines": report.stats.total_lines,
                "duplicatedLines": report.stats.duplicated_lines,
                "cloneGroups": report.stats.clone_groups,
                "duplicationPercentage": report.stats.duplication_percentage,
            },
        }))
    }

    fn run_feature_flags(&self, paths: &[String]) -> Outcome {
        self.config()?;
        let wanted: Option<std::collections::HashSet<PathBuf>> =
            (!paths.is_empty()).then(|| paths.iter().map(|path| self.root.join(path)).collect());
        let mut flags = Vec::new();
        for file in &self.files {
            if wanted
                .as_ref()
                .is_some_and(|wanted| !wanted.contains(&file.path))
            {
                continue;
            }
            let Some(source) = self.sources.get(&file.path) else {
                continue;
            };
            let info = fallow_extract::parse_from_content(file.id, &file.path, source);
            let relative = self.relative(&file.path);
            for flag in &info.flag_uses {
                flags.push(serde_json::json!({
                    "file": relative,
                    "name": flag.flag_name,
                    "kind": format!("{:?}", flag.kind),
                    "line": flag.line,
                    "sdk": flag.sdk_name,
                }));
            }
        }
        Ok(serde_json::json!({ "flags": flags }))
    }

    fn run_complexity(&self, paths: &[String]) -> Outcome {
        let config = self.config()?;
        let max_cyclomatic = config.health.max_cyclomatic;
        let max_cognitive = config.health.max_cognitive;
        let wanted: Option<std::collections::HashSet<PathBuf>> =
            (!paths.is_empty()).then(|| paths.iter().map(|path| self.root.join(path)).collect());
        let mut findings = Vec::new();
        for file in &self.files {
            if wanted
                .as_ref()
                .is_some_and(|wanted| !wanted.contains(&file.path))
            {
                continue;
            }
            let Some(source) = self.sources.get(&file.path) else {
                continue;
            };
            let info = fallow_extract::parse_from_content(file.id, &file.path, source);
            let relative = self.relative(&file.path);
            for function in &info.complexity {
                if fallow_types::extract::is_synthetic_module_unit(&function.name) {
                    continue;
                }
                if function.cyclomatic > max_cyclomatic || function.cognitive > max_cognitive {
                    findings.push(serde_json::json!({
                        "file": relative,
                        "name": function.name,
                        "line": function.line,
                        "cyclomatic": function.cyclomatic,
                        "cognitive": function.cognitive,
                        "lineCount": function.line_count,
                    }));
                }
            }
        }
        findings.sort_by(|a, b| {
            let key = |value: &serde_json::Value| value["cognitive"].as_u64().unwrap_or(0);
            key(b).cmp(&key(a))
        });
        Ok(serde_json::json!({
            "functions": findings,
            "thresholds": { "maxCyclomatic": max_cyclomatic, "maxCognitive": max_cognitive },
        }))
    }
}
