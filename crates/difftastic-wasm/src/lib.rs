use std::slice;

#[no_mangle]
pub extern "C" fn alloc(length: u32) -> *mut u8 {
    Box::into_raw(vec![0_u8; length as usize].into_boxed_slice()) as *mut u8
}

#[no_mangle]
pub unsafe extern "C" fn dealloc(pointer: *mut u8, length: u32) {
    if !pointer.is_null() {
        drop(Box::from_raw(slice::from_raw_parts_mut(
            pointer,
            length as usize,
        )));
    }
}

/// Return the output pointer in the low 32 bits and its byte length in the high 32 bits.
#[no_mangle]
pub unsafe extern "C" fn compare(pointer: *const u8, length: u32) -> u64 {
    let input = slice::from_raw_parts(pointer, length as usize);
    let output = match difftastic::compare_json(input) {
        Ok(output) => output,
        Err(message) => serde_json::json!({ "error": { "message": message } }).to_string(),
    };
    let bytes = output.into_bytes().into_boxed_slice();
    let output_length = bytes.len() as u32;
    let output_pointer = Box::into_raw(bytes) as *mut u8 as u32;
    ((output_length as u64) << 32) | output_pointer as u64
}
