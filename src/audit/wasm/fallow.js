/* @ts-self-types="./fallow.d.ts" */

export class Project {
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr
    this.__wbg_ptr = 0
    ProjectFinalization.unregister(this)
    return ptr
  }
  free() {
    const ptr = this.__destroy_into_raw()
    wasm.__wbg_project_free(ptr, 0)
  }
  /**
   * Functions over the configured complexity thresholds in `paths` (all files
   * when empty), worst first.
   * @param {string[]} paths
   * @returns {string}
   */
  complexity(paths) {
    let deferred2_0
    let deferred2_1
    try {
      const ptr0 = passArrayJsValueToWasm0(paths, wasm.__wbindgen_malloc)
      const len0 = WASM_VECTOR_LEN
      const ret = wasm.project_complexity(this.__wbg_ptr, ptr0, len0)
      deferred2_0 = ret[0]
      deferred2_1 = ret[1]
      return getStringFromWasm0(ret[0], ret[1])
    } finally {
      wasm.__wbindgen_free(deferred2_0, deferred2_1, 1)
    }
  }
  /**
   * Clone groups. With `changed` non-empty, only groups that touch a changed
   * path are reported; every file stays in the matching corpus.
   * @param {string[]} changed
   * @param {string} options_json
   * @returns {string}
   */
  duplication(changed, options_json) {
    let deferred3_0
    let deferred3_1
    try {
      let ptr0, len0, ptr1, len1
      try {
        ptr0 = passArrayJsValueToWasm0(changed, wasm.__wbindgen_malloc)
        len0 = WASM_VECTOR_LEN
        ptr1 = passStringToWasm0(options_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc)
        len1 = WASM_VECTOR_LEN
      } catch (e) {
        if (ptr1) {
          wasm.__wbindgen_free(ptr1, len1 * 1, 1)
        }
        if (ptr0) {
          wasm.__externref_drop_slice(ptr0, len0)
          wasm.__wbindgen_free(ptr0, len0 * 4, 4)
        }
        throw e
      }
      const ret = wasm.project_duplication(this.__wbg_ptr, ptr0, len0, ptr1, len1)
      deferred3_0 = ret[0]
      deferred3_1 = ret[1]
      return getStringFromWasm0(ret[0], ret[1])
    } finally {
      wasm.__wbindgen_free(deferred3_0, deferred3_1, 1)
    }
  }
  /**
   * Feature-flag uses the extractor recognises: environment variables with a
   * flag prefix, SDK calls and config-object reads. `paths` limits the files
   * (all files when empty).
   * @param {string[]} paths
   * @returns {string}
   */
  featureFlags(paths) {
    let deferred2_0
    let deferred2_1
    try {
      const ptr0 = passArrayJsValueToWasm0(paths, wasm.__wbindgen_malloc)
      const len0 = WASM_VECTOR_LEN
      const ret = wasm.project_featureFlags(this.__wbg_ptr, ptr0, len0)
      deferred2_0 = ret[0]
      deferred2_1 = ret[1]
      return getStringFromWasm0(ret[0], ret[1])
    } finally {
      wasm.__wbindgen_free(deferred2_0, deferred2_1, 1)
    }
  }
  /**
   * Number of analysable files after extension and ignore filtering.
   * @returns {number}
   */
  fileCount() {
    const ret = wasm.project_fileCount(this.__wbg_ptr)
    return ret >>> 0
  }
  /**
   * `paths` are relative to `root` and parallel to `contents`. `config_name`
   * selects the dialect by extension (`.json`, `.jsonc`, otherwise TOML).
   * @param {string} root
   * @param {string[]} paths
   * @param {string[]} contents
   * @param {string} config_name
   * @param {string} config_text
   */
  constructor(root, paths, contents, config_name, config_text) {
    let ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4
    try {
      ptr0 = passStringToWasm0(root, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc)
      len0 = WASM_VECTOR_LEN
      ptr1 = passArrayJsValueToWasm0(paths, wasm.__wbindgen_malloc)
      len1 = WASM_VECTOR_LEN
      ptr2 = passArrayJsValueToWasm0(contents, wasm.__wbindgen_malloc)
      len2 = WASM_VECTOR_LEN
      ptr3 = passStringToWasm0(config_name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc)
      len3 = WASM_VECTOR_LEN
      ptr4 = passStringToWasm0(config_text, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc)
      len4 = WASM_VECTOR_LEN
    } catch (e) {
      if (ptr4) {
        wasm.__wbindgen_free(ptr4, len4 * 1, 1)
      }
      if (ptr3) {
        wasm.__wbindgen_free(ptr3, len3 * 1, 1)
      }
      if (ptr2) {
        wasm.__externref_drop_slice(ptr2, len2)
        wasm.__wbindgen_free(ptr2, len2 * 4, 4)
      }
      if (ptr1) {
        wasm.__externref_drop_slice(ptr1, len1)
        wasm.__wbindgen_free(ptr1, len1 * 4, 4)
      }
      if (ptr0) {
        wasm.__wbindgen_free(ptr0, len0 * 1, 1)
      }
      throw e
    }
    const ret = wasm.project_new(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4)
    this.__wbg_ptr = ret
    ProjectFinalization.register(this, this.__wbg_ptr, this)
    return this
  }
}
if (Symbol.dispose) Project.prototype[Symbol.dispose] = Project.prototype.free

/**
 * Per-function cyclomatic and cognitive complexity for one file, as JSON.
 * @param {string} path
 * @param {string} content
 * @returns {string}
 */
export function complexity(path, content) {
  let deferred3_0
  let deferred3_1
  try {
    let ptr0, len0, ptr1, len1
    try {
      ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc)
      len0 = WASM_VECTOR_LEN
      ptr1 = passStringToWasm0(content, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc)
      len1 = WASM_VECTOR_LEN
    } catch (e) {
      if (ptr1) {
        wasm.__wbindgen_free(ptr1, len1 * 1, 1)
      }
      if (ptr0) {
        wasm.__wbindgen_free(ptr0, len0 * 1, 1)
      }
      throw e
    }
    const ret = wasm.complexity(ptr0, len0, ptr1, len1)
    deferred3_0 = ret[0]
    deferred3_1 = ret[1]
    return getStringFromWasm0(ret[0], ret[1])
  } finally {
    wasm.__wbindgen_free(deferred3_0, deferred3_1, 1)
  }
}

/**
 * Record a panic message before the abort so the host can read it after the
 * resulting `RuntimeError: unreachable`. No host import is involved.
 */
export function install_panic_hook() {
  wasm.install_panic_hook()
}

/**
 * The message of the last panic, or an empty string.
 * @returns {string}
 */
export function lastPanic() {
  let deferred1_0
  let deferred1_1
  try {
    const ret = wasm.lastPanic()
    deferred1_0 = ret[0]
    deferred1_1 = ret[1]
    return getStringFromWasm0(ret[0], ret[1])
  } finally {
    wasm.__wbindgen_free(deferred1_0, deferred1_1, 1)
  }
}

/**
 * Parse one file and return a JSON summary of its imports and exports.
 * @param {string} path
 * @param {string} content
 * @returns {string}
 */
export function parse(path, content) {
  let deferred3_0
  let deferred3_1
  try {
    let ptr0, len0, ptr1, len1
    try {
      ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc)
      len0 = WASM_VECTOR_LEN
      ptr1 = passStringToWasm0(content, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc)
      len1 = WASM_VECTOR_LEN
    } catch (e) {
      if (ptr1) {
        wasm.__wbindgen_free(ptr1, len1 * 1, 1)
      }
      if (ptr0) {
        wasm.__wbindgen_free(ptr0, len0 * 1, 1)
      }
      throw e
    }
    const ret = wasm.parse(ptr0, len0, ptr1, len1)
    deferred3_0 = ret[0]
    deferred3_1 = ret[1]
    return getStringFromWasm0(ret[0], ret[1])
  } finally {
    wasm.__wbindgen_free(deferred3_0, deferred3_1, 1)
  }
}
function __wbg_get_imports() {
  const import0 = {
    __proto__: null,
    __wbg___wbindgen_string_get_7ce8eee7fd327545: function (arg0, arg1) {
      const obj = arg1
      const ret = typeof obj === "string" ? obj : undefined
      var ptr1 = isLikeNone(ret)
        ? 0
        : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc)
      var len1 = WASM_VECTOR_LEN
      getDataViewMemory0().setInt32((arg0 >>> 0) + 4 * 1, len1, true)
      getDataViewMemory0().setInt32((arg0 >>> 0) + 4 * 0, ptr1, true)
    },
    __wbg___wbindgen_throw_4c88d8bf264fd984: function (arg0, arg1) {
      throw new Error(getStringFromWasm0(arg0, arg1))
    },
    __wbindgen_init_externref_table: function () {
      const table = wasm.__wbindgen_externrefs
      table.set(0, undefined)
      table.set(1024, undefined)
      table.set(1025, null)
      table.set(1026, true)
      table.set(1027, false)
    },
  }
  return {
    __proto__: null,
    "./fallow_bg.js": import0,
  }
}

const ProjectFinalization =
  typeof FinalizationRegistry === "undefined"
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry((ptr) => wasm.__wbg_project_free(ptr, 1))

function addToExternrefTable0(obj) {
  const idx = wasm.__externref_table_alloc()
  wasm.__wbindgen_externrefs.set(idx, obj)
  return idx
}

let cachedDataViewMemory0 = null
function getDataViewMemory0() {
  if (
    cachedDataViewMemory0 === null ||
    cachedDataViewMemory0.buffer.detached === true ||
    (cachedDataViewMemory0.buffer.detached === undefined &&
      cachedDataViewMemory0.buffer !== wasm.memory.buffer)
  ) {
    cachedDataViewMemory0 = new DataView(wasm.memory.buffer)
  }
  return cachedDataViewMemory0
}

function getStringFromWasm0(ptr, len) {
  ptr = ptr >>> 0
  return decodeText(getUint8ArrayMemory0().subarray(ptr, ptr + len))
}

let cachedUint8ArrayMemory0 = null
function getUint8ArrayMemory0() {
  if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
    cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer)
  }
  return cachedUint8ArrayMemory0
}

function isLikeNone(x) {
  return x === undefined || x === null
}

function passArrayJsValueToWasm0(array, malloc) {
  const ptr = malloc(array.length * 4, 4) >>> 0
  for (let i = 0; i < array.length; i++) {
    const add = addToExternrefTable0(array[i])
    getDataViewMemory0().setUint32(ptr + 4 * i, add, true)
  }
  WASM_VECTOR_LEN = array.length
  return ptr
}

function passStringToWasm0(arg, malloc, realloc) {
  if (realloc === undefined) {
    const buf = cachedTextEncoder.encode(arg)
    const ptr = malloc(buf.length, 1) >>> 0
    getUint8ArrayMemory0()
      .subarray(ptr, ptr + buf.length)
      .set(buf)
    WASM_VECTOR_LEN = buf.length
    return ptr
  }

  let len = arg.length
  let ptr = malloc(len, 1) >>> 0

  const mem = getUint8ArrayMemory0()

  let offset = 0

  for (; offset < len; offset++) {
    const code = arg.charCodeAt(offset)
    if (code > 0x7f) break
    mem[ptr + offset] = code
  }
  if (offset !== len) {
    if (offset !== 0) {
      arg = arg.slice(offset)
    }
    ptr = realloc(ptr, len, (len = offset + arg.length * 3), 1) >>> 0
    const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len)
    const ret = cachedTextEncoder.encodeInto(arg, view)

    offset += ret.written
    ptr = realloc(ptr, len, offset, 1) >>> 0
  }

  WASM_VECTOR_LEN = offset
  return ptr
}

let cachedTextDecoder = new TextDecoder("utf-8", { ignoreBOM: true })
cachedTextDecoder.decode()
const MAX_SAFARI_DECODE_BYTES = 2146435072
let numBytesDecoded = 0
function decodeText(bytes) {
  numBytesDecoded += bytes.length
  if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
    cachedTextDecoder = new TextDecoder("utf-8", { ignoreBOM: true })
    cachedTextDecoder.decode()
    numBytesDecoded = bytes.length
  }
  return cachedTextDecoder.decode(bytes)
}

const cachedTextEncoder = new TextEncoder()

if (!("encodeInto" in cachedTextEncoder)) {
  cachedTextEncoder.encodeInto = function (arg, view) {
    const buf = cachedTextEncoder.encode(arg)
    view.set(buf)
    return {
      read: arg.length,
      written: buf.length,
    }
  }
}

let WASM_VECTOR_LEN = 0

let wasmModule, wasmInstance, wasm
function __wbg_finalize_init(instance, module) {
  wasmInstance = instance
  wasm = instance.exports
  wasmModule = module
  cachedDataViewMemory0 = null
  cachedUint8ArrayMemory0 = null
  wasm.__wbindgen_start()
  return wasm
}

async function __wbg_load(module, imports) {
  if (typeof Response === "function" && module instanceof Response) {
    if (!module.ok) {
      throw new Error(
        `failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`,
      )
    }

    if (typeof WebAssembly.instantiateStreaming === "function") {
      try {
        return await WebAssembly.instantiateStreaming(module, imports)
      } catch (e) {
        const validResponse = expectedResponseType(module.type)

        if (validResponse && module.headers.get("Content-Type") !== "application/wasm") {
          console.warn(
            "`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n",
            e,
          )
        } else {
          throw e
        }
      }
    }

    const bytes = await module.arrayBuffer()
    return await WebAssembly.instantiate(bytes, imports)
  } else {
    const instance = await WebAssembly.instantiate(module, imports)

    if (instance instanceof WebAssembly.Instance) {
      return { instance, module }
    } else {
      return instance
    }
  }

  function expectedResponseType(type) {
    switch (type) {
      case "basic":
      case "cors":
      case "default":
        return true
    }
    return false
  }
}

function initSync(module) {
  if (wasm !== undefined) return wasm

  if (module !== undefined) {
    if (Object.getPrototypeOf(module) === Object.prototype) {
      ;({ module } = module)
    } else {
      console.warn("using deprecated parameters for `initSync()`; pass a single object instead")
    }
  }

  const imports = __wbg_get_imports()
  if (!(module instanceof WebAssembly.Module)) {
    module = new WebAssembly.Module(module)
  }
  const instance = new WebAssembly.Instance(module, imports)
  return __wbg_finalize_init(instance, module)
}

let __wbg_init_promise
async function __wbg_init(module_or_path) {
  if (wasm !== undefined) return wasm
  if (__wbg_init_promise === undefined) {
    __wbg_init_promise = __wbg_init_once(module_or_path)
    __wbg_init_promise.catch(() => {
      __wbg_init_promise = undefined
    })
  }
  return __wbg_init_promise
}

async function __wbg_init_once(module_or_path) {
  if (module_or_path !== undefined) {
    if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
      ;({ module_or_path } = module_or_path)
    } else {
      console.warn(
        "using deprecated parameters for the initialization function; pass a single object instead",
      )
    }
  }

  if (module_or_path === undefined) {
    module_or_path = new URL("fallow.wasm", import.meta.url)
  }
  const imports = __wbg_get_imports()

  if (
    typeof module_or_path === "string" ||
    (typeof Request === "function" && module_or_path instanceof Request) ||
    (typeof URL === "function" && module_or_path instanceof URL)
  ) {
    module_or_path = fetch(module_or_path)
  }

  const { instance, module } = await __wbg_load(await module_or_path, imports)

  return __wbg_finalize_init(instance, module)
}

export { initSync, __wbg_init as default }
