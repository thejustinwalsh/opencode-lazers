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

mod project;
mod realpath;

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
        // The module never writes: no cache directory is created in the analysed tree.
        no_cache: true,
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

fn run(request: &Request) -> Outcome {
    let options: ApiOptions = if request.options.is_null() {
        ApiOptions::default()
    } else {
        serde_json::from_value(request.options.clone())
            .map_err(|error| failure("options-invalid", error.to_string()))?
    };
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
