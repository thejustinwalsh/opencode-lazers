//! A project held in memory: relative paths with contents plus the config.

use crate::to_json;
use fallow_config::FallowConfig;
use fallow_types::discover::{DiscoveredFile, FileId};
use globset::{Glob, GlobSet, GlobSetBuilder};
use rustc_hash::FxHashMap;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use wasm_bindgen::prelude::*;

struct Failure {
    code: &'static str,
    message: String,
}

type Outcome = Result<serde_json::Value, Failure>;

fn failure(code: &'static str, message: impl Into<String>) -> Failure {
    Failure {
        code,
        message: message.into(),
    }
}

fn envelope(outcome: Outcome) -> String {
    match outcome {
        Ok(serde_json::Value::Object(mut map)) => {
            map.insert("ok".to_owned(), serde_json::Value::Bool(true));
            to_json(&map)
        }
        Ok(other) => to_json(&serde_json::json!({ "ok": true, "value": other })),
        Err(Failure { code, message }) => {
            to_json(&serde_json::json!({ "error": { "code": code, "message": message } }))
        }
    }
}

/// Overrides a caller may pass per duplication run.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct DuplicationOptions {
    mode: Option<String>,
    min_tokens: Option<usize>,
    min_lines: Option<usize>,
}

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

#[wasm_bindgen]
pub struct Project {
    root: PathBuf,
    files: Vec<DiscoveredFile>,
    sources: FxHashMap<PathBuf, String>,
    config: Result<FallowConfig, String>,
    config_code: &'static str,
}

fn parse_config(name: &str, text: &str) -> Result<FallowConfig, (&'static str, String)> {
    if text.trim().is_empty() {
        return Ok(FallowConfig::default());
    }
    let config: FallowConfig = if name.ends_with(".json") || name.ends_with(".jsonc") {
        fallow_config::jsonc::parse_to_value(text)
            .map_err(|error| ("config-invalid", error.to_string()))?
    } else {
        fallow_config::toml_input::from_str(text)
            .map_err(|error| ("config-invalid", error.to_string()))?
    };
    for entry in &config.extends {
        let lower = entry.to_ascii_lowercase();
        if lower.starts_with("https://") || lower.starts_with("http://") {
            return Err((
                "remote-extends-unsupported",
                "a remote `extends` is not supported".to_owned(),
            ));
        }
        return Err((
            "extends-unsupported",
            format!("`extends: {entry}` needs the host to inline it"),
        ));
    }
    Ok(config)
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

#[wasm_bindgen]
impl Project {
    /// `paths` are relative to `root` and parallel to `contents`. `config_name`
    /// selects the dialect by extension (`.json`, `.jsonc`, otherwise TOML).
    #[wasm_bindgen(constructor)]
    pub fn new(
        root: &str,
        paths: Vec<String>,
        contents: Vec<String>,
        config_name: &str,
        config_text: &str,
    ) -> Project {
        let root = PathBuf::from(root);
        let (config, config_code) = match parse_config(config_name, config_text) {
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
            .zip(contents)
            .filter(|(path, _)| {
                let extension = path.rsplit_once('.').map_or("", |(_, ext)| ext);
                fallow_core::discover::SOURCE_EXTENSIONS.contains(&extension)
                    && !ignore.is_match(path)
                    && !in_unlisted_hidden_dir(path)
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

    /// Number of analysable files after extension and ignore filtering.
    #[wasm_bindgen(js_name = fileCount)]
    pub fn file_count(&self) -> usize {
        self.files.len()
    }

    /// Clone groups of the full run. With `changed` non-empty, only the groups that touch a
    /// changed path are reported, exactly as the full run groups them.
    pub fn duplication(&self, changed: Vec<String>, options_json: &str) -> String {
        envelope(self.run_duplication(&changed, options_json))
    }

    /// Feature-flag uses the extractor recognises: environment variables with a
    /// flag prefix, SDK calls and config-object reads. `paths` limits the files
    /// (all files when empty).
    #[wasm_bindgen(js_name = featureFlags)]
    pub fn feature_flags(&self, paths: Vec<String>) -> String {
        envelope(self.run_feature_flags(&paths))
    }

    /// Functions over the configured complexity thresholds in `paths` (all files
    /// when empty), worst first.
    pub fn complexity(&self, paths: Vec<String>) -> String {
        envelope(self.run_complexity(&paths))
    }
}

impl Project {
    fn config(&self) -> Result<&FallowConfig, Failure> {
        self.config.as_ref().map_err(|message| failure(self.config_code, message.clone()))
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
                    || group.instances.iter().any(|i| changed_paths.contains(&i.file))
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
        let wanted: Option<std::collections::HashSet<PathBuf>> = (!paths.is_empty())
            .then(|| paths.iter().map(|path| self.root.join(path)).collect());
        let mut flags = Vec::new();
        for file in &self.files {
            if wanted.as_ref().is_some_and(|wanted| !wanted.contains(&file.path)) {
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
        let wanted: Option<std::collections::HashSet<PathBuf>> = (!paths.is_empty())
            .then(|| paths.iter().map(|path| self.root.join(path)).collect());
        let mut findings = Vec::new();
        for file in &self.files {
            if wanted.as_ref().is_some_and(|wanted| !wanted.contains(&file.path)) {
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
