//! `realpath` for WASI preview 1.
//!
//! Rust's `fs::canonicalize` calls libc `realpath`. wasi-libc's version fails on every path with
//! `ENOENT` here (its relative-path model has no working directory), and the vendored crates call
//! `canonicalize` at roughly 400 sites, among them root validation and symlinked dependency
//! resolution. Defining the symbol in this crate makes the linker use this one instead of the
//! archive member. It resolves every symlink with `read_link` and `symlink_metadata`, which are
//! plain WASI path calls confined to the preopened directories.

use std::collections::VecDeque;
use std::ffi::{CStr, OsStr, OsString, c_char, c_int, c_void};
use std::io;
use std::os::wasi::ffi::{OsStrExt, OsStringExt};
use std::path::{Component, Path, PathBuf};

unsafe extern "C" {
    fn malloc(size: usize) -> *mut c_void;
    fn __errno_location() -> *mut c_int;
}

const MAX_LINKS: usize = 40;
const PATH_MAX: usize = 4096;

fn resolve(path: &Path) -> io::Result<PathBuf> {
    let mut pending: VecDeque<OsString> = VecDeque::new();
    let mut out = PathBuf::from("/");
    let mut links = 0usize;
    let queue = |path: &Path, pending: &mut VecDeque<OsString>, out: &mut PathBuf| {
        let mut front: Vec<OsString> = Vec::new();
        for component in path.components() {
            match component {
                Component::RootDir | Component::Prefix(_) => {
                    front.clear();
                    *out = PathBuf::from("/");
                    front.push(OsString::from("/"));
                }
                Component::CurDir => {}
                Component::ParentDir => front.push(OsString::from("..")),
                Component::Normal(name) => front.push(name.to_os_string()),
            }
        }
        for component in front.into_iter().rev() {
            pending.push_front(component);
        }
    };
    queue(path, &mut pending, &mut out);
    while let Some(component) = pending.pop_front() {
        if component == OsStr::new("/") {
            out = PathBuf::from("/");
            continue;
        }
        if component == OsStr::new("..") {
            out.pop();
            continue;
        }
        let candidate = out.join(&component);
        let metadata = match std::fs::symlink_metadata(&candidate) {
            Ok(metadata) => metadata,
            // Ancestors of a preopened directory are not visible to the guest. They are plain
            // directories as far as resolution goes; the last component must exist.
            Err(_) if !pending.is_empty() => {
                out = candidate;
                continue;
            }
            Err(error) => return Err(error),
        };
        if metadata.file_type().is_symlink() {
            links += 1;
            if links > MAX_LINKS {
                return Err(io::Error::from_raw_os_error(32));
            }
            let target = std::fs::read_link(&candidate)?;
            queue(&target, &mut pending, &mut out);
        } else {
            out = candidate;
        }
    }
    Ok(out)
}

fn set_errno(error: &io::Error) {
    // WASI errno 44 is ENOENT in wasi-libc's numbering.
    unsafe { *__errno_location() = error.raw_os_error().unwrap_or(44) };
}

/// # Safety
/// `path` is a NUL-terminated string; `resolved` is null or a buffer of at least `PATH_MAX` bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn realpath(path: *const c_char, resolved: *mut c_char) -> *mut c_char {
    if path.is_null() {
        unsafe { *__errno_location() = 28 };
        return std::ptr::null_mut();
    }
    let bytes = unsafe { CStr::from_ptr(path) }.to_bytes();
    let input = PathBuf::from(OsString::from_vec(bytes.to_vec()));
    let resolved_path = match resolve(&input) {
        Ok(path) => path,
        Err(error) => {
            set_errno(&error);
            return std::ptr::null_mut();
        }
    };
    let bytes = resolved_path.as_os_str().as_bytes();
    if bytes.len() >= PATH_MAX {
        unsafe { *__errno_location() = 37 };
        return std::ptr::null_mut();
    }
    let buffer = if resolved.is_null() {
        unsafe { malloc(bytes.len() + 1) }.cast::<c_char>()
    } else {
        resolved
    };
    if buffer.is_null() {
        unsafe { *__errno_location() = 48 };
        return std::ptr::null_mut();
    }
    unsafe {
        std::ptr::copy_nonoverlapping(bytes.as_ptr().cast::<c_char>(), buffer, bytes.len());
        *buffer.add(bytes.len()) = 0;
    }
    buffer
}
