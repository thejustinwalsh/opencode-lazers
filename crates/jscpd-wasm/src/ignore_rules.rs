use ignore::Match;
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct IgnoreFile {
    pub(super) path: String,
    pub(super) contents: String,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum IgnoreKind {
    Ignore,
    Gitignore,
    Exclude,
}

struct RuleFile {
    directory: PathBuf,
    kind: IgnoreKind,
    matcher: Gitignore,
}

pub(super) struct CapturedIgnoreFiles {
    rule_files: Vec<RuleFile>,
}

fn ignore_kind(path: &str) -> Option<(PathBuf, IgnoreKind)> {
    if path == ".git/info/exclude" {
        return Some((PathBuf::from("."), IgnoreKind::Exclude));
    }
    let path = Path::new(path);
    let name = path.file_name()?.to_str()?;
    let kind = match name {
        ".ignore" => IgnoreKind::Ignore,
        ".gitignore" => IgnoreKind::Gitignore,
        _ => return None,
    };
    Some((
        path.parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."))
            .to_path_buf(),
        kind,
    ))
}

fn compile_rule_file(file: &IgnoreFile) -> Option<RuleFile> {
    let (directory, kind) = ignore_kind(&file.path)?;
    let mut builder = GitignoreBuilder::new(&directory);
    for line in file.contents.lines() {
        let _ = builder.add_line(Some(PathBuf::from(&file.path)), line);
    }
    let matcher = builder.build().ok()?;
    Some(RuleFile {
        directory,
        kind,
        matcher,
    })
}

fn parents_nearest_first(path: &Path) -> Vec<PathBuf> {
    let mut parents = Vec::new();
    let mut parent = path.parent();
    while let Some(directory) = parent {
        if directory.as_os_str().is_empty() {
            parents.push(PathBuf::from("."));
            break;
        }
        parents.push(directory.to_path_buf());
        parent = directory.parent();
    }
    parents
}

fn decided_by(
    rule_files: &[RuleFile],
    directory: &Path,
    path: &Path,
    is_dir: bool,
    include_gitignore: bool,
) -> Option<bool> {
    for kind in [IgnoreKind::Ignore, IgnoreKind::Gitignore] {
        if kind == IgnoreKind::Gitignore && !include_gitignore {
            continue;
        }
        for rules in rule_files
            .iter()
            .filter(|rules| rules.directory == directory && rules.kind == kind)
        {
            match rules.matcher.matched(path, is_dir) {
                Match::Ignore(_) => return Some(true),
                Match::Whitelist(_) => return Some(false),
                Match::None => {}
            }
        }
    }
    None
}

impl CapturedIgnoreFiles {
    /// Compile only supplied rules; no source tree or ignore file is opened.
    pub(super) fn new(ignore_files: &[IgnoreFile]) -> Self {
        Self {
            rule_files: ignore_files.iter().filter_map(compile_rule_file).collect(),
        }
    }

    pub(super) fn ignores(&self, path: &str, no_gitignore: bool) -> bool {
        let components = Path::new(path).components().collect::<Vec<_>>();
        let mut entry = PathBuf::new();
        for (index, component) in components.iter().enumerate() {
            entry.push(component.as_os_str());
            let is_dir = index + 1 < components.len();
            let mut decision = None;
            for directory in parents_nearest_first(&entry) {
                if let Some(ignored) =
                    decided_by(&self.rule_files, &directory, &entry, is_dir, !no_gitignore)
                {
                    decision = Some(ignored);
                    break;
                }
            }
            if decision == Some(true) {
                return true;
            }
            if decision.is_none() && !no_gitignore {
                for rules in self
                    .rule_files
                    .iter()
                    .filter(|rules| rules.kind == IgnoreKind::Exclude)
                {
                    match rules.matcher.matched(&entry, is_dir) {
                        Match::Ignore(_) => return true,
                        Match::Whitelist(_) | Match::None => {}
                    }
                }
            }
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rules(files: &[(&str, &str)]) -> Vec<IgnoreFile> {
        files
            .iter()
            .map(|(path, contents)| IgnoreFile {
                path: (*path).to_string(),
                contents: (*contents).to_string(),
            })
            .collect()
    }

    #[test]
    fn nearest_nested_ignore_file_can_reinclude_a_file() {
        let captured = rules(&[
            (".gitignore", "src/*.ts\n"),
            ("src/.gitignore", "!keep.ts\n"),
        ]);
        let captured = CapturedIgnoreFiles::new(&captured);
        assert!(captured.ignores("src/drop.ts", false));
        assert!(!captured.ignores("src/keep.ts", false));
    }

    #[test]
    fn no_gitignore_keeps_ignore_files_but_skips_gitignore_and_exclude() {
        let captured = rules(&[
            (".ignore", "ignored-by-ignore.ts\n"),
            (".gitignore", "ignored-by-gitignore.ts\n"),
            (".git/info/exclude", "excluded.ts\n"),
        ]);
        let captured = CapturedIgnoreFiles::new(&captured);
        assert!(captured.ignores("ignored-by-ignore.ts", false));
        assert!(captured.ignores("ignored-by-ignore.ts", true));
        assert!(captured.ignores("ignored-by-gitignore.ts", false));
        assert!(!captured.ignores("ignored-by-gitignore.ts", true));
        assert!(captured.ignores("excluded.ts", false));
        assert!(!captured.ignores("excluded.ts", true));
    }
}
