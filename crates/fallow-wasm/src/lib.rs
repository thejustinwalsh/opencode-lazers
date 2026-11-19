//! Fallow analysis as a WebAssembly module with explicit host inputs.
//!
//! The module has no filesystem, network, process or Git access. The host
//! passes paths, file contents, the changed-file set and config text in, and
//! receives JSON back. Every call returns an envelope: `{"ok":true,...}` or
//! `{"error":{"code":"...","message":"..."}}`.

use fallow_types::discover::FileId;
use serde::Serialize;
use std::path::Path;
use wasm_bindgen::prelude::*;

mod entropy;
mod project;

pub use project::Project;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FunctionMetrics<'a> {
    name: &'a str,
    line: u32,
    col: u32,
    cyclomatic: u16,
    cognitive: u16,
    line_count: u32,
    param_count: u8,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ParseSummary {
    imports: Vec<String>,
    exports: Vec<String>,
    parse_error_count: u32,
    parse_panicked: bool,
    function_count: usize,
}

fn module(path: &str, content: &str) -> fallow_types::extract::ModuleInfo {
    fallow_extract::parse_from_content(FileId(0), Path::new(path), content)
}

pub(crate) fn to_json<T: Serialize>(value: &T) -> String {
    serde_json::to_string(value)
        .unwrap_or_else(|error| format!("{{\"error\":{{\"code\":\"serialize\",\"message\":\"{error}\"}}}}"))
}

/// Parse one file and return a JSON summary of its imports and exports.
#[wasm_bindgen]
pub fn parse(path: &str, content: &str) -> String {
    let info = module(path, content);
    to_json(&ParseSummary {
        imports: info.imports.iter().map(|import| import.source.clone()).collect(),
        exports: info
            .exports
            .iter()
            .map(|export| match &export.name {
                fallow_types::extract::ExportName::Named(name) => name.clone(),
                fallow_types::extract::ExportName::Default => "default".to_owned(),
            })
            .collect(),
        parse_error_count: info.parse_error_count,
        parse_panicked: info.parse_panicked,
        function_count: info.complexity.len(),
    })
}

/// Per-function cyclomatic and cognitive complexity for one file, as JSON.
#[wasm_bindgen]
pub fn complexity(path: &str, content: &str) -> String {
    let info = module(path, content);
    let rows: Vec<FunctionMetrics<'_>> = info
        .complexity
        .iter()
        .map(|function| FunctionMetrics {
            name: &function.name,
            line: function.line,
            col: function.col,
            cyclomatic: function.cyclomatic,
            cognitive: function.cognitive,
            line_count: function.line_count,
            param_count: function.param_count,
        })
        .collect();
    to_json(&rows)
}

thread_local! {
    static LAST_PANIC: std::cell::RefCell<String> = const { std::cell::RefCell::new(String::new()) };
}

/// Record a panic message before the abort so the host can read it after the
/// resulting `RuntimeError: unreachable`. No host import is involved.
#[wasm_bindgen(start)]
pub fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        LAST_PANIC.with(|slot| *slot.borrow_mut() = info.to_string());
    }));
}

/// The message of the last panic, or an empty string.
#[wasm_bindgen(js_name = lastPanic)]
pub fn last_panic() -> String {
    LAST_PANIC.with(|slot| slot.borrow().clone())
}
