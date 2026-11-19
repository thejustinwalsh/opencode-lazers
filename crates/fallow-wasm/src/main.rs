//! Fallow analysis as a WASI command (`wasm32-wasip1`).
//!
//! One request per instance: JSON on stdin, one JSON envelope on stdout, diagnostics and panic
//! messages on stderr. The host provides a read-only view of the project root through WASI
//! preopens; nothing here opens a socket, spawns a process or writes a file. Every response is
//! `{"ok":true,"report":...}` or `{"error":{"code":"...","message":"..."}}`.

use fallow_api as api;
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::PathBuf;

#[cfg(feature = "memstats")]
mod memstats;
mod project;
mod realpath;

#[cfg(feature = "memstats")]
#[global_allocator]
static ALLOCATOR: memstats::Counting = memstats::Counting;

pub(crate) struct Failure {
    pub code: String,
    pub message: String,
}

pub(crate) type Outcome = Result<serde_json::Value, Failure>;

pub(crate) fn failure(code: impl Into<String>, message: impl Into<String>) -> Failure {
    Failure {
        code: code.into(),
        message: message.into(),
    }
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Request {
    op: String,
    root: String,
    /// Absolute config path, or empty.
    config_path: String,
    /// Root-relative source paths (complexity, duplication, featureFlags).
    paths: Vec<String>,
    /// Complexity and feature flags: restrict to these. Duplication: keep groups touching these.
    files: Vec<String>,
    options: serde_json::Value,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct ApiOptions {
    explain: bool,
    css: bool,
    /// Use Fallow's own cache (`<root>/.fallow`). The host decides whether it may write there.
    cache: bool,
    threads: Option<usize>,
    files: Vec<String>,
}

fn api_failure(error: api::ProgrammaticError) -> Failure {
    failure(
        error.code.unwrap_or_else(|| "FALLOW_ERROR".to_owned()),
        error.message,
    )
}

fn analysis(request: &Request, options: &ApiOptions) -> api::AnalysisOptions {
    api::AnalysisOptions {
        root: Some(PathBuf::from(&request.root)),
        config_path: (!request.config_path.is_empty()).then(|| PathBuf::from(&request.config_path)),
        // Without `cache` the module writes nothing, and no cache directory is created.
        no_cache: !options.cache,
        threads: options.threads,
        explain: options.explain,
        ..api::AnalysisOptions::default()
    }
}

fn dead_code(request: &Request, options: &ApiOptions) -> Outcome {
    let options = api::DeadCodeOptions {
        analysis: analysis(request, options),
        files: options.files.iter().map(PathBuf::from).collect(),
        ..api::DeadCodeOptions::default()
    };
    let output = api::run_dead_code(&options).map_err(api_failure)?;
    api::serialize_dead_code_programmatic_json(output).map_err(api_failure)
}

fn cycles(request: &Request, options: &ApiOptions) -> Outcome {
    let options = api::DeadCodeOptions {
        analysis: analysis(request, options),
        files: options.files.iter().map(PathBuf::from).collect(),
        ..api::DeadCodeOptions::default()
    };
    let output = api::run_circular_dependencies(&options).map_err(api_failure)?;
    api::serialize_circular_dependencies_programmatic_json(output).map_err(api_failure)
}

fn architecture(request: &Request, options: &ApiOptions) -> Outcome {
    let options = api::ArchitectureOptions {
        analysis: analysis(request, options),
        files: options.files.iter().map(PathBuf::from).collect(),
        ..api::ArchitectureOptions::default()
    };
    let output = api::run_architecture(&options).map_err(api_failure)?;
    api::serialize_architecture_programmatic_json(output).map_err(api_failure)
}

fn feature_flags_report(request: &Request, options: &ApiOptions) -> Outcome {
    let options = api::FeatureFlagsOptions {
        analysis: analysis(request, options),
        ..api::FeatureFlagsOptions::default()
    };
    let output = api::run_feature_flags(&options).map_err(api_failure)?;
    api::serialize_feature_flags_programmatic_json(output).map_err(api_failure)
}

fn duplication_report(request: &Request, options: &ApiOptions) -> Outcome {
    let options = api::DuplicationOptions {
        analysis: analysis(request, options),
        ..api::DuplicationOptions::default()
    };
    let output = api::run_duplication(&options).map_err(api_failure)?;
    api::serialize_duplication_programmatic_json(output).map_err(api_failure)
}

fn health_report(request: &Request, options: &ApiOptions) -> Outcome {
    let options = api::ComplexityOptions {
        analysis: analysis(request, options),
        css: options.css,
        ..api::ComplexityOptions::default()
    };
    let output =
        api::run_health_with_runner(&options, &api::EngineHealthRunner).map_err(api_failure)?;
    api::serialize_health_programmatic_json(output).map_err(api_failure)
}

fn io_result<T>(result: std::io::Result<T>) -> serde_json::Value {
    match result {
        Ok(_) => serde_json::json!({ "ok": true }),
        Err(error) => serde_json::json!({ "ok": false, "error": error.to_string() }),
    }
}

/// Guards of the host, exercised by tests against the shipped module: every write the module
/// might attempt must fail, reads must stay inside the preopened roots, and only read-only git
/// subcommands may run. Not used by the product.
fn probe(request: &Request) -> Outcome {
    let root = PathBuf::from(&request.root);
    let existing = request.options["existing"]
        .as_str()
        .unwrap_or("package.json");
    match request.op.as_str() {
        "fsProbe" => {
            let reads: Vec<serde_json::Value> = request.options["read"]
                .as_array()
                .map(|paths| {
                    paths
                        .iter()
                        .filter_map(serde_json::Value::as_str)
                        .map(|path| {
                            let mut row = io_result(std::fs::read_to_string(path));
                            row["path"] = serde_json::Value::from(path);
                            row
                        })
                        .collect()
                })
                .unwrap_or_default();
            Ok(serde_json::json!({
                "createDir": io_result(std::fs::create_dir(root.join("zz-probe-dir"))),
                "writeFile": io_result(std::fs::write(root.join("zz-probe-file"), b"x")),
                "overwrite": io_result(std::fs::write(root.join(existing), b"x")),
                "append": io_result(
                    std::fs::OpenOptions::new().append(true).open(root.join(existing))
                ),
                "removeFile": io_result(std::fs::remove_file(root.join(existing))),
                "rename": io_result(
                    std::fs::rename(root.join(existing), root.join("zz-probe-renamed"))
                ),
                "cacheWrite": io_result(
                    std::fs::create_dir_all(root.join(".fallow/probe"))
                        .and_then(|()| std::fs::write(root.join(".fallow/probe/x"), b"x"))
                ),
                "cacheEscape": io_result(
                    std::fs::create_dir_all(root.join(".fallow/probe/../../zz-escape"))
                ),
                "reads": reads,
            }))
        }
        _ => {
            let args: Vec<String> = request.options["args"]
                .as_array()
                .map(|args| {
                    args.iter()
                        .filter_map(serde_json::Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            let output = fallow_engine::git_process::Command::new("git")
                .args(&args)
                .current_dir(&root)
                .output();
            Ok(match output {
                Ok(output) => serde_json::json!({
                    "ran": true,
                    "code": output.status.code(),
                    "stdout": String::from_utf8_lossy(&output.stdout),
                }),
                Err(error) => serde_json::json!({ "ran": false, "error": error.to_string() }),
            })
        }
    }
}

/// Whether the project's config turns on a rule that reads the security facts of a module. When
/// it does, or the config cannot be read, modules keep those facts and the cache stays off (it
/// stores modules without them).
fn security_rules_on(request: &Request) -> bool {
    use fallow_config::{FallowConfig, Severity};
    let loaded = if request.config_path.is_empty() {
        FallowConfig::find_and_load(std::path::Path::new(&request.root))
            .map(|found| found.map(|(config, _)| config))
            .map_err(|error| format!("{error:?}"))
    } else {
        FallowConfig::load(std::path::Path::new(&request.config_path))
            .map(Some)
            .map_err(|error| format!("{error:?}"))
    };
    match loaded {
        Ok(Some(config)) => {
            config.rules.security_sink != Severity::Off
                || config.rules.security_client_server_leak != Severity::Off
        }
        Ok(None) => false,
        Err(_) => true,
    }
}

fn run(request: &Request) -> Outcome {
    let mut options: ApiOptions = if request.options.is_null() {
        ApiOptions::default()
    } else {
        serde_json::from_value(request.options.clone())
            .map_err(|error| failure("options-invalid", error.to_string()))?
    };
    let security = security_rules_on(request);
    fallow_extract::set_retain_security_facts(security);
    options.cache = options.cache && !security;
    match request.op.as_str() {
        "complexity" | "duplication" | "featureFlags" => {
            let project =
                project::Project::new(&request.root, request.paths.clone(), &request.config_path);
            match request.op.as_str() {
                "complexity" => project.complexity(&request.files),
                "featureFlags" => project.feature_flags(&request.files),
                _ => project.duplication(&request.files, &request.options.to_string()),
            }
        }
        "deadCode" => dead_code(request, &options),
        "cycles" => cycles(request, &options),
        "architecture" => architecture(request, &options),
        "featureFlagReport" => feature_flags_report(request, &options),
        "duplicationReport" => duplication_report(request, &options),
        "health" => health_report(request, &options),
        "fsProbe" | "gitProbe" => probe(request),
        #[cfg(feature = "memstats")]
        "retentionProbe" => retention_probe(request),
        other => Err(failure("unknown-op", format!("unknown op {other}"))),
    }
}

#[derive(Serialize)]
struct Wrapped<'a> {
    ok: bool,
    report: &'a serde_json::Value,
}

fn main() {
    let mut input = String::new();
    let outcome = match std::io::stdin().read_to_string(&mut input) {
        Err(error) => Err(failure("stdin", error.to_string())),
        Ok(_) => serde_json::from_str::<Request>(&input)
            .map_err(|error| failure("request-invalid", error.to_string()))
            .and_then(|request| run(&request)),
    };
    let text = match outcome {
        Ok(report) => serde_json::to_string(&Wrapped {
            ok: true,
            report: &report,
        }),
        Err(Failure { code, message }) => Ok(serde_json::json!({
            "error": { "code": code, "message": message }
        })
        .to_string()),
    }
    .unwrap_or_else(|error| {
        format!("{{\"error\":{{\"code\":\"serialize\",\"message\":\"{error}\"}}}}")
    });
    let mut stdout = std::io::stdout().lock();
    let _ = stdout.write_all(text.as_bytes());
    let _ = stdout.flush();
}

/// What one extraction keeps after the source and the syntax tree are gone (feature memstats).
#[cfg(feature = "memstats")]
fn retention_probe(request: &Request) -> Outcome {
    use fallow_types::discover::FileId;
    use memstats::{live, peak, reset_peak};
    let root = PathBuf::from(&request.root);
    let mut modules = Vec::new();
    let mut source_bytes = 0u64;
    let mut worst_transient = 0u64;
    let mut transient_sum = 0u64;
    let before_all = live();
    for (index, path) in request.paths.iter().enumerate() {
        let Ok(source) = std::fs::read_to_string(root.join(path)) else { continue };
        source_bytes += source.len() as u64;
        let base = live();
        reset_peak();
        let info = fallow_extract::parse_from_content(FileId(index as u32), &root.join(path), &source);
        let transient = peak().saturating_sub(base);
        worst_transient = worst_transient.max(transient);
        transient_sum += transient;
        drop(source);
        modules.push(info);
    }
    let retained = live() - before_all;
    let files = modules.len() as u64;
    let mut fields = serde_json::Map::new();
    macro_rules! field {
        ($($name:ident),* $(,)?) => {$(
            let before = live();
            for info in modules.iter_mut() { drop(std::mem::take(&mut info.$name)); }
            fields.insert(stringify!($name).to_owned(), serde_json::json!(before - live()));
        )*};
    }
    field!(
        exports, imports, re_exports, dynamic_imports, dynamic_import_patterns, require_calls,
        package_path_references, type_package_references, bin_path_references,
        package_resolve_sites, member_accesses, semantic_facts, whole_object_uses, suppressions,
        unknown_suppression_kinds, unused_import_bindings, type_referenced_import_bindings,
        value_referenced_import_bindings, line_offsets, complexity, flag_uses, class_heritage,
        exported_factory_returns, exported_factory_return_object_shapes, type_member_types,
        injection_tokens, local_type_declarations, public_signature_type_references,
        namespace_object_aliases, iconify_prefixes, iconify_icon_names, auto_import_candidates,
        directives, client_only_dynamic_import_spans, security_sinks,
        security_unresolved_callee_sites, tainted_bindings, sanitized_sink_args,
        security_control_sites, callee_uses
    );
    Ok(serde_json::json!({
        "files": files,
        "sourceBytes": source_bytes,
        "retainedBytes": retained,
        "retainedPerFile": retained / files.max(1),
        "transientPeakAvg": transient_sum / files.max(1),
        "transientPeakWorst": worst_transient,
        "afterFieldsBytes": live() - before_all,
        "fieldBytes": fields,
    }))
}
