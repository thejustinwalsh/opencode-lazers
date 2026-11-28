use std::io::{self, Read};
use std::path::Path;

use cccc_core::report::FileReport;
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
struct Request {
    files: Vec<SourceFile>,
}

#[derive(Deserialize)]
struct SourceFile {
    side: String,
    path: String,
    source: String,
}

#[derive(Serialize)]
struct FileOutput {
    side: String,
    language: &'static str,
    report: FileReport,
}

#[derive(Serialize)]
struct Response {
    reports: Vec<FileOutput>,
}

fn analyze(file: SourceFile) -> Option<FileOutput> {
    let extension = Path::new(&file.path)
        .extension()
        .and_then(|value| value.to_str())?
        .to_ascii_lowercase();
    let path = Path::new(&file.path);
    let source = file.source.as_str();
    let (language, report) = match extension.as_str() {
        "ts" | "tsx" | "mts" | "cts" => ("typescript", cccc_es::analyze_source(path, source)),
        "js" | "jsx" | "mjs" | "cjs" => ("javascript", cccc_es::analyze_source(path, source)),
        "rs" => ("rust", cccc_rs::analyze_source(path, source)),
        "go" => ("go", cccc_go::analyze_source(path, source)),
        "php" => ("php", cccc_php::analyze_source(path, source)),
        "rb" => ("ruby", cccc_rb::analyze_source(path, source)),
        "scm" | "ss" | "sld" => ("scheme", cccc_scheme::analyze_source(path, source)),
        "rkt" | "rktl" | "rktd" => ("racket", cccc_scheme::analyze_source(path, source)),
        "lisp" | "lsp" | "cl" => (
            "commonlisp",
            cccc_lisp::commonlisp::analyze_source(path, source),
        ),
        "el" => (
            "emacslisp",
            cccc_lisp::emacslisp::analyze_source(path, source),
        ),
        "clj" | "cljs" | "cljc" => ("clojure", cccc_clojure::analyze_source(path, source)),
        "kt" | "kts" => ("kotlin", cccc_kt::analyze_source(path, source)),
        "py" | "pyi" => ("python", cccc_py::analyze_source(path, source)),
        "zig" => ("zig", cccc_zig::analyze_source(path, source)),
        "c" | "h" => ("c", cccc_c::analyze_source(path, source)),
        "cpp" | "cc" | "cxx" | "hpp" | "hh" | "hxx" | "h++" | "tpp" | "ipp" => {
            ("cpp", cccc_cpp::analyze_source(path, source))
        }
        "pl" | "pm" | "t" => ("perl", cccc_pl::analyze_source(path, source)),
        "swift" => ("swift", cccc_swift::analyze_source(path, source)),
        "java" => ("java", cccc_java::analyze_source(path, source)),
        "dart" => ("dart", cccc_dart::analyze_source(path, source)),
        "scala" | "sc" => ("scala", cccc_scala::analyze_source(path, source)),
        _ => return None,
    };
    Some(FileOutput {
        side: file.side,
        language,
        report,
    })
}

fn main() {
    let mut input = Vec::new();
    if io::stdin().read_to_end(&mut input).is_err() {
        std::process::exit(2);
    }
    let Ok(request) = serde_json::from_slice::<Request>(&input) else {
        std::process::exit(2);
    };
    let response = Response {
        reports: request.files.into_iter().filter_map(analyze).collect(),
    };
    if serde_json::to_writer(io::stdout().lock(), &response).is_err() {
        std::process::exit(2);
    }
}
