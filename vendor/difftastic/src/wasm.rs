use serde::Deserialize;

use crate::diff_options::DiffOptions;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    path: String,
    base: Option<String>,
    head: Option<String>,
    byte_limit: usize,
    graph_limit: usize,
    parse_error_limit: usize,
}

pub fn compare_json(input: &[u8]) -> Result<String, String> {
    let request: Request = serde_json::from_slice(input).map_err(|error| error.to_string())?;
    let base_present = request.base.is_some();
    let head_present = request.head.is_some();
    let mut base = request.base.unwrap_or_default();
    let mut head = request.head.unwrap_or_default();

    // Native diff_file() adds a final newline before diff_file_content().
    if !base.is_empty() && !base.ends_with('\n') {
        base.push('\n');
    }
    if !head.is_empty() && !head.ends_with('\n') {
        head.push('\n');
    }

    let guess_src = if head_present { &head } else { &base };
    let options = DiffOptions {
        graph_limit: request.graph_limit,
        byte_limit: request.byte_limit,
        parse_error_limit: request.parse_error_limit,
        check_only: false,
        ignore_comments: false,
        strip_cr: false,
    };
    let summary = crate::diff_file_content(
        &request.path,
        None,
        guess_src,
        &base,
        &head,
        3,
        &options,
        &[],
    );

    let serialized =
        crate::display::json::serialize(&summary).map_err(|error| error.to_string())?;
    let mut file: serde_json::Value =
        serde_json::from_str(&serialized).map_err(|error| error.to_string())?;
    if !base_present && head_present {
        file["status"] = serde_json::Value::String("created".to_owned());
    } else if base_present && !head_present {
        file["status"] = serde_json::Value::String("deleted".to_owned());
    }
    serde_json::to_string(&file).map_err(|error| error.to_string())
}
