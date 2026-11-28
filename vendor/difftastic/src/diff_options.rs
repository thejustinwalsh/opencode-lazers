#[derive(Debug, Clone)]
pub(crate) struct DiffOptions {
    pub(crate) graph_limit: usize,
    pub(crate) byte_limit: usize,
    pub(crate) parse_error_limit: usize,
    pub(crate) check_only: bool,
    pub(crate) ignore_comments: bool,
    pub(crate) strip_cr: bool,
}

impl Default for DiffOptions {
    fn default() -> Self {
        Self {
            graph_limit: 3_000_000,
            byte_limit: 1_000_000,
            parse_error_limit: 0,
            check_only: false,
            ignore_comments: false,
            strip_cr: false,
        }
    }
}
