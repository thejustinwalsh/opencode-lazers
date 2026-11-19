//! `git` process types the engine uses, with a host-call stand-in on WASI.
//!
//! Native targets re-export `std::process`. WASI preview 1 cannot spawn a process, so
//! `Command::output` and `status` hand the request to the embedding host, which decides whether
//! to run `git` (the `lazers_host.git_run` import) and returns the exit code and captured
//! output. A host that does not provide the import makes every call fail with
//! `Unsupported`, which callers already treat as "git is not available". `spawn` (a long-lived
//! piped child) is never available.

#[cfg(not(target_os = "wasi"))]
pub use std::process::{Child, ChildStdin, ChildStdout, Command, ExitStatus, Output, Stdio};

#[cfg(target_os = "wasi")]
pub use wasi::{Child, ChildStdin, ChildStdout, Command, ExitStatus, Output, Stdio};

/// Run `command` to completion with captured output, through the signal-aware child registry
/// where processes exist.
#[cfg(not(target_os = "wasi"))]
pub fn output(command: &mut Command) -> std::io::Result<Output> {
    fallow_process::output(command)
}

#[cfg(target_os = "wasi")]
pub fn output(command: &mut Command) -> std::io::Result<Output> {
    command.output()
}

#[cfg(target_os = "wasi")]
mod wasi {
    use std::ffi::{OsStr, OsString};
    use std::io;
    use std::path::{Path, PathBuf};

    #[link(wasm_import_module = "lazers_host")]
    unsafe extern "C" {
        /// Runs the request (UTF-8 JSON) and returns the byte length of the result, or a
        /// negative number when the host refused or failed.
        fn git_run(request: *const u8, length: usize) -> i32;
        /// Copies the pending result into `destination`.
        fn git_result(destination: *mut u8, capacity: usize) -> i32;
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub struct ExitStatus(i32);

    impl ExitStatus {
        #[must_use]
        pub fn success(&self) -> bool {
            self.0 == 0
        }
        #[must_use]
        pub fn code(&self) -> Option<i32> {
            Some(self.0)
        }
    }

    impl std::fmt::Display for ExitStatus {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "exit status: {}", self.0)
        }
    }

    #[derive(Debug)]
    pub struct Output {
        pub status: ExitStatus,
        pub stdout: Vec<u8>,
        pub stderr: Vec<u8>,
    }

    #[derive(Clone, Copy, Debug)]
    pub struct Stdio;

    impl Stdio {
        #[must_use]
        pub fn null() -> Self {
            Self
        }
        #[must_use]
        pub fn piped() -> Self {
            Self
        }
        #[must_use]
        pub fn inherit() -> Self {
            Self
        }
    }

    pub struct Child {
        pub stdin: Option<ChildStdin>,
        pub stdout: Option<ChildStdout>,
    }

    impl Child {
        pub fn kill(&mut self) -> io::Result<()> {
            Ok(())
        }
        pub fn wait(&mut self) -> io::Result<ExitStatus> {
            Err(unsupported())
        }
    }

    pub struct ChildStdin;
    pub struct ChildStdout;

    impl io::Write for ChildStdin {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Err(unsupported())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl io::Read for ChildStdout {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            Err(unsupported())
        }
    }

    fn unsupported() -> io::Error {
        io::Error::new(io::ErrorKind::Unsupported, "git is not available to this module")
    }

    pub struct Command {
        program: OsString,
        args: Vec<OsString>,
        cwd: Option<PathBuf>,
        env: Vec<(OsString, Option<OsString>)>,
    }

    impl Command {
        pub fn new(program: impl AsRef<OsStr>) -> Self {
            Self {
                program: program.as_ref().to_owned(),
                args: Vec::new(),
                cwd: None,
                env: Vec::new(),
            }
        }
        pub fn arg(&mut self, arg: impl AsRef<OsStr>) -> &mut Self {
            self.args.push(arg.as_ref().to_owned());
            self
        }
        pub fn args<I, S>(&mut self, args: I) -> &mut Self
        where
            I: IntoIterator<Item = S>,
            S: AsRef<OsStr>,
        {
            for arg in args {
                self.arg(arg);
            }
            self
        }
        pub fn current_dir(&mut self, dir: impl AsRef<Path>) -> &mut Self {
            self.cwd = Some(dir.as_ref().to_owned());
            self
        }
        pub fn env(&mut self, key: impl AsRef<OsStr>, value: impl AsRef<OsStr>) -> &mut Self {
            self.env
                .push((key.as_ref().to_owned(), Some(value.as_ref().to_owned())));
            self
        }
        pub fn env_remove(&mut self, key: impl AsRef<OsStr>) -> &mut Self {
            self.env.push((key.as_ref().to_owned(), None));
            self
        }
        pub fn stdin(&mut self, _: impl Into<Stdio>) -> &mut Self {
            self
        }
        pub fn stdout(&mut self, _: impl Into<Stdio>) -> &mut Self {
            self
        }
        pub fn stderr(&mut self, _: impl Into<Stdio>) -> &mut Self {
            self
        }
        pub fn spawn(&mut self) -> io::Result<Child> {
            Err(unsupported())
        }

        pub fn status(&mut self) -> io::Result<ExitStatus> {
            self.output().map(|output| output.status)
        }

        pub fn output(&mut self) -> io::Result<Output> {
            if self.program != "git" {
                return Err(unsupported());
            }
            let request = serde_json::json!({
                "cwd": self.cwd.as_deref().map(|path| path.to_string_lossy().into_owned()),
                "args": self.args.iter().map(|arg| arg.to_string_lossy().into_owned()).collect::<Vec<_>>(),
                "env": self
                    .env
                    .iter()
                    .map(|(key, value)| (
                        key.to_string_lossy().into_owned(),
                        value.as_ref().map(|value| value.to_string_lossy().into_owned()),
                    ))
                    .collect::<std::collections::BTreeMap<_, _>>(),
            })
            .to_string();
            let length = unsafe { git_run(request.as_ptr(), request.len()) };
            if length < 0 {
                return Err(unsupported());
            }
            let mut buffer = vec![0u8; length as usize];
            let copied = unsafe { git_result(buffer.as_mut_ptr(), buffer.len()) };
            if copied != length || buffer.len() < 8 {
                return Err(io::Error::other("git host call returned a malformed result"));
            }
            // Layout: i32 exit code, u32 stdout length, stdout, stderr.
            let code = i32::from_le_bytes(buffer[0..4].try_into().unwrap_or([0; 4]));
            let stdout_length = u32::from_le_bytes(buffer[4..8].try_into().unwrap_or([0; 4])) as usize;
            let stdout_end = (8 + stdout_length).min(buffer.len());
            Ok(Output {
                status: ExitStatus(code),
                stdout: buffer[8..stdout_end].to_vec(),
                stderr: buffer[stdout_end..].to_vec(),
            })
        }
    }
}
