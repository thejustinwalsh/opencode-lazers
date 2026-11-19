//! Fallow analysis as a WebAssembly module with explicit host inputs.
//!
//! The module has no filesystem, network, process or Git access. The host
//! passes paths and contents in and receives JSON back.

use fallow_types::discover::FileId;
use serde::Serialize;
use std::path::Path;
use wasm_bindgen::prelude::*;

mod entropy;

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

fn to_json<T: Serialize>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_else(|error| format!("{{\"error\":\"{error}\"}}"))
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
