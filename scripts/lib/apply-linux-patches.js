#!/usr/bin/env node
/**
 * Patch main/index.js inside a WorkBuddy app.asar so it runs on Linux.
 *
 * Fixes applied:
 *   1. Prelude shim: hide ACC_PRODUCT_CONFIG_V3 / _V2 from libc's
 *      environ so Chromium's internal /proc/self/exe spawn for the
 *      network/GPU/utility services doesn't fail with E2BIG.
 *
 *   2. Attach the tray context menu via setContextMenu() on Linux so
 *      the libayatana-appindicator backend renders the right-click
 *      menu (the AppIndicator never emits the click/right-click events
 *      upstream relies on).
 *
 *   3. Construct the Linux Tray from an on-disk PNG path (the
 *      .workbuddy-linux/workbuddy.png file written by install.sh)
 *      instead of a resized in-memory NativeImage — AppIndicator on
 *      Mint/Cinnamon otherwise renders a missing-image placeholder.
 *
 *   4. Disable the "Check for Updates..." menu entry and stub out the
 *      update* RPC handlers. The upstream updater drives the macOS
 *      ShipIt / Windows Squirrel installers, neither of which applies
 *      on a Linux port.
 *
 *   5. (in the env shim) Monkey-patch child_process.spawn/spawnSync
 *      to spill oversized env entries (ACC_PRODUCT_CONFIG_V3 / _V2)
 *      to a private temp file and replace them with a *_FILE pointer.
 *      The sidecar-entry.js shim reads the file back and re-injects
 *      the value via the same Proxy so the sidecar still sees the
 *      full JSON. This eliminates the spawn E2BIG that previously
 *      broke sidecar startup and plugin marketplace updates.
 *
 * The script operates directly on an app.asar file. It extracts it to a
 * temp directory, edits main/index.js + main/sidecar-entry.js, and
 * repacks the asar while preserving the original unpacked=true set.
 *
 * Usage:
 *   node apply-linux-patches.js <path/to/app.asar> <marker>
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const asar = require('@electron/asar');

const [, , asarPath, marker, lydellPlatformPackage] = process.argv;
if (!asarPath || !marker || !lydellPlatformPackage) {
    console.error('Usage: apply-linux-patches.js <path/to/app.asar> <marker> <@lydell/node-pty-linux-arch>');
    process.exit(2);
}

if (!/^@lydell\/node-pty-linux-(x64|arm64)$/.test(lydellPlatformPackage)) {
    console.error('[apply-linux-patches] ERROR: unsupported @lydell platform package: ' + lydellPlatformPackage);
    process.exit(2);
}

function log(msg) { console.log('  [apply-linux-patches] ' + msg); }

const patchReport = {
    marker,
    lydellPlatformPackage,
    required: {},
    optional: {},
};

function markRequired(name, ok) {
    patchReport.required[name] = Boolean(ok);
}

function markOptional(name, ok) {
    patchReport.optional[name] = Boolean(ok);
}

function assertRequiredPatches() {
    const failed = Object.entries(patchReport.required)
        .filter(([, ok]) => !ok)
        .map(([name]) => name);
    if (failed.length > 0) {
        if (process.env.WB_SKIP_REQUIRED_PATCHES === '1') {
            console.error('[apply-linux-patches] WARN: WB_SKIP_REQUIRED_PATCHES=1, continuing despite missing required patches: ' + failed.join(', '));
            return;
        }
        console.error('[apply-linux-patches] ERROR: required patches failed: ' + failed.join(', '));
        process.exit(7);
    }
}

// ---------------------------------------------------------------------------
// 1. Extract the asar into a temp dir. We pull file contents straight from
//    asar.extractFile() instead of relying on the CLI so that:
//      (a) we don't depend on the CLI sniffing the sibling .unpacked dir,
//      (b) we can reliably recover the exact bytes for every entry.
//    Unpacked entries are copied from the sibling <asar>.unpacked/ dir.
// ---------------------------------------------------------------------------
if (!fs.existsSync(asarPath)) {
    console.error('[apply-linux-patches] ERROR: asar file not found: ' + asarPath);
    process.exit(2);
}
const { header } = asar.getRawHeader(asarPath);
const unpackedSiblingDir = asarPath + '.unpacked';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-asar-patch-'));
process.on('exit', () => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

// ---------------------------------------------------------------------------
// Walk the header, collect every file's metadata, and write the bytes to
// the temp dir. Also accumulate the "unpacked" set for later.
// ---------------------------------------------------------------------------
const unpackedFiles = [];
function safeExtractPath(rel) {
    if (!rel || path.isAbsolute(rel) || rel.split('/').includes('..')) {
        throw new Error('unsafe asar entry path: ' + rel);
    }
    const abs = path.resolve(tmpDir, rel);
    const root = path.resolve(tmpDir) + path.sep;
    if (abs !== path.resolve(tmpDir) && !abs.startsWith(root)) {
        throw new Error('asar entry escapes temp dir: ' + rel);
    }
    return abs;
}

function walk(node, prefix) {
    if (!node.files) return;
    for (const [name, entry] of Object.entries(node.files)) {
        const rel = prefix ? prefix + '/' + name : name;
        const abs = safeExtractPath(rel);
        if (entry.files) {
            fs.mkdirSync(abs, { recursive: true });
            walk(entry, rel);
        } else if (entry.link) {
            // Symlink entries — extractFile can't give us the target, so
            // we just recreate them directly.
            try {
                fs.mkdirSync(path.dirname(abs), { recursive: true });
                fs.symlinkSync(entry.link, abs);
            } catch (err) {
                console.warn('  [apply-linux-patches] skipped symlink ' + rel + ': ' + err.message);
            }
        } else {
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            if (entry.unpacked) {
                unpackedFiles.push(rel);
                const src = path.join(unpackedSiblingDir, rel);
                if (fs.existsSync(src)) {
                    fs.copyFileSync(src, abs);
                    const stat = fs.statSync(src);
                    fs.chmodSync(abs, stat.mode & 0o777);
                } else {
                    // Unpacked file missing from sibling dir — write an empty
                    // placeholder so the header can still reference it. This
                    // path is only hit if someone has deleted files from
                    // app.asar.unpacked/ between build and patch.
                    fs.writeFileSync(abs, Buffer.alloc(0));
                    console.warn('  [apply-linux-patches] missing unpacked file: ' + rel);
                }
            } else {
                const buf = asar.extractFile(asarPath, rel);
                fs.writeFileSync(abs, buf);
                if (entry.executable) {
                    fs.chmodSync(abs, 0o755);
                }
            }
        }
    }
}
walk(header, '');
log('Extracted ' + unpackedFiles.length + ' unpacked + packed entries to temp dir');

// ---------------------------------------------------------------------------
// 2. Apply the two source patches to main/index.js.
// ---------------------------------------------------------------------------
const indexPath = path.join(tmpDir, 'main', 'index.js');
if (!fs.existsSync(indexPath)) {
    console.error('[apply-linux-patches] ERROR: main/index.js missing in asar');
    process.exit(3);
}

let source = fs.readFileSync(indexPath, 'utf8');

const SHIM_BODY = `// ${marker} — WorkBuddy Linux runtime patches (env + tray + compose timeout)
(function wbLinuxEnvShim() {
  if (process.platform !== "linux") return;
  try {
    // ---------------------------------------------------------------
    // Part A: keep the oversized product-config JSON out of libc
    // environ so Chromium's own execvp("/proc/self/exe") for network,
    // GPU and utility subprocesses doesn't fail with E2BIG.
    //
    // We replace process.env with a Proxy that stores the two hidden
    // keys in a private JS slot, hides them from every enumeration
    // path (has/ownKeys/getOwnPropertyDescriptor), and returns them
    // only via direct property access. Node's child_process spawn
    // enumerates process.env to build the child environment, so the
    // oversized string never lands in the child's argv block either.
    // ---------------------------------------------------------------
    var HIDDEN = new Set(["ACC_PRODUCT_CONFIG_V3", "ACC_PRODUCT_CONFIG_V2"]);
    var real = process.env;
    var store = Object.create(null);
    HIDDEN.forEach(function (key) {
      if (typeof real[key] === "string") {
        store[key] = real[key];
        try { delete real[key]; } catch (_) {}
      }
    });
    var proxy = new Proxy(real, {
      get: function (target, prop) {
        if (typeof prop === "string" && HIDDEN.has(prop)) return store[prop];
        return Reflect.get(target, prop);
      },
      set: function (target, prop, value) {
        if (typeof prop === "string" && HIDDEN.has(prop)) {
          store[prop] = value == null ? undefined : String(value);
          try { delete target[prop]; } catch (_) {}
          return true;
        }
        return Reflect.set(target, prop, value);
      },
      deleteProperty: function (target, prop) {
        if (typeof prop === "string" && HIDDEN.has(prop)) {
          delete store[prop];
          try { delete target[prop]; } catch (_) {}
          return true;
        }
        return Reflect.deleteProperty(target, prop);
      },
      has: function (target, prop) { return Reflect.has(target, prop); },
      ownKeys: function (target) { return Reflect.ownKeys(target); },
      getOwnPropertyDescriptor: function (target, prop) {
        return Reflect.getOwnPropertyDescriptor(target, prop);
      }
    });
    Object.defineProperty(process, "env", {
      value: proxy,
      writable: true,
      configurable: true,
      enumerable: true
    });

    // ---------------------------------------------------------------
    // Part B: sidecar spawn E2BIG workaround.
    //
    // Upstream assigns the same ~260KB JSON into the env object it
    // passes to child_process.spawn (see SidecarManager.spawnSidecar
    // and related CLI helpers). Even though Part A keeps the value
    // off libc environ for the main process, spawn() still stuffs it
    // into the argv block of the new process, where MAX_ARG_STRLEN
    // rejects any single 128KB+ entry with E2BIG.
    //
    // We monkey-patch child_process.spawn / spawnSync so that any
    // env entry named ACC_PRODUCT_CONFIG_V3 / _V2 whose value is
    // larger than 100KB is spilled to a private temp file and
    // replaced in the child's env with ACC_PRODUCT_CONFIG_V3_FILE.
    // The sidecar-entry.js shim reads that file back and re-injects
    // the value via a matching Proxy so downstream code sees the
    // same process.env.ACC_PRODUCT_CONFIG_V3 string.
    // ---------------------------------------------------------------
    var cp = require("child_process");
    var fsMod = require("fs");
    var osMod = require("os");
    var pathMod = require("path");
    var cryptoMod = require("crypto");
    var SPILL_KEYS = ["ACC_PRODUCT_CONFIG_V3", "ACC_PRODUCT_CONFIG_V2"];
    var SPILL_THRESHOLD = 100 * 1024; // 100KB; MAX_ARG_STRLEN is 128KB
    var wbTrackedChildren = [];
    var wbTrackedPtys = [];
    var wbTerminatingChildren = false;

    try {
      var electronMod = require("electron");
      var appMod = electronMod && electronMod.app;
    } catch (_) {}
    function wbTrackChild(method, command, child) {
      try {
        if (!child || typeof child.on !== "function") return child;
        var childPid = child.pid || null;
        if (childPid) wbTrackedChildren.push({ method: method, command: String(command), child: child, pid: childPid });
        child.on("exit", function (code, signal) {
          wbTrackedChildren = wbTrackedChildren.filter(function (item) { return item.child !== child; });
        });
        child.on("close", function (code, signal) {
          wbTrackedChildren = wbTrackedChildren.filter(function (item) { return item.child !== child; });
        });
      } catch (_) {}
      return child;
    }
    function wbTrackPty(file, term) {
      try {
        if (!term || typeof term !== "object") return term;
        var termPid = term.pid || null;
        if (termPid && typeof term.kill === "function") {
          wbTrackedPtys.push({ file: String(file), term: term, pid: termPid });
          if (typeof term.onExit === "function") {
            term.onExit(function (event) {
              wbTrackedPtys = wbTrackedPtys.filter(function (item) { return item.term !== term; });
            });
          }
        }
      } catch (_) {}
      return term;
    }
    function wbTerminateTrackedChildren(reason) {
      if (wbTerminatingChildren) return;
      wbTerminatingChildren = true;
      wbTrackedPtys.slice().forEach(function (item) {
        try { item.term.kill("SIGTERM"); } catch (_) {}
      });
      wbTrackedChildren.slice().forEach(function (item) {
        try { item.child.kill("SIGTERM"); } catch (_) {}
      });
      try {
        var timer = setTimeout(function () {
          wbTrackedPtys.slice().forEach(function (item) {
            try { item.term.kill("SIGKILL"); } catch (_) {}
          });
          wbTrackedChildren.slice().forEach(function (item) {
            try { item.child.kill("SIGKILL"); } catch (_) {}
          });
        }, 1500);
        if (timer && typeof timer.unref === "function") timer.unref();
      } catch (_) {}
    }
    try {
      if (typeof appMod !== "undefined" && appMod && appMod.on) {
        appMod.on("before-quit", function () { wbTerminateTrackedChildren("electron-before-quit"); });
        appMod.on("will-quit", function () { wbTerminateTrackedChildren("electron-will-quit"); });
      }
    } catch (_) {}
    process.on("exit", function () { wbTerminateTrackedChildren("process-exit"); });

    function wbSpillPath(prefix, suffix) {
      return pathMod.join(
        spillDir(),
        prefix + "-" + cryptoMod.randomBytes(8).toString("hex") + suffix
      );
    }

    // Clean up stale spill dirs from previous runs
    try {
      var wbTmpDir = osMod.tmpdir();
      var wbEntries = fsMod.readdirSync(wbTmpDir);
      var wbOurPid = String(process.pid);
      var wbNow = Date.now();
      for (var wbI = 0; wbI < wbEntries.length; wbI++) {
        var wbEntry = wbEntries[wbI];
        if (typeof wbEntry === "string" && wbEntry.indexOf("workbuddy-linux-env-") === 0) {
          var wbPidStr = wbEntry.slice("workbuddy-linux-env-".length);
          if (wbPidStr !== wbOurPid && /^\d+$/.test(wbPidStr)) {
            try {
              var wbPath = pathMod.join(wbTmpDir, wbEntry);
              var wbStat = fsMod.statSync(wbPath);
              var wbAlive = true;
              try { process.kill(Number(wbPidStr), 0); } catch (_) { wbAlive = false; }
              if (!wbAlive && wbNow - wbStat.mtimeMs > 24 * 60 * 60 * 1000) {
                fsMod.rmSync(wbPath, { recursive: true, force: true });
              }
            } catch (_) {}
          }
        }
      }
    } catch (_) {}

    // Clean up our own spill dir on process exit
    process.on("exit", function wbCleanOwnSpill() {
      try { fsMod.rmSync(pathMod.join(osMod.tmpdir(), "workbuddy-linux-env-" + process.pid), { recursive: true, force: true }); } catch (_) {}
    });

    var spillDirCache = null;
    function spillDir() {
      if (spillDirCache) return spillDirCache;
      var dir = pathMod.join(osMod.tmpdir(), "workbuddy-linux-env-" + process.pid);
      try { fsMod.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (_) {}
      spillDirCache = dir;
      return dir;
    }

    function spillOversizedEnv(originalOpts) {
      if (!originalOpts || typeof originalOpts !== "object") return originalOpts;
      var env = originalOpts.env;
      if (!env || typeof env !== "object") return originalOpts;
      // Build a plain copy so that hidden Proxy keys (ACC_PRODUCT_CONFIG_V3 etc.)
      // are actually enumerable in the child process env. Object.assign across
      // the Proxy only sees the non-hidden keys, so we must re-add them manually.
      var result = Object.assign({}, env);
      var needsReplace = false;
      for (var i = 0; i < SPILL_KEYS.length; i++) {
        var key = SPILL_KEYS[i];
        var value = env[key];
        if (typeof value === "string") {
          if (value.length >= SPILL_THRESHOLD) {
            // Oversized: spill to a temp file and pass _FILE pointer instead.
            // The sidecar-entry.js shim reads the file back.
            try {
              var dir = spillDir();
              var filePath = wbSpillPath(key, ".json");
              fsMod.writeFileSync(filePath, value, { mode: 0o600 });
              delete result[key];
              result[key + "_FILE"] = filePath;
              needsReplace = true;
            } catch (err) {
              try {
                console.error("[wb-linux-shim] failed to spill " + key + ":", err);
              } catch (_) {}
            }
          } else if (!(key in result)) {
            // Non-oversized but missing from the plain copy because the Proxy
            // hides it from ownKeys. Include it directly so the child gets it.
            result[key] = value;
            needsReplace = true;
          }
        }
      }
      if (!needsReplace) return originalOpts;
      return Object.assign({}, originalOpts, { env: result });
    }

    function wrapSpawnLike(name) {
      var orig = cp[name];
      if (typeof orig !== "function" || orig.__wbLinuxShimWrapped) return;
      function wrapped(command, args, options) {
        // Normalize arg shape: spawn(cmd[, args][, options])
        if (!Array.isArray(args) && typeof args === "object" && args !== null) {
          options = args;
          args = undefined;
        }
        var patched = spillOversizedEnv(options);
        if (args === undefined) return wbTrackChild(name, command, orig.call(cp, command, patched));
        return wbTrackChild(name, command, orig.call(cp, command, args, patched));
      }
      wrapped.__wbLinuxShimWrapped = true;
      try { cp[name] = wrapped; } catch (_) {}
    }
    wrapSpawnLike("spawn");
    wrapSpawnLike("spawnSync");
    wrapSpawnLike("execFile");
    wrapSpawnLike("execFileSync");

    // exec/execSync use shell and pass env via options too
    function wrapExecLike(name) {
      var orig = cp[name];
      if (typeof orig !== "function" || orig.__wbLinuxShimWrapped) return;
      function wrapped(command, options, callback) {
        if (typeof options === "function") {
          callback = options;
          options = undefined;
        }
        var patched = spillOversizedEnv(options);
        if (callback) return wbTrackChild(name, command, orig.call(cp, command, patched, callback));
        return wbTrackChild(name, command, orig.call(cp, command, patched));
      }
      wrapped.__wbLinuxShimWrapped = true;
      try { cp[name] = wrapped; } catch (_) {}
    }
    wrapExecLike("exec");
    wrapExecLike("execSync");

    // ---------------------------------------------------------------
    // Part C: receiver side.
    //
    // If our parent handed us a _FILE pointer (i.e. we are a child
    // process spawned after Part B kicked in), read the file back
    // and re-expose the original value on process.env through the
    // same Proxy. The file stays in place because sibling child
    // processes can inherit the same pointer and still need to read it.
    //
    // Additionally, we write a fresh _FILE pointer into the real env
    // so that any child processes we spawn (which inherit process.env
    // via the default behavior) can also pick up the value through
    // their own copy of this shim.
    // ---------------------------------------------------------------
    for (var j = 0; j < SPILL_KEYS.length; j++) {
      var rkey = SPILL_KEYS[j];
      var fkey = rkey + "_FILE";
      var fp = real[fkey];
      if (typeof fp === "string" && fp.length) {
        try {
          store[rkey] = fsMod.readFileSync(fp, "utf8");
          // Don't delete the file — child processes may also need it.
          // Instead, keep the _FILE pointer in the real env so children
          // that inherit process.env can read it too.
        } catch (err) {
          try {
            console.error("[wb-linux-shim] failed to read " + fkey + ":", err);
          } catch (_) {}
        }
      }
    }

    // If we have values in store (either from parent's _FILE or from
    // upstream code setting them via the Proxy), ensure a _FILE pointer
    // exists in the real env for child process inheritance.
    for (var k = 0; k < SPILL_KEYS.length; k++) {
      var skey = SPILL_KEYS[k];
      var sfkey = skey + "_FILE";
      if (store[skey] && typeof store[skey] === "string" && store[skey].length >= SPILL_THRESHOLD) {
        if (!real[sfkey]) {
          try {
            var sfp = wbSpillPath(skey, ".json");
            fsMod.writeFileSync(sfp, store[skey], { mode: 0o600 });
            real[sfkey] = sfp;
          } catch (_) {}
        }
      }
    }

    // ---------------------------------------------------------------
    // Part D: ensure app.asar.unpacked/node_modules is on the
    // module resolution path. The asar-packed require() only sees
    // modules listed in the asar header. Platform-specific optional
    // packages like @lydell/node-pty-linux-x64 are installed into
    // app.asar.unpacked/ by the build script but never registered
    // in the asar header. Adding the unpacked node_modules to
    // Module.globalPaths lets require() find them.
    // ---------------------------------------------------------------
    try {
      var Module = require("module");
      var resourcesPath = typeof process.resourcesPath === "string"
        ? process.resourcesPath
        : pathMod.dirname(process.execPath);
      var unpackedNM = pathMod.join(resourcesPath, "app.asar.unpacked", "node_modules");
      if (fsMod.existsSync(unpackedNM)) {
        if (Module.globalPaths && !Module.globalPaths.includes(unpackedNM)) {
          Module.globalPaths.push(unpackedNM);
        }
      }
    } catch (_) {}

    // ---------------------------------------------------------------
    // Part E: wrap @lydell/node-pty spawn to spill oversized env.
    //
    // The sidecar uses node-pty (not child_process) to spawn the
    // host runtime CLI. node-pty calls forkpty+execve directly in
    // C++, bypassing our child_process monkey-patch. We intercept
    // the JS-level spawn() of the loaded node-pty module to strip
    // oversized env entries before they reach the native layer.
    // ---------------------------------------------------------------
    try {
      var origRequire = Module.prototype.require;
      var ptyPatched = false;
      Module.prototype.require = function wbRequireHook() {
        var result = origRequire.apply(this, arguments);
        var modName = arguments[0];
        if (!ptyPatched && typeof modName === "string" &&
            (modName === "@lydell/node-pty" || modName === "${lydellPlatformPackage}" || modName === "node-pty") &&
            result && typeof result.spawn === "function" && !result.spawn.__wbPtyWrapped) {
          ptyPatched = true;
          // Restore original require immediately to avoid perpetual hook overhead
          Module.prototype.require = origRequire;
          var origSpawn = result.spawn;
          result.spawn = function wbPtySpawn(file, args, opts) {
            if (opts && opts.env && typeof opts.env === "object") {
              var patchedEnv = opts.env;
              var didPatch = false;
              for (var pi = 0; pi < SPILL_KEYS.length; pi++) {
                var pk = SPILL_KEYS[pi];
                var pv = patchedEnv[pk];
                if (typeof pv === "string" && pv.length >= SPILL_THRESHOLD) {
                  try {
                    var pfp = wbSpillPath(pk + "-pty", ".json");
                    fsMod.writeFileSync(pfp, pv, { mode: 0o600 });
                    if (!didPatch) { patchedEnv = Object.assign({}, patchedEnv); didPatch = true; }
                    delete patchedEnv[pk];
                    patchedEnv[pk + "_FILE"] = pfp;
                  } catch (_) {}
                }
              }
              if (didPatch) opts = Object.assign({}, opts, { env: patchedEnv });
            }
            return wbTrackPty(file, origSpawn.call(this, file, args, opts));
          };
          result.spawn.__wbPtyWrapped = true;
        }
        return result;
      };
    } catch (_) {}
  } catch (err) {
    try { console.error("[wb-linux-shim] install failed:", err); } catch (_) {}
  }
})();
`;

if (source.includes(marker)) {
    log('marker already present in main/index.js; skipping source patch');
    markRequired('mainEnvShim', true);
    markRequired('trayContextMenu', true);
    markRequired('trayIconPath', true);
} else {
    const shim = SHIM_BODY;
    source = shim + source;
    markRequired('mainEnvShim', true);

    const trayMarker = 'this.tray = new electron.Tray(trayIcon);';
    const trayIdx = source.indexOf(trayMarker);
    if (trayIdx < 0) {
        console.error('[apply-linux-patches] ERROR: tray construction line not found');
        process.exit(4);
    }

    // Upstream >= 5.5.x already attaches a context menu on Linux via
    //   if (process.platform === "linux") this.tray.setContextMenu(this.buildFallbackMenu());
    // inside the same `else` branch that creates the Tray. Detect this
    // modern layout and skip the legacy contextMenu-anchor patch in that
    // case — the upstream code is already correct for libayatana-appindicator.
    const afterTrayWindow = source.slice(trayIdx, trayIdx + 1200);
    const upstreamAlreadyAttachesContextMenu =
        /process\.platform === ["']linux["']/.test(afterTrayWindow) &&
        /setContextMenu\s*\(/.test(afterTrayWindow);
    if (upstreamAlreadyAttachesContextMenu) {
        log('upstream already calls tray.setContextMenu on Linux (>= 5.5.x); skipping legacy contextMenu-anchor patch');
        markRequired('trayContextMenu', true);
    } else {
        const afterTray = source.slice(trayIdx);
        const contextMenuDeclRe = /const contextMenu = electron\.Menu\.buildFromTemplate\(\[[\s\S]*?\]\);/;
        const m = afterTray.match(contextMenuDeclRe);
        if (!m) {
            console.error('[apply-linux-patches] ERROR: contextMenu declaration not found after tray');
            process.exit(5);
        }
        const insertAt = trayIdx + m.index + m[0].length;
        const trayPatch =
            '\n\t\t\tif (process.platform === "linux") {\n' +
            '\t\t\t\ttry { this.tray.setContextMenu(contextMenu); } catch (_) {}\n' +
            '\t\t\t}';
        source = source.slice(0, insertAt) + trayPatch + source.slice(insertAt);
        markRequired('trayContextMenu', true);
    }

    // Fix 3 (Linux): the tray icon renders as a missing-image placeholder
    // (exclamation mark on Mint/Cinnamon) because upstream hands
    // libayatana-appindicator a resized in-memory NativeImage. The
    // AppIndicator backend wants an on-disk file path it can re-read
    // through GTK. On Linux we construct the Tray from the PNG written
    // by install.sh at <install-dir>/.workbuddy-linux/workbuddy.png
    // (shipped into /opt/<app>/.workbuddy-linux/ by the .deb/.rpm/.pacman
    // builders), falling back to the upstream NativeImage path if that
    // file is missing for any reason.
    const trayConstruct = 'this.tray = new electron.Tray(trayIcon);';
    const trayConstructReplacement =
        'if (process.platform === "linux") {\n' +
        '\t\t\t\ttry {\n' +
        '\t\t\t\t\tconst linuxTrayPath = path.join(path.dirname(process.resourcesPath), ".workbuddy-linux", "workbuddy.png");\n' +
        '\t\t\t\t\tif (fs.existsSync(linuxTrayPath)) {\n' +
        '\t\t\t\t\t\tthis.tray = new electron.Tray(linuxTrayPath);\n' +
        '\t\t\t\t\t}\n' +
        '\t\t\t\t} catch (_) {}\n' +
        '\t\t\t}\n' +
        '\t\t\tif (!this.tray) this.tray = new electron.Tray(trayIcon);';
    // There are two identical Tray constructions in the file in some
    // builds; replace only the first occurrence (the WindowManager one).
    const trayIdx2 = source.indexOf(trayConstruct);
    if (trayIdx2 >= 0) {
        source = source.slice(0, trayIdx2)
            + trayConstructReplacement
            + source.slice(trayIdx2 + trayConstruct.length);
        markRequired('trayIconPath', true);
    } else {
        markRequired('trayIconPath', false);
    }

    // -----------------------------------------------------------------------
    // Fix 5 (Linux): add window control buttons (minimize/maximize/close).
    //
    // Upstream sets `frame: false` on Linux without providing a
    // titleBarOverlay (Windows gets one, macOS uses traffic lights).
    // Electron's titleBarOverlay only works on Wayland, not X11.
    // We inject a small CSS+JS snippet after the renderer loads that
    // draws minimize/maximize/close buttons in the top-right corner,
    // wired to the existing window:minimize/maximize/close RPC channels
    // exposed via the preload script.
    // -----------------------------------------------------------------------
    // Keep frame: false (we draw our own buttons), but remove the
    // titleBarOverlay we added earlier since it doesn't work on X11.
    // (No change needed — the marker is already just { frame: false })

    // Inject window control buttons after ready-to-show
    const readyToShowRe = /windowLog\.info\((?:"\[WindowManager\] Window ready to show"|`\[WindowManager\] Window ready to show[^`]*`)\);/;
    const readyToShowMatch = source.match(readyToShowRe);
    if (readyToShowMatch) {
        const afterReady = readyToShowMatch.index + readyToShowMatch[0].length;
        const windowControlsInjection = `
                        // [wb-linux-patch] Inject window control buttons on Linux
                        if (process.platform === "linux" && this.mainWindow) {
                                this.mainWindow.webContents.once("did-finish-load", () => {
                                        this.mainWindow?.webContents.executeJavaScript(\`
                                                (function() {
                                                        if (document.getElementById('wb-linux-window-controls')) return;
                                                        var css = document.createElement('style');
                                                        css.textContent = \\\`
                                                                #wb-linux-window-controls {
                                                                        position: fixed;
                                                                        top: 0;
                                                                        right: 0;
                                                                        z-index: 99999;
                                                                        display: flex;
                                                                        height: 36px;
                                                                        -webkit-app-region: no-drag;
                                                                }
                                                                #wb-linux-window-controls button {
                                                                        width: 46px;
                                                                        height: 36px;
                                                                        border: none;
                                                                        background: transparent;
                                                                        color: var(--vscode-titleBar-activeForeground, #cccccc);
                                                                        font-size: 16px;
                                                                        cursor: pointer;
                                                                        display: flex;
                                                                        align-items: center;
                                                                        justify-content: center;
                                                                        transition: background 0.1s;
                                                                }
                                                                #wb-linux-window-controls button:hover {
                                                                        background: rgba(255,255,255,0.1);
                                                                }
                                                                #wb-linux-window-controls button.wb-close:hover {
                                                                        background: #e81123;
                                                                        color: white;
                                                                }
                                                                #wb-linux-window-controls button svg {
                                                                        width: 10px;
                                                                        height: 10px;
                                                                        fill: currentColor;
                                                                }
                                                        \\\`;
                                                        document.head.appendChild(css);
                                                        var container = document.createElement('div');
                                                        container.id = 'wb-linux-window-controls';
                                                        container.innerHTML = '<button class="wb-minimize" title="最小化"><svg viewBox="0 0 10 1"><rect width="10" height="1"/></svg></button>'
                                                                + '<button class="wb-maximize" title="最大化"><svg viewBox="0 0 10 10"><path d="M0 0v10h10V0H0zm1 1h8v8H1V1z"/></svg></button>'
                                                                + '<button class="wb-close" title="关闭"><svg viewBox="0 0 10 10"><path d="M1.41 0L5 3.59 8.59 0 10 1.41 6.41 5 10 8.59 8.59 10 5 6.41 1.41 10 0 8.59 3.59 5 0 1.41z"/></svg></button>';
                                                        document.body.appendChild(container);
                                                        container.querySelector('.wb-minimize').onclick = function() {
                                                                window.buddyAPI && window.buddyAPI.minimizeWindow && window.buddyAPI.minimizeWindow();
                                                        };
                                                        container.querySelector('.wb-maximize').onclick = function() {
                                                                window.buddyAPI && window.buddyAPI.maximizeWindow && window.buddyAPI.maximizeWindow();
                                                        };
                                                        container.querySelector('.wb-close').onclick = function() {
                                                                window.buddyAPI && window.buddyAPI.closeWindow && window.buddyAPI.closeWindow();
                                                        };
                                                })();
                                        \`).catch(function() {});
                                });
                        }`;
        source = source.slice(0, afterReady) + windowControlsInjection + source.slice(afterReady);
        markOptional('windowControls', true);
    } else {
        markOptional('windowControls', false);
    }

    // -----------------------------------------------------------------------
    // Fix 6 (Linux): disable the "Check for Updates..." menu item and
    // stub out the updateCheck / updateDownload / updateQuitAndInstall
    // RPCs. The upstream updater talks to the macOS ShipIt / Windows
    // Squirrel / NSIS installers which are not available on Linux, and
    // the downloaded payloads (.dmg / .exe) cannot be applied here. We
    // surface a greyed-out menu entry so users see that auto-update is
    // intentionally unavailable on the Linux port.
    // -----------------------------------------------------------------------
    const updateMenuMarker = 'function getUpdateMenuItem(texts, updateState) {';
    const updateMenuIdx = source.indexOf(updateMenuMarker);
    if (updateMenuIdx >= 0) {
        const linuxUpdateShim =
            updateMenuMarker + '\n' +
            '\tif (process.platform === "linux") {\n' +
            '\t\treturn {\n' +
            '\t\t\tid: "checkForUpdates",\n' +
            '\t\t\tlabel: (texts.checkForUpdates || "Check for Updates...") + " (Linux 不支持)",\n' +
            '\t\t\tdisabled: true,\n' +
            '\t\t\tcommandId: "menu.checkForUpdates.disabled"\n' +
            '\t\t};\n' +
            '\t}';
        source = source.slice(0, updateMenuIdx)
            + linuxUpdateShim
            + source.slice(updateMenuIdx + updateMenuMarker.length);
        markRequired('updateMenuDisabled', true);
    } else {
        markRequired('updateMenuDisabled', false);
    }

    // Neutralize updateCheck / updateDownload / updateQuitAndInstall RPCs
    // on Linux so any residual UI button in the renderer becomes a no-op
    // instead of invoking the macOS/Windows updater code paths.
    const updateRpcMarker = 'function registerUpdateHandlers(server, deps) {';
    const updateRpcIdx = source.indexOf(updateRpcMarker);
    if (updateRpcIdx >= 0) {
        const linuxRpcShim =
            updateRpcMarker + '\n' +
            '\tif (process.platform === "linux") {\n' +
            '\t\thandleRpc$1(server, "updateCheck", async () => {});\n' +
            '\t\thandleRpc$1(server, "updateDownload", async () => {});\n' +
            '\t\thandleRpc$1(server, "updateArchMismatchDownload", async () => {});\n' +
            '\t\thandleRpc$1(server, "updateArchMismatchInstall", async () => {});\n' +
            '\t\thandleRpc$1(server, "updateQuitAndInstall", async () => {});\n' +
            '\t\thandleRpc$1(server, "updateGetState", async () => ({ state: "idle" }));\n' +
            '\t\treturn;\n' +
            '\t}';
        source = source.slice(0, updateRpcIdx)
            + linuxRpcShim
            + source.slice(updateRpcIdx + updateRpcMarker.length);
        markRequired('updateRpcDisabled', true);
    } else {
        markRequired('updateRpcDisabled', false);
    }

    // Also stub out UpdateServiceLinux.checkForUpdates so the automatic
    // background update check (triggered by UpdateService.start()) does
    // not fire HTTP requests to a macOS/Windows feed URL.
    const linuxUpdateClassMarker = 'UpdateServiceLinux = class extends AbstractUpdateService {';
    const linuxUpdateClassIdx = source.indexOf(linuxUpdateClassMarker);
    if (linuxUpdateClassIdx >= 0) {
        const checkMethodMarker = 'async checkForUpdates(explicit = false) {';
        const checkMethodIdx = source.indexOf(checkMethodMarker, linuxUpdateClassIdx);
        if (checkMethodIdx >= 0) {
            const afterCheck = checkMethodIdx + checkMethodMarker.length;
            const earlyReturn = '\n\t\t\t\t\t// [wb-linux-patch] Auto-update disabled on Linux port\n\t\t\t\t\treturn;\n';
            source = source.slice(0, afterCheck) + earlyReturn + source.slice(afterCheck);
            markRequired('updateServiceDisabled', true);
        } else {
            markRequired('updateServiceDisabled', false);
        }
    } else {
        markRequired('updateServiceDisabled', false);
    }

    // -----------------------------------------------------------------------
    // Fix 7 (Linux stability): wrap several main-process awaits with a
    // race-against-timeout fallback. None of these are functional changes
    // upstream relies on; they exist purely to keep the UI thread from
    // wedging on Linux when child_process.exec timeouts misfire or when
    // BinaryManager.doInitialize() ends up in a permanently pending state.
    //
    // Symptoms observed on Linux Mint 22.3 / CachyOS that motivated each
    // sub-patch:
    //
    //   * BinaryManager.doInitialize() occasionally stays pending forever
    //     (registry.json 24h cache hit still blocks). prepareNodeRuntimeEnv()
    //     awaits the same initPromise, so every connect() that needs Node
    //     runtime injection (cloudbase / tcb / etc.) hits the upstream 122s
    //     stdio-MCP connect timeout before ever spawning the server.
    //
    //   * child_process.exec()'s `timeout` option sometimes does NOT fire on
    //     Electron+Linux for hung children. We've measured `which 'tcb'` not
    //     returning for 80s+, blocking the connector preAuth flow and the
    //     entire stdio MCP startup sequence (UI shows "connecting" forever).
    //
    //   * userPromptComposer / runtimeConfigResolver wait on remote
    //     "collectors / waitConfiguration" RPCs that can hang on first launch
    //     before the renderer has registered its handlers. Without a race
    //     fallback the very first chat message blocks indefinitely.
    //
    // All patches are markOptional (graceful degradation: if the upstream
    // shape changes between WorkBuddy releases, we log a warning, fall back
    // to the unpatched behaviour, and let the rest of the patches continue).
    // -----------------------------------------------------------------------

    // Patch 7A: ConnectorMcpProxy.maybeInjectNodeRuntime — 5s race so a
    // hung BinaryManager.ensure() can't block stdio MCP startup. On timeout
    // we fall through to the existing "inherited PATH" path that the catch
    // block already implements.
    const mcpInjectFrom =
        '\t\t\ttry {\n' +
        '\t\t\t\tconst prepared = await prepareNodeRuntimeEnv(this.binaryManager, {\n' +
        '\t\t\t\t\tversionRange: runtime?.version ?? "*",\n' +
        '\t\t\t\t\tregistry: serverConfig.npmRegistries?.[0] ?? serverConfig.npmRegistry\n' +
        '\t\t\t\t}, this.logger, { silent });\n' +
        '\t\t\t\tapplyNodeRuntimeEnv(env, prepared);\n' +
        '\t\t\t\tthis.logger.info(`[ConnectorMcpProxy] stdio MCP ${configId} Node runtime injected: command=${command} version=${prepared.nodeInfo.version} source=${prepared.nodeInfo.source}`);\n' +
        '\t\t\t} catch (err) {\n' +
        '\t\t\t\tthis.logger.warn(`[ConnectorMcpProxy] stdio MCP ${configId} Node runtime preparation failed; falling back to inherited PATH: ${err instanceof Error ? err.message : String(err)}`);\n' +
        '\t\t\t}';
    const mcpInjectTo =
        '\t\t\ttry {\n' +
        '\t\t\t\t// [wb-linux] BinaryManager.doInitialize() 在某些环境会永远 pending\n' +
        '\t\t\t\t// （registry.json 1440min cache 命中也照样阻塞），后续 ensure() 会一直 await\n' +
        '\t\t\t\t// 同一个 pending initPromise，把 stdio 启动卡到 connect timeout 122s。\n' +
        '\t\t\t\t// 5s race 后兜底走继承 PATH（系统 node 已在 PATH 上），跟原有 catch 语义一致。\n' +
        '\t\t\t\tconst wbStart = Date.now();\n' +
        '\t\t\t\tconst wbPrepP = prepareNodeRuntimeEnv(this.binaryManager, {\n' +
        '\t\t\t\t\tversionRange: runtime?.version ?? "*",\n' +
        '\t\t\t\t\tregistry: serverConfig.npmRegistries?.[0] ?? serverConfig.npmRegistry\n' +
        '\t\t\t\t}, this.logger, { silent });\n' +
        '\t\t\t\tlet wbTimer;\n' +
        '\t\t\t\tconst wbTimeoutP = new Promise((res) => { wbTimer = setTimeout(() => res({ __wbTimeout: true }), 5000); });\n' +
        '\t\t\t\tconst wbResult = await Promise.race([wbPrepP, wbTimeoutP]);\n' +
        '\t\t\t\tclearTimeout(wbTimer);\n' +
        '\t\t\t\tif (wbResult && wbResult.__wbTimeout) {\n' +
        '\t\t\t\t\ttry { this.logger.warn(`[wb-linux][ConnectorMcpProxy] stdio MCP ${configId} prepareNodeRuntimeEnv timeout 5s; falling back to inherited PATH (command=${command})`); } catch {}\n' +
        '\t\t\t\t\twbPrepP.then(() => {}, () => {});\n' +
        '\t\t\t\t\treturn;\n' +
        '\t\t\t\t}\n' +
        '\t\t\t\tapplyNodeRuntimeEnv(env, wbResult);\n' +
        '\t\t\t\tthis.logger.info(`[ConnectorMcpProxy] stdio MCP ${configId} Node runtime injected in ${Date.now() - wbStart}ms: command=${command} version=${wbResult.nodeInfo.version} source=${wbResult.nodeInfo.source}`);\n' +
        '\t\t\t} catch (err) {\n' +
        '\t\t\t\tthis.logger.warn(`[ConnectorMcpProxy] stdio MCP ${configId} Node runtime preparation failed; falling back to inherited PATH: ${err instanceof Error ? err.message : String(err)}`);\n' +
        '\t\t\t}';
    {
        const idx = source.indexOf(mcpInjectFrom);
        if (idx >= 0) {
            source = source.slice(0, idx) + mcpInjectTo + source.slice(idx + mcpInjectFrom.length);
            markOptional('mcpInjectNodeRuntimeTimeout', true);
        } else {
            console.error('[apply-linux-patches] ERROR: mcpInjectNodeRuntimeTimeout anchor not found; skipping (stdio MCP startup may stall on hung BinaryManager)');
            markOptional('mcpInjectNodeRuntimeTimeout', false);
        }
    }

    // Patch 7B: ConnectorCliExecutor.buildCommandEnv — same 5s race for
    // the CLI preAuth path (tcb / cnpm etc.). Without this, runPreCliAuth()
    // blocks for the upstream 122s connect timeout when BinaryManager is
    // wedged.
    const cliBuildEnvFrom =
        '\t\t\tapplyNodeRuntimeEnv(env, await prepareNodeRuntimeEnv(this.binaryManager, {\n' +
        '\t\t\t\tversionRange: cliConfig.runtime.version ?? "*",\n' +
        '\t\t\t\tregistry: registry ?? cliConfig.npmRegistry\n' +
        '\t\t\t}, this.logger, { silent: options.silent === true }));\n' +
        '\t\t\tapplyCliConfigEnv(env, cliConfig.env);\n' +
        '\t\t\treturn env;';
    const cliBuildEnvTo =
        '\t\t\t// [wb-linux] 同 ConnectorMcpProxy.maybeInjectNodeRuntime：BinaryManager\n' +
        '\t\t\t// 初始化偶发永久 pending，会让 preAuth CLI 路径（tcb 等）卡到上游 connect timeout。\n' +
        '\t\t\t// 5s race 兜底走继承 PATH（系统 node 已就绪）。\n' +
        '\t\t\tconst wbPrepP = prepareNodeRuntimeEnv(this.binaryManager, {\n' +
        '\t\t\t\tversionRange: cliConfig.runtime.version ?? "*",\n' +
        '\t\t\t\tregistry: registry ?? cliConfig.npmRegistry\n' +
        '\t\t\t}, this.logger, { silent: options.silent === true });\n' +
        '\t\t\tlet wbTimer;\n' +
        '\t\t\tconst wbTimeoutP = new Promise((res) => { wbTimer = setTimeout(() => res({ __wbTimeout: true }), 5000); });\n' +
        '\t\t\tconst wbResult = await Promise.race([wbPrepP, wbTimeoutP]);\n' +
        '\t\t\tclearTimeout(wbTimer);\n' +
        '\t\t\tif (wbResult && wbResult.__wbTimeout) {\n' +
        '\t\t\t\ttry { this.logger.warn("[wb-linux][CliExecutor] prepareNodeRuntimeEnv timeout 5s; falling back to inherited PATH"); } catch {}\n' +
        '\t\t\t\twbPrepP.then(() => {}, () => {});\n' +
        '\t\t\t\tapplyCliConfigEnv(env, cliConfig.env);\n' +
        '\t\t\t\treturn env;\n' +
        '\t\t\t}\n' +
        '\t\t\tapplyNodeRuntimeEnv(env, wbResult);\n' +
        '\t\t\tapplyCliConfigEnv(env, cliConfig.env);\n' +
        '\t\t\treturn env;';
    {
        const idx = source.indexOf(cliBuildEnvFrom);
        if (idx >= 0) {
            source = source.slice(0, idx) + cliBuildEnvTo + source.slice(idx + cliBuildEnvFrom.length);
            markOptional('cliBuildCommandEnvTimeout', true);
        } else {
            console.error('[apply-linux-patches] ERROR: cliBuildCommandEnvTimeout anchor not found; skipping (CLI preAuth may stall on hung BinaryManager)');
            markOptional('cliBuildCommandEnvTimeout', false);
        }
    }

    // Patch 7C: CliExecutor.isCliInstalled — 6s hard timeout via
    // Promise.race because child_process.exec()'s own `timeout` option does
    // not always fire on Electron+Linux for processes stuck in syscalls
    // (observed: `which 'tcb'` not returning for 80s+, freezing the UI).
    // We treat the timeout as "not installed" so the upper layer falls
    // through to the install path or surfaces a friendly error instead of
    // wedging the connector pipeline.
    const cliIsInstalledFrom =
        '\t\t\ttry {\n' +
        '\t\t\t\tconst env = await this.buildCommandEnv(cliConfig, options);\n' +
        '\t\t\t\tthis.logger.info(`[CliExecutor] isCliInstalled: platform=${(0, os.platform)()} checkCmd=${checkCmd} windowsHide=true`);\n' +
        '\t\t\t\tawait execAsync$1(checkCmd, {\n' +
        '\t\t\t\t\ttimeout: 5e3,\n' +
        '\t\t\t\t\tenv,\n' +
        '\t\t\t\t\twindowsHide: true\n' +
        '\t\t\t\t});\n' +
        '\t\t\t\treturn true;\n' +
        '\t\t\t} catch {\n' +
        '\t\t\t\treturn false;\n' +
        '\t\t\t}';
    const cliIsInstalledTo =
        '\t\t\ttry {\n' +
        '\t\t\t\tconst env = await this.buildCommandEnv(cliConfig, options);\n' +
        '\t\t\t\tthis.logger.info(`[CliExecutor] isCliInstalled: platform=${(0, os.platform)()} checkCmd=${checkCmd} windowsHide=true`);\n' +
        '\t\t\t\t// [wb-linux] 在某些 Electron + Linux 环境下 child_process.exec 的 timeout\n' +
        '\t\t\t\t// 对 hang 住的子进程不生效（已观察到 which \'tcb\' 80s+ 不返回，UI 卡死）。\n' +
        '\t\t\t\t// 用 Promise.race 兜底：6s 还没结果就当成"未安装"，让上层走 install 路径\n' +
        '\t\t\t\t// 或直接报错，绝不阻塞 UI。\n' +
        '\t\t\t\tconst wbExecP = execAsync$1(checkCmd, { timeout: 5e3, env, windowsHide: true });\n' +
        '\t\t\t\tlet wbTimer;\n' +
        '\t\t\t\tconst wbTimeoutP = new Promise((_, rej) => { wbTimer = setTimeout(() => rej(new Error("[wb-linux] isCliInstalled hard timeout 6s")), 6000); });\n' +
        '\t\t\t\ttry {\n' +
        '\t\t\t\t\tawait Promise.race([wbExecP, wbTimeoutP]);\n' +
        '\t\t\t\t} finally {\n' +
        '\t\t\t\t\tclearTimeout(wbTimer);\n' +
        '\t\t\t\t\twbExecP.then(() => {}, () => {});\n' +
        '\t\t\t\t}\n' +
        '\t\t\t\treturn true;\n' +
        '\t\t\t} catch (err) {\n' +
        '\t\t\t\ttry { if (err && /wb-linux/.test(String(err.message ?? err))) this.logger.warn(`[wb-linux][CliExecutor] isCliInstalled hard timeout for ${checkCmd}; treating as not installed`); } catch {}\n' +
        '\t\t\t\treturn false;\n' +
        '\t\t\t}';
    {
        const idx = source.indexOf(cliIsInstalledFrom);
        if (idx >= 0) {
            source = source.slice(0, idx) + cliIsInstalledTo + source.slice(idx + cliIsInstalledFrom.length);
            markOptional('cliIsCliInstalledTimeout', true);
        } else {
            console.error('[apply-linux-patches] ERROR: cliIsCliInstalledTimeout anchor not found; skipping (which/where check may hang indefinitely on Linux)');
            markOptional('cliIsCliInstalledTimeout', false);
        }
    }

    // Patch 7D: ConnectorService.connect — wrap runPreCliAuth() in a 30s
    // race so a hung CLI auth flow can't block stdio MCP startup. preAuth
    // is only used to prime CLI login state; the stdio MCP server does
    // not strictly depend on it, so on timeout we proceed with startup
    // anyway. The function name `connect` is too common for a direct
    // anchor, so we pin on the unique runPreCliAuth call site and walk
    // back to the enclosing `if (connectorConfig?.cliConfig)`.
    {
        const preAuthCall = 'await this.runPreCliAuth(configId, connectorConfig, signal);';
        const callIdx = source.indexOf(preAuthCall);
        if (callIdx >= 0) {
            // Walk back to find the enclosing `if (connectorConfig?.cliConfig) {`
            const ifMarker = 'if (connectorConfig?.cliConfig) {';
            const ifIdx = source.lastIndexOf(ifMarker, callIdx);
            // Walk forward to find the matching close `}` of that if block.
            // Within an esbuild minified-but-pretty output the body is exactly:
            //   if (connectorConfig?.cliConfig) {\n
            //   \t...const preAuthResult = await this.runPreCliAuth(...);\n
            //   \t...if (!preAuthResult.success) return preAuthResult;\n
            //   \t...}\n
            // so we look for the next `if (!preAuthResult.success) return preAuthResult;`
            // and the closing brace that follows it on the next line.
            const successCheck = 'if (!preAuthResult.success) return preAuthResult;';
            const successIdx = source.indexOf(successCheck, callIdx);
            if (ifIdx >= 0 && successIdx >= 0 && successIdx - callIdx < 200) {
                // Find the closing `}` after successCheck (skip whitespace + newline).
                let endIdx = successIdx + successCheck.length;
                while (endIdx < source.length && /[\s]/.test(source[endIdx])) endIdx++;
                if (source[endIdx] === '}') endIdx++;
                else endIdx = -1;
                if (endIdx > 0) {
                    // Detect the indentation prefix used on the `if (...)` line so
                    // the replacement uses the same level (works for both `\t\t\t\t`
                    // and `\t\t\t` and arbitrary tab depth).
                    let indentStart = ifIdx;
                    while (indentStart > 0 && (source[indentStart - 1] === '\t' || source[indentStart - 1] === ' ')) indentStart--;
                    const indent = source.slice(indentStart, ifIdx);
                    const replacement =
                        indent + 'if (connectorConfig?.cliConfig) {\n' +
                        indent + '\t// [wb-linux] runPreCliAuth 内部 child_process.exec 在 Electron+Linux\n' +
                        indent + '\t// 偶发 hang 不响应 timeout（已观察到 which \'tcb\' 80s+ 不返回，UI 卡死）。\n' +
                        indent + '\t// 整体 race 30s 超时；超时后跳过 preAuth 继续 stdio MCP 启动 ——\n' +
                        indent + '\t// preAuth 仅为 CLI 登录态准备，stdio MCP server 自身不强依赖。\n' +
                        indent + '\tconst wbPreP = this.runPreCliAuth(configId, connectorConfig, signal);\n' +
                        indent + '\tlet wbTimer;\n' +
                        indent + '\tconst wbTimeoutP = new Promise((res) => { wbTimer = setTimeout(() => res({ __wbTimeout: true }), 30000); });\n' +
                        indent + '\tconst preAuthResult = await Promise.race([wbPreP, wbTimeoutP]);\n' +
                        indent + '\tclearTimeout(wbTimer);\n' +
                        indent + '\tif (preAuthResult && preAuthResult.__wbTimeout) {\n' +
                        indent + '\t\ttry { this.logger.warn(`[wb-linux][ConnectorService] runPreCliAuth(${configId}) timeout 30s; skipping preAuth and continuing with stdio MCP startup`); } catch {}\n' +
                        indent + '\t\twbPreP.then(() => {}, () => {});\n' +
                        indent + '\t} else if (!preAuthResult.success) return preAuthResult;\n' +
                        indent + '}';
                    source = source.slice(0, indentStart) + replacement + source.slice(endIdx);
                    markOptional('connectorPreAuthTimeout', true);
                } else {
                    console.error('[apply-linux-patches] ERROR: connectorPreAuthTimeout end-brace not found; skipping');
                    markOptional('connectorPreAuthTimeout', false);
                }
            } else {
                console.error('[apply-linux-patches] ERROR: connectorPreAuthTimeout if/successCheck not found near runPreCliAuth call; skipping');
                markOptional('connectorPreAuthTimeout', false);
            }
        } else {
            console.error('[apply-linux-patches] ERROR: connectorPreAuthTimeout runPreCliAuth call not found; skipping (CLI preAuth may stall the connect pipeline)');
            markOptional('connectorPreAuthTimeout', false);
        }
    }

    // Patch 7E: SessionManager.composePromptForBackend — 5s race + raw
    // prompt fallback so the very first chat message can't hang on the
    // remote userPromptComposer (collectors / waitConfiguration).
    //
    // Upstream 5.x changed desiredConfig from cloneDesiredConfig(...) to
    // session.desiredConfig.
    const composeFrom =
        '\tasync composePromptForBackend(session, prompt, _meta) {\n' +
        '\t\tif (!this.userPromptComposer || !Array.isArray(prompt) || prompt.length === 0) return prompt;\n' +
        '\t\tawait this.userPromptComposerReady;\n' +
        '\t\treturn this.userPromptComposer.composeUserPrompt({\n' +
        '\t\t\tsessionId: session.sessionId,\n' +
        '\t\t\tcwd: session.cwd,\n' +
        '\t\t\tdesiredConfig: session.desiredConfig,\n' +
        '\t\t\tprompt: structuredClone(prompt),\n' +
        '\t\t\t_meta: _meta ? structuredClone(_meta) : void 0,\n' +
        '\t\t\thasPriorUserMessages: sessionHasPriorUserMessages(session)\n' +
        '\t\t});\n' +
        '\t}';
    const composeTo =
        '\tasync composePromptForBackend(session, prompt, _meta) {\n' +
        '\t\tif (!this.userPromptComposer || !Array.isArray(prompt) || prompt.length === 0) return prompt;\n' +
        '\t\tawait this.userPromptComposerReady;\n' +
        '\t\t// [wb-linux] 5s race + fallback to original prompt to avoid hang in user prompt composition (collectors / waitConfiguration)\n' +
        '\t\tconst wbStart = Date.now();\n' +
        '\t\tconst wbComposeP = this.userPromptComposer.composeUserPrompt({\n' +
        '\t\t\tsessionId: session.sessionId,\n' +
        '\t\t\tcwd: session.cwd,\n' +
        '\t\t\tdesiredConfig: session.desiredConfig,\n' +
        '\t\t\tprompt: structuredClone(prompt),\n' +
        '\t\t\t_meta: _meta ? structuredClone(_meta) : void 0,\n' +
        '\t\t\thasPriorUserMessages: sessionHasPriorUserMessages(session)\n' +
        '\t\t});\n' +
        '\t\tlet wbTimer;\n' +
        '\t\tconst wbTimeoutP = new Promise((res) => { wbTimer = setTimeout(() => res({ __wbTimeout: true }), 5000); });\n' +
        '\t\tconst wbResult = await Promise.race([wbComposeP, wbTimeoutP]);\n' +
        '\t\tclearTimeout(wbTimer);\n' +
        '\t\tif (wbResult && wbResult.__wbTimeout) {\n' +
        '\t\t\ttry { console.warn(`[wb-linux] composePromptForBackend timeout 5s sessionId=${session.sessionId}, falling back to raw prompt`); } catch {}\n' +
        '\t\t\twbComposeP.then(() => {}, () => {});\n' +
        '\t\t\treturn prompt;\n' +
        '\t\t}\n' +
        '\t\ttry { console.log(`[wb-linux] composePromptForBackend done in ${Date.now() - wbStart}ms sessionId=${session.sessionId}`); } catch {}\n' +
        '\t\treturn wbResult;\n' +
        '\t}';
    {
        const idx = source.indexOf(composeFrom);
        if (idx >= 0) {
            source = source.slice(0, idx) + composeTo + source.slice(idx + composeFrom.length);
            markOptional('composePromptForBackendTimeout', true);
        } else {
            console.error('[apply-linux-patches] ERROR: composePromptForBackendTimeout anchor not found; skipping (first chat message may hang)');
            markOptional('composePromptForBackendTimeout', false);
        }
    }

    // Patch 7F: SessionManager.resolveRuntimeConfig — 5s race + local
    // desiredConfig fallback so first launch doesn't block on a remote
    // runtimeConfigResolver that hasn't booted yet.
    const resolveFrom =
        '\tasync resolveRuntimeConfig(args) {\n' +
        '\t\tif (!this.runtimeConfigResolver) return buildFallbackRuntimeConfig(args.desiredConfig);\n' +
        '\t\treturn cloneResolvedRuntimeConfig(await this.runtimeConfigResolver.resolveConfig({\n' +
        '\t\t\tsessionId: args.sessionId,\n' +
        '\t\t\tcwd: args.cwd,\n' +
        '\t\t\tdesiredConfig: cloneDesiredConfig(args.desiredConfig),\n' +
        '\t\t\tcurrentRuntimeConfig: args.currentRuntimeConfig ?? null\n' +
        '\t\t}));\n' +
        '\t}';
    const resolveTo =
        '\tasync resolveRuntimeConfig(args) {\n' +
        '\t\tif (!this.runtimeConfigResolver) return buildFallbackRuntimeConfig(args.desiredConfig);\n' +
        '\t\t// [wb-linux] 5s race + fallback to avoid hang in resolveConfig (collectors / waitConfiguration)\n' +
        '\t\tconst wbStart = Date.now();\n' +
        '\t\tconst wbResolveP = this.runtimeConfigResolver.resolveConfig({\n' +
        '\t\t\tsessionId: args.sessionId,\n' +
        '\t\t\tcwd: args.cwd,\n' +
        '\t\t\tdesiredConfig: cloneDesiredConfig(args.desiredConfig),\n' +
        '\t\t\tcurrentRuntimeConfig: args.currentRuntimeConfig ?? null\n' +
        '\t\t});\n' +
        '\t\tlet wbTimer;\n' +
        '\t\tconst wbTimeoutP = new Promise((res) => { wbTimer = setTimeout(() => res({ __wbTimeout: true }), 5000); });\n' +
        '\t\tconst wbResult = await Promise.race([wbResolveP, wbTimeoutP]);\n' +
        '\t\tclearTimeout(wbTimer);\n' +
        '\t\tif (wbResult && wbResult.__wbTimeout) {\n' +
        '\t\t\ttry { console.warn(`[wb-linux] resolveConfig timeout 5s sessionId=${args.sessionId} cwd=${args.cwd}, falling back to local desiredConfig`); } catch {}\n' +
        '\t\t\t// fire-and-forget the original promise to avoid unhandled rejection\n' +
        '\t\t\twbResolveP.then(() => {}, () => {});\n' +
        '\t\t\treturn buildFallbackRuntimeConfig(args.desiredConfig);\n' +
        '\t\t}\n' +
        '\t\ttry { console.log(`[wb-linux] resolveConfig done in ${Date.now() - wbStart}ms sessionId=${args.sessionId}`); } catch {}\n' +
        '\t\treturn cloneResolvedRuntimeConfig(wbResult);\n' +
        '\t}';
    {
        const idx = source.indexOf(resolveFrom);
        if (idx >= 0) {
            source = source.slice(0, idx) + resolveTo + source.slice(idx + resolveFrom.length);
            markOptional('resolveRuntimeConfigTimeout', true);
        } else {
            console.error('[apply-linux-patches] ERROR: resolveRuntimeConfigTimeout anchor not found; skipping (first session start may hang)');
            markOptional('resolveRuntimeConfigTimeout', false);
        }
    }

    const clawRuntimePluginRegistrationReplayFrom =
        '\t\tthis.runtime = new ClawRuntime(host, this.telemetryService, logger, this.channelTracingService);\n' +
        '\t\tthis.ensureBuiltinPluginsRegistered();\n' +
        '\t\tthis.configureReplyResolver();';
    const clawRuntimePluginRegistrationReplayTo =
        '\t\tthis.runtime = new ClawRuntime(host, this.telemetryService, logger, this.channelTracingService);\n' +
        '\t\tthis.ensureBuiltinPluginsRegistered();\n' +
        '\t\tsetTimeout(async () => {\n' +
        '\t\t\ttry {\n' +
        '\t\t\t\tconst wbWechatmpConfig = this.store?.getChannelConfigs?.()["wechatmp"];\n' +
        '\t\t\t\tconst wbWechatmpEnabled = this.getWechatmpEnabled() || !!(wbWechatmpConfig && wbWechatmpConfig.enabled !== false);\n' +
        '\t\t\t\tthis.logger.info(`[wb-linux][ClawService] plugin registration replay check: apiEnabled=${this.getWechatmpEnabled()} configEnabled=${!!(wbWechatmpConfig && wbWechatmpConfig.enabled !== false)}`);\n' +
        '\t\t\t\tif (wbWechatmpEnabled) {\n' +
        '\t\t\t\t\tthis.logger.info("[wb-linux][ClawService] plugin registration replay enabled wechatmp integration");\n' +
        '\t\t\t\t\tthis.enableWechatmpChannel();\n' +
        '\t\t\t\t\tawait this.registerChannelConfig({ channelType: "wechatmp" });\n' +
        '\t\t\t\t\tthis.startCentrifugo().catch((error) => {\n' +
        '\t\t\t\t\t\tthis.logger.warn(`[wb-linux][ClawService] plugin registration replay Centrifugo start failed: ${error}`);\n' +
        '\t\t\t\t\t});\n' +
        '\t\t\t\t}\n' +
        '\t\t\t} catch (error) {\n' +
        '\t\t\t\tthis.logger.warn(`[wb-linux][ClawService] plugin registration replay failed: ${error instanceof Error ? error.message : String(error)}`);\n' +
        '\t\t\t}\n' +
        '\t\t}, 1000).unref?.();\n' +
        '\t\tthis.configureReplyResolver();';
    {
        const idx = source.indexOf(clawRuntimePluginRegistrationReplayFrom);
        if (idx >= 0) {
            source = source.slice(0, idx) + clawRuntimePluginRegistrationReplayTo + source.slice(idx + clawRuntimePluginRegistrationReplayFrom.length);
            markOptional('wechatmpPluginRegistrationReplay', true);
        } else {
            console.error('[apply-linux-patches] ERROR: wechatmpPluginRegistrationReplay anchor not found; skipping (registered wechatmp plugin may not trigger remote replay)');
            markOptional('wechatmpPluginRegistrationReplay', false);
        }
    }

    const networkDiagnosticsRunFrom =
        '\t\tconst [proxy, hosts, service, tcp, packetLoss] = await Promise.all([\n' +
        '\t\t\tthis.runProxyDiagnostics(proxyInfo),\n' +
        '\t\t\tthis.runHostsDiagnostics(host, hostsFilePath),\n' +
        '\t\t\tthis.runServiceDiagnostics(runtimeConfig.endpoint),\n' +
        '\t\t\tthis.runTcpDiagnostics(host, port, proxyInfo),\n' +
        '\t\t\tthis.runPacketLossDiagnostics(host)\n' +
        '\t\t]);';
    const networkDiagnosticsRunTo =
        '\t\tconst [proxy, hosts, service, tcp, packetLoss] = await Promise.all([\n' +
        '\t\t\tthis.runCheckWithTimeout("proxy", () => this.runProxyDiagnostics(proxyInfo), 5000),\n' +
        '\t\t\tthis.runCheckWithTimeout("hosts", () => this.runHostsDiagnostics(host, hostsFilePath), 5000),\n' +
        '\t\t\tthis.runCheckWithTimeout("service", () => this.runServiceDiagnostics(runtimeConfig.endpoint), 7000),\n' +
        '\t\t\tthis.runCheckWithTimeout("tcp", () => this.runTcpDiagnostics(host, port, proxyInfo), 5000),\n' +
        '\t\t\tthis.runCheckWithTimeout("packetLoss", () => this.runPacketLossDiagnostics(host), 35000)\n' +
        '\t\t]);';
    const networkDiagnosticsMethodFrom =
        '\tasync measureTcpConnection(host, port, timeoutMs) {';
    const networkDiagnosticsMethodTo =
        '\tasync runCheckWithTimeout(name, task, timeoutMs) {\n' +
        '\t\tlet timer;\n' +
        '\t\ttry {\n' +
        '\t\t\treturn await Promise.race([\n' +
        '\t\t\t\ttask(),\n' +
        '\t\t\t\tnew Promise((resolve) => {\n' +
        '\t\t\t\t\ttimer = setTimeout(() => resolve({\n' +
        '\t\t\t\t\t\tstatus: "warning",\n' +
        '\t\t\t\t\t\tsummary: `${name}-timeout`,\n' +
        '\t\t\t\t\t\tdetail: `Check timed out after ${timeoutMs}ms.`,\n' +
        '\t\t\t\t\t\terrorType: "timeout"\n' +
        '\t\t\t\t\t}), timeoutMs);\n' +
        '\t\t\t\t})\n' +
        '\t\t\t]);\n' +
        '\t\t} finally {\n' +
        '\t\t\tclearTimeout(timer);\n' +
        '\t\t}\n' +
        '\t}\n' +
        '\tasync measureTcpConnection(host, port, timeoutMs) {';
    {
        const runIdx = source.indexOf(networkDiagnosticsRunFrom);
        const methodIdx = source.indexOf(networkDiagnosticsMethodFrom, runIdx >= 0 ? runIdx : 0);
        if (runIdx >= 0 && methodIdx >= 0 && !source.includes('async runCheckWithTimeout(name, task, timeoutMs)')) {
            source = source.slice(0, runIdx) + networkDiagnosticsRunTo + source.slice(runIdx + networkDiagnosticsRunFrom.length);
            const updatedMethodIdx = source.indexOf(networkDiagnosticsMethodFrom, runIdx);
            source = source.slice(0, updatedMethodIdx) + networkDiagnosticsMethodTo + source.slice(updatedMethodIdx + networkDiagnosticsMethodFrom.length);
            markRequired('networkDiagnosticsTimeouts', true);
        } else if (source.includes('async runCheckWithTimeout(name, task, timeoutMs)')) {
            markRequired('networkDiagnosticsTimeouts', true);
        } else {
            console.error('[apply-linux-patches] ERROR: networkDiagnosticsTimeouts anchor not found; network diagnostics may stay stuck on a hung DNS/ping/probe task');
            markRequired('networkDiagnosticsTimeouts', false);
        }
    }

    fs.writeFileSync(indexPath, source);
    log('patched main/index.js (env shim + tray context menu + tray icon path + disabled updater + linux stability timeouts + wechatmp plugin registration replay)');
}

if (!patchReport.required.networkDiagnosticsTimeouts) {
    const runFrom =
        '\t\tconst [proxy, hosts, service, tcp, packetLoss] = await Promise.all([\n' +
        '\t\t\tthis.runProxyDiagnostics(proxyInfo),\n' +
        '\t\t\tthis.runHostsDiagnostics(host, hostsFilePath),\n' +
        '\t\t\tthis.runServiceDiagnostics(runtimeConfig.endpoint),\n' +
        '\t\t\tthis.runTcpDiagnostics(host, port, proxyInfo),\n' +
        '\t\t\tthis.runPacketLossDiagnostics(host)\n' +
        '\t\t]);';
    const runTo =
        '\t\tconst [proxy, hosts, service, tcp, packetLoss] = await Promise.all([\n' +
        '\t\t\tthis.runCheckWithTimeout("proxy", () => this.runProxyDiagnostics(proxyInfo), 5000),\n' +
        '\t\t\tthis.runCheckWithTimeout("hosts", () => this.runHostsDiagnostics(host, hostsFilePath), 5000),\n' +
        '\t\t\tthis.runCheckWithTimeout("service", () => this.runServiceDiagnostics(runtimeConfig.endpoint), 7000),\n' +
        '\t\t\tthis.runCheckWithTimeout("tcp", () => this.runTcpDiagnostics(host, port, proxyInfo), 5000),\n' +
        '\t\t\tthis.runCheckWithTimeout("packetLoss", () => this.runPacketLossDiagnostics(host), 35000)\n' +
        '\t\t]);';
    const methodFrom = '\tasync measureTcpConnection(host, port, timeoutMs) {';
    const methodTo =
        '\tasync runCheckWithTimeout(name, task, timeoutMs) {\n' +
        '\t\tlet timer;\n' +
        '\t\ttry {\n' +
        '\t\t\treturn await Promise.race([\n' +
        '\t\t\t\ttask(),\n' +
        '\t\t\t\tnew Promise((resolve) => {\n' +
        '\t\t\t\t\ttimer = setTimeout(() => resolve({\n' +
        '\t\t\t\t\t\tstatus: "warning",\n' +
        '\t\t\t\t\t\tsummary: `${name}-timeout`,\n' +
        '\t\t\t\t\t\tdetail: `Check timed out after ${timeoutMs}ms.`,\n' +
        '\t\t\t\t\t\terrorType: "timeout"\n' +
        '\t\t\t\t\t}), timeoutMs);\n' +
        '\t\t\t\t})\n' +
        '\t\t\t]);\n' +
        '\t\t} finally {\n' +
        '\t\t\tclearTimeout(timer);\n' +
        '\t\t}\n' +
        '\t}\n' +
        '\tasync measureTcpConnection(host, port, timeoutMs) {';
    const runIdx = source.indexOf(runFrom);
    const methodIdx = source.indexOf(methodFrom, runIdx >= 0 ? runIdx : 0);
    if (runIdx >= 0 && methodIdx >= 0 && !source.includes('async runCheckWithTimeout(name, task, timeoutMs)')) {
        source = source.slice(0, runIdx) + runTo + source.slice(runIdx + runFrom.length);
        const updatedMethodIdx = source.indexOf(methodFrom, runIdx);
        source = source.slice(0, updatedMethodIdx) + methodTo + source.slice(updatedMethodIdx + methodFrom.length);
        fs.writeFileSync(indexPath, source);
        log('patched main/index.js (network diagnostics per-check timeouts)');
        markRequired('networkDiagnosticsTimeouts', true);
    } else if (source.includes('async runCheckWithTimeout(name, task, timeoutMs)')) {
        markRequired('networkDiagnosticsTimeouts', true);
    } else {
        console.error('[apply-linux-patches] ERROR: networkDiagnosticsTimeouts anchor not found; network diagnostics may stay stuck on a hung DNS/ping/probe task');
        markRequired('networkDiagnosticsTimeouts', false);
    }
}

{
    const oldPacketLossTimeout = 'this.runCheckWithTimeout("packetLoss", () => this.runPacketLossDiagnostics(host), 12000)';
    const newPacketLossTimeout = 'this.runCheckWithTimeout("packetLoss", () => this.runPacketLossDiagnostics(host), 35000)';
    if (source.includes(oldPacketLossTimeout)) {
        source = source.split(oldPacketLossTimeout).join(newPacketLossTimeout);
        fs.writeFileSync(indexPath, source);
        log('patched main/index.js (network diagnostics packet loss timeout threshold)');
    }
}

{
    const oldPacketLossMeasure = 'const result = await this.measurePacketLoss(host, 18, 3e4);';
    const newPacketLossMeasure = 'const result = await this.measurePacketLoss(host, 4, 8e3);';
    if (source.includes(oldPacketLossMeasure)) {
        source = source.split(oldPacketLossMeasure).join(newPacketLossMeasure);
        fs.writeFileSync(indexPath, source);
        log('patched main/index.js (network diagnostics packet loss sample size)');
    }
}

{
    const oldLinuxPingArgs =
        '\t\t\t"-c",\n' +
        '\t\t\tString(count),\n' +
        '\t\t\t"-n",\n' +
        '\t\t\thost\n';
    const newLinuxPingArgs =
        '\t\t\t"-c",\n' +
        '\t\t\tString(count),\n' +
        '\t\t\t"-W",\n' +
        '\t\t\t"2",\n' +
        '\t\t\t"-n",\n' +
        '\t\t\thost\n';
    if (source.includes(oldLinuxPingArgs) && !source.includes('"-W",\n\t\t\t"2",\n\t\t\t"-n",')) {
        source = source.replace(oldLinuxPingArgs, newLinuxPingArgs);
        fs.writeFileSync(indexPath, source);
        log('patched main/index.js (network diagnostics linux ping wait)');
    }
}

{
    const runPingFrom =
        '\tasync runPing(args, timeoutMs, isWindows) {\n' +
        '\t\treturn new Promise((resolve) => {\n' +
        '\t\t\tif (isWindows) (0, child_process.execFile)("ping", args, {\n' +
        '\t\t\t\ttimeout: timeoutMs,\n' +
        '\t\t\t\twindowsHide: true,\n' +
        '\t\t\t\tencoding: "buffer"\n' +
        '\t\t\t}, (err, stdout, stderr) => {\n' +
        '\t\t\t\tthis.decodeWindowsOutput(stdout, stderr).then((output) => {\n' +
        '\t\t\t\t\tresolve({\n' +
        '\t\t\t\t\t\toutput,\n' +
        '\t\t\t\t\t\terror: err\n' +
        '\t\t\t\t\t});\n' +
        '\t\t\t\t});\n' +
        '\t\t\t});\n' +
        '\t\t\telse (0, child_process.execFile)("ping", args, {\n' +
        '\t\t\t\ttimeout: timeoutMs,\n' +
        '\t\t\t\twindowsHide: true\n' +
        '\t\t\t}, (err, stdout, stderr) => {\n' +
        '\t\t\t\tresolve({\n' +
        '\t\t\t\t\toutput: `${stdout || ""}${stderr ? `\\n${stderr}` : ""}`.trim(),\n' +
        '\t\t\t\t\terror: err\n' +
        '\t\t\t\t});\n' +
        '\t\t\t});\n' +
        '\t\t});\n' +
        '\t}\n';
    const runPingTo =
        '\tasync runPing(args, timeoutMs, isWindows) {\n' +
        '\t\treturn new Promise((resolve) => {\n' +
        '\t\t\tlet settled = false;\n' +
        '\t\t\tlet child;\n' +
        '\t\t\tconst finish = (result) => {\n' +
        '\t\t\t\tif (settled) return;\n' +
        '\t\t\t\tsettled = true;\n' +
        '\t\t\t\tclearTimeout(timer);\n' +
        '\t\t\t\tresolve(result);\n' +
        '\t\t\t};\n' +
        '\t\t\tconst timer = setTimeout(() => {\n' +
        '\t\t\t\ttry {\n' +
        '\t\t\t\t\tchild?.kill();\n' +
        '\t\t\t\t} catch {}\n' +
        '\t\t\t\tfinish({\n' +
        '\t\t\t\t\toutput: "",\n' +
        '\t\t\t\t\terror: new Error(`Ping command timed out after ${timeoutMs}ms.`)\n' +
        '\t\t\t\t});\n' +
        '\t\t\t}, timeoutMs + 1000);\n' +
        '\t\t\tif (isWindows) child = (0, child_process.execFile)("ping", args, {\n' +
        '\t\t\t\ttimeout: timeoutMs,\n' +
        '\t\t\t\twindowsHide: true,\n' +
        '\t\t\t\tencoding: "buffer"\n' +
        '\t\t\t}, (err, stdout, stderr) => {\n' +
        '\t\t\t\tthis.decodeWindowsOutput(stdout, stderr).then((output) => {\n' +
        '\t\t\t\t\tfinish({\n' +
        '\t\t\t\t\t\toutput,\n' +
        '\t\t\t\t\t\terror: err\n' +
        '\t\t\t\t\t});\n' +
        '\t\t\t\t});\n' +
        '\t\t\t});\n' +
        '\t\t\telse child = (0, child_process.execFile)("ping", args, {\n' +
        '\t\t\t\ttimeout: timeoutMs,\n' +
        '\t\t\t\twindowsHide: true\n' +
        '\t\t\t}, (err, stdout, stderr) => {\n' +
        '\t\t\t\tfinish({\n' +
        '\t\t\t\t\toutput: `${stdout || ""}${stderr ? `\\n${stderr}` : ""}`.trim(),\n' +
        '\t\t\t\t\terror: err\n' +
        '\t\t\t\t});\n' +
        '\t\t\t});\n' +
        '\t\t});\n' +
        '\t}\n';
    if (source.includes(runPingFrom)) {
        source = source.replace(runPingFrom, runPingTo);
        fs.writeFileSync(indexPath, source);
        log('patched main/index.js (network diagnostics ping hard timeout)');
    }
}

{
    const linuxChineseAnchor =
        '\t\tconst unixDetailedMatch = /(\\d+)\\s+packets transmitted,\\s*(\\d+)\\s+(?:packets )?received.*?(\\d+(?:\\.\\d+)?)%\\s+packet loss/i.exec(output);\n';
    const linuxChinesePatch =
        '\t\tconst unixChineseMatch = /已发送\\s*(\\d+)\\s*个包[，,]\\s*已接收\\s*(\\d+)\\s*个包.*?(\\d+(?:\\.\\d+)?)%\\s*packet loss/i.exec(output);\n' +
        '\t\tif (unixChineseMatch) return {\n' +
        '\t\t\ttransmitted: Number(unixChineseMatch[1]),\n' +
        '\t\t\treceived: Number(unixChineseMatch[2]),\n' +
        '\t\t\tlossPercentage: Number(unixChineseMatch[3])\n' +
        '\t\t};\n';
    if (source.includes(linuxChineseAnchor) && !source.includes('const unixChineseMatch =')) {
        source = source.replace(linuxChineseAnchor, linuxChinesePatch + linuxChineseAnchor);
        fs.writeFileSync(indexPath, source);
        log('patched main/index.js (network diagnostics linux chinese ping parser)');
    }
}

assertRequiredPatches();

// ---------------------------------------------------------------------------
// Also patch sidecar-entry.js so the sidecar process, spawned with
// ELECTRON_RUN_AS_NODE=1 and its own Node bootstrap, receives the same
// env Proxy / _FILE receiver installed in main/index.js. Without this
// the sidecar would boot without ACC_PRODUCT_CONFIG_V3 set (because
// the parent spilled it to a file) and every downstream call through
// getWorkbuddyBootstrapProductConfigurationEnv() would fall back to
// a stale bootstrap value.
// ---------------------------------------------------------------------------
const sidecarEntryPath = path.join(tmpDir, 'main', 'sidecar-entry.js');
if (fs.existsSync(sidecarEntryPath)) {
    let sidecarSource = fs.readFileSync(sidecarEntryPath, 'utf8');
    if (!sidecarSource.includes(marker)) {
        sidecarSource = SHIM_BODY + sidecarSource;
        fs.writeFileSync(sidecarEntryPath, sidecarSource);
        log('patched main/sidecar-entry.js (env shim)');
        markRequired('sidecarEnvShim', true);
    } else {
        log('marker already present in main/sidecar-entry.js; skipping');
        markRequired('sidecarEnvShim', true);
    }
} else {
    markRequired('sidecarEnvShim', false);
}

function patchCliDistCodebuddy() {
    const codebuddyPath = path.join(unpackedSiblingDir, 'cli', 'dist', 'codebuddy.js');
    if (!fs.existsSync(codebuddyPath)) {
        markOptional('cliExtensionPathObjectCompat', false);
        return;
    }

    let cliSource = fs.readFileSync(codebuddyPath, 'utf8');
    const exactReplacements = [
        {
            from: 'for(let eg of ec){let ec=(0,AF.join)(eA,eg);if(!await this.pathExists(ec)){this.logger.warn(`Agent path not found: ${ec}`);continue}',
            to: 'for(let eg of ec){let e$="string"==typeof eg?eg:eg&&"string"==typeof eg.path?eg.path:eg&&"string"==typeof eg.source?eg.source:void 0;if(!e$){this.logger.warn(`Invalid agent path entry: ${JSON.stringify(eg)}`);continue}let ec=(0,AF.join)(eA,e$);if(!await this.pathExists(ec)){this.logger.warn(`Agent path not found: ${ec}`);continue}'
        },
        {
            from: 'for(let eg of ec){let ec=(0,AF.join)(eA,eg);if(!await this.pathExists(ec)){this.logger.warn(`Command path not found: ${ec}`);continue}',
            to: 'for(let eg of ec){let e$="string"==typeof eg?eg:eg&&"string"==typeof eg.path?eg.path:eg&&"string"==typeof eg.source?eg.source:void 0;if(!e$){this.logger.warn(`Invalid command path entry: ${JSON.stringify(eg)}`);continue}let ec=(0,AF.join)(eA,e$);if(!await this.pathExists(ec)){this.logger.warn(`Command path not found: ${ec}`);continue}'
        },
        {
            from: 'for(let eg of ec){let ec=(0,AF.join)(eA,eg);if(!await this.pathExists(ec)){this.logger.warn(`Skill path not found: ${ec}`);continue}',
            to: 'for(let eg of ec){let e$="string"==typeof eg?eg:eg&&"string"==typeof eg.path?eg.path:eg&&"string"==typeof eg.source?eg.source:void 0;if(!e$){this.logger.warn(`Invalid skill path entry: ${JSON.stringify(eg)}`);continue}let ec=(0,AF.join)(eA,e$);if(!await this.pathExists(ec)){this.logger.warn(`Skill path not found: ${ec}`);continue}'
        },
        {
            from: 'async deserializeSessionFromJsonl(eA,el){let ec=this.getSessionFilePath(eA),eu=await this.deserializeSessionFromPath(ec,el);if(eu)return eu;if(eA.startsWith("agent-")){let ec=this.getStorageDir();try{for(let ed of(await tE.readdir(ec,{withFileTypes:!0}))){if(!ed.isDirectory())continue;let eg=tC.join(ec,ed.name,"subagents"),ep=tC.join(eg,`${eA}.jsonl`);try{if(await tE.access(ep),eu=await this.deserializeSessionFromPath(ep,el))return eu}catch{continue}}}catch{}}}async deserializeSessionFromPath',
            to: 'async deserializeSessionFromJsonl(eA,el){let ec=this.getSessionFilePath(eA),eu=await this.deserializeSessionFromPath(ec,el);if(eu)return eu;if(eA.startsWith("agent-")){let ec=this.getStorageDir();try{for(let ed of(await tE.readdir(ec,{withFileTypes:!0}))){if(!ed.isDirectory())continue;let eg=tC.join(ec,ed.name,"subagents"),ep=tC.join(eg,`${eA}.jsonl`);try{if(await tE.access(ep),eu=await this.deserializeSessionFromPath(ep,el))return eu}catch{continue}}}catch{}}try{let ec=tp.PathUtils.getHomeProjectsDir();for(let ed of await tE.readdir(ec,{withFileTypes:!0})){if(!ed.isDirectory())continue;let eg=tC.join(ec,ed.name,`${eA}.jsonl`);try{if(await tE.access(eg),eu=await this.deserializeSessionFromPath(eg,el))return eu}catch{continue}}}catch{}}async deserializeSessionFromPath'
        },
        // Linux fix: McpManager.getConnectedServers always applies a timeout
        // (not just in non-interactive mode). Otherwise a stuck MCP server
        // makes Agent.buildMcpServers() (called on every prompt) hang forever
        // and the UI stays at "preparing". The original code only races with
        // a timeout when isNonInteractiveMode() is true.
        {
            from: 'async getConnectedServers(){if(this.isNonInteractiveMode())try{await A$.McpUtils.raceWithTimeout(this.allServersSettledDeferred.promise,()=>{this.logger.warn("MCP servers did not settle within timeout, proceeding with available servers"),this.allServersSettledDeferred.resolve()})}catch(eA){this.logger.debug("Failed to wait for servers to settle:",eA.message)}return this.connectedServersCache}',
            to: 'async getConnectedServers(){try{await A$.McpUtils.raceWithTimeout(this.allServersSettledDeferred.promise,()=>{this.logger.warn("[wb-linux] MCP servers did not settle within timeout, proceeding with available servers"),this.allServersSettledDeferred.resolve()})}catch(eA){this.logger.debug("Failed to wait for servers to settle:",eA.message)}return this.connectedServersCache}'
        }
    ];

    let patched = 0;
    let pathCompatPatched = 0;
    for (const { from, to } of exactReplacements) {
        if (cliSource.includes(to)) {
            patched++;
            if (to.includes('Invalid agent path entry') || to.includes('Invalid command path entry') || to.includes('Invalid skill path entry')) pathCompatPatched++;
            continue;
        }
        if (cliSource.includes(from)) {
            cliSource = cliSource.replace(from, to);
            patched++;
            if (to.includes('Invalid agent path entry') || to.includes('Invalid command path entry') || to.includes('Invalid skill path entry')) pathCompatPatched++;
        }
    }

    const pathObjectHelpers = 'let e$="string"==typeof eA?eA:eA&&"string"==typeof eA.path?eA.path:eA&&"string"==typeof eA.source?eA.source:void 0;if(!e$){ep.push(`Invalid agent path entry: ${JSON.stringify(eA)}`);continue}let el=(0,tZ.join)(eu,e$);(0,tW.existsSync)(el)||ep.push(`Agent path not found: ${e$}`)';
    const pathObjectReplacements = [
        {
            from: 'if(el.agents)for(let eA of"string"==typeof el.agents?[el.agents]:el.agents){let el=(0,tZ.join)(eu,eA);(0,tW.existsSync)(el)||ep.push(`Agent path not found: ${eA}`)}',
            to: 'if(el.agents)for(let eA of"string"==typeof el.agents?[el.agents]:el.agents){let e$="string"==typeof eA?eA:eA&&"string"==typeof eA.path?eA.path:eA&&"string"==typeof eA.source?eA.source:void 0;if(!e$){ep.push(`Invalid agent path entry: ${JSON.stringify(eA)}`);continue}let el=(0,tZ.join)(eu,e$);(0,tW.existsSync)(el)||ep.push(`Agent path not found: ${e$}`)}'
        },
        {
            from: 'if(el.commands)for(let eA of"string"==typeof el.commands?[el.commands]:el.commands){let el=(0,tZ.join)(eu,eA);(0,tW.existsSync)(el)||ep.push(`Command path not found: ${eA}`)}',
            to: 'if(el.commands)for(let eA of"string"==typeof el.commands?[el.commands]:el.commands){let e$="string"==typeof eA?eA:eA&&"string"==typeof eA.path?eA.path:eA&&"string"==typeof eA.source?eA.source:void 0;if(!e$){ep.push(`Invalid command path entry: ${JSON.stringify(eA)}`);continue}let el=(0,tZ.join)(eu,e$);(0,tW.existsSync)(el)||ep.push(`Command path not found: ${e$}`)}'
        },
        {
            from: 'if(el.skills)for(let eA of el.skills){let el=(0,tZ.join)(eu,eA);(0,tW.existsSync)(el)||ep.push(`Skill path not found: ${eA}`)}',
            to: 'if(el.skills)for(let eA of"string"==typeof el.skills?[el.skills]:el.skills){let e$="string"==typeof eA?eA:eA&&"string"==typeof eA.path?eA.path:eA&&"string"==typeof eA.source?eA.source:void 0;if(!e$){ep.push(`Invalid skill path entry: ${JSON.stringify(eA)}`);continue}let el=(0,tZ.join)(eu,e$);(0,tW.existsSync)(el)||ep.push(`Skill path not found: ${e$}`)}'
        }
    ];
    if (cliSource.includes(pathObjectHelpers)) {
        pathCompatPatched = Math.max(pathCompatPatched, 3);
    } else {
        for (const { from, to } of pathObjectReplacements) {
            if (cliSource.includes(to)) {
                pathCompatPatched++;
            } else if (cliSource.includes(from)) {
                cliSource = cliSource.replace(from, to);
                pathCompatPatched++;
            }
        }
    }

    const sessionReplayPatched = cliSource.includes('findSessionAcrossProjects') || cliSource.includes('getHomeProjectsDir();for(let ed of await');
    if (sessionReplayPatched && !exactReplacements[3].to.includes('findSessionAcrossProjects')) patched = Math.max(patched, pathCompatPatched + 1);

    const mcpNewFrom = 'eA&&!this.allServersSettled()&&await this.serverCollectionSubject.pipe((0,AG.filter)(()=>this.allServersSettled()),(0,AH.take)(1),(0,Aj.timeout)(AZ.McpUtils.getMcpTimeout()??3e4),(0,AK.catchError)(()=>(this.logger.warn("MCP servers did not settle within timeout, proceeding with available servers"),(0,AU.of)(void 0)))).toPromise()';
    const mcpNewTo = '!this.allServersSettled()&&await this.serverCollectionSubject.pipe((0,AG.filter)(()=>this.allServersSettled()),(0,AH.take)(1),(0,Aj.timeout)(AZ.McpUtils.getMcpTimeout()??3e4),(0,AK.catchError)(()=>(this.logger.warn("[wb-linux] MCP servers did not settle within timeout, proceeding with available servers"),(0,AU.of)(void 0)))).toPromise()';
    let mcpPatched = cliSource.includes(mcpNewTo) || cliSource.includes('[wb-linux] MCP servers did not settle within timeout');
    if (!mcpPatched && cliSource.includes(mcpNewFrom)) {
        cliSource = cliSource.replace(mcpNewFrom, mcpNewTo);
        mcpPatched = true;
    }

    patched = Math.max(patched, pathCompatPatched + (sessionReplayPatched ? 1 : 0) + (mcpPatched ? 1 : 0));

    if (pathCompatPatched === 3 && sessionReplayPatched && mcpPatched) {
        fs.writeFileSync(codebuddyPath, cliSource);
        log('patched cli/dist/codebuddy.js (extension path object compatibility, session replay fallback, MCP settle timeout in interactive mode)');
        markOptional('cliExtensionPathObjectCompat', true);
        markOptional('cliSessionReplayAcrossProjectsFallback', true);
        markOptional('cliMcpSettleTimeoutInteractive', true);
    } else {
        markOptional('cliExtensionPathObjectCompat', false);
        markOptional('cliSessionReplayAcrossProjectsFallback', false);
        markOptional('cliMcpSettleTimeoutInteractive', false);
        console.warn('[apply-linux-patches] failed to patch all cli compatibility points: ' + patched + '/5');
    }
}

patchCliDistCodebuddy();

// ---------------------------------------------------------------------------
// Ensure the Linux @lydell/node-pty platform package is present in the asar's node_modules
// so that require("@lydell/node-pty-linux-*") resolves from within the
// asar. The package lives on disk in app.asar.unpacked/node_modules/ but
// was never registered in the original macOS asar header. We copy it into
// the tmpDir so the repack step includes it as an unpacked entry.
// ---------------------------------------------------------------------------
const lydellPackageBasename = lydellPlatformPackage.split('/')[1];
if (!lydellPackageBasename) {
    console.error('[apply-linux-patches] ERROR: could not extract package basename from ' + lydellPlatformPackage);
    process.exit(2);
}
const lydellLinuxSrc = path.join(unpackedSiblingDir, 'node_modules', '@lydell', lydellPackageBasename);
const lydellLinuxDst = path.join(tmpDir, 'node_modules', '@lydell', lydellPackageBasename);
if (fs.existsSync(lydellLinuxSrc) && !fs.existsSync(lydellLinuxDst)) {
    fs.cpSync(lydellLinuxSrc, lydellLinuxDst, { recursive: true });
    log('copied ' + lydellPlatformPackage + ' into asar source for repack');
    markRequired('lydellPlatformPackageRegistered', true);
} else if (fs.existsSync(lydellLinuxDst)) {
    markRequired('lydellPlatformPackageRegistered', true);
} else {
    markRequired('lydellPlatformPackageRegistered', false);
}

// ---------------------------------------------------------------------------
// 3. Repack.
//
// @electron/asar's glob-based --unpack matcher has O(2^n) behaviour on a
// brace list the size of ours (~850 entries). Instead we build a Set of
// the original unpacked paths, use a catch-all minimatch pattern that
// accepts everything, and pass a `dot: true` pattern per directory. But
// the cleanest route with the public API is: pass a minimatch function
// that is fast. Turns out the simplest workable approach is to use the
// pattern scheme once per "class" of entry. On inspection, the original
// header's unpacked set is exactly:
//     cli/**   +   resources/**   +   a specific subset of node_modules/**
//
// For node_modules, the unpacked subset is always a whole package tree
// (better-sqlite3, @lydell/*, node-pty, nunjucks, @tencent/docs-engine).
//
// We compute that per-top-level-dir unpacked set dynamically from the
// original header and emit an asar `--unpack=…` pattern that names each
// top-level directory that must be fully unpacked. That's small enough
// for minimatch to handle in microseconds.
// ---------------------------------------------------------------------------
function collectFullyUnpackedDirs() {
    // Find every directory where 100% of its immediate children are unpacked
    // (recursively). Start from each top-level dir.
    const dirs = [];
    function visit(node, relPath) {
        if (!node.files) return { total: 0, unpacked: 0 };
        let total = 0, unpacked = 0;
        for (const [name, entry] of Object.entries(node.files)) {
            const child = relPath ? relPath + '/' + name : name;
            if (entry.files) {
                const sub = visit(entry, child);
                total += sub.total;
                unpacked += sub.unpacked;
            } else if (entry.link) {
                // links aren't packed or unpacked; ignore for the ratio
            } else {
                total++;
                if (entry.unpacked) unpacked++;
            }
        }
        if (total > 0 && total === unpacked && relPath) {
            dirs.push(relPath);
        }
        return { total, unpacked };
    }
    visit(header, '');
    // Only keep maximal directories (drop any dir whose parent is also in
    // the set), so the asar glob pattern stays minimal.
    const set = new Set(dirs);
    return dirs.filter(d => {
        const parts = d.split('/');
        for (let i = 1; i < parts.length; i++) {
            const parent = parts.slice(0, i).join('/');
            if (set.has(parent)) return false;
        }
        return true;
    });
}

const fullyUnpackedDirs = collectFullyUnpackedDirs();
// Also include any Linux platform packages we injected into the tmpDir
// that weren't in the original macOS header.
const extraUnpackDirs = ['node_modules/@lydell/' + lydellPackageBasename];
for (const d of extraUnpackDirs) {
    if (fs.existsSync(path.join(tmpDir, d)) && !fullyUnpackedDirs.includes(d)) {
        fullyUnpackedDirs.push(d);
    }
}
log('Fully-unpacked top directories: ' + fullyUnpackedDirs.length);

// Compose the asar `unpackDir` glob. It is matched against directory
// entries, so "cli" matches the cli/ tree recursively. Brace-list of
// ~10 paths is fast.
const unpackDirPattern = '{' + fullyUnpackedDirs.map(d =>
    d.replace(/[{}(),*?[\]!|+@\\]/g, ch => '\\' + ch)
).join(',') + '}';

// Also compute any individual unpacked files that live in partially-packed
// directories (e.g. a single file under node_modules/foo/ where only that
// one file is unpacked). Collect them and use an explicit --unpack glob.
const partialUnpackedFiles = [];
function findPartialFiles(node, relPath) {
    if (!node.files) return;
    if (fullyUnpackedDirs.includes(relPath)) return; // covered by unpackDir
    for (const [name, entry] of Object.entries(node.files)) {
        const child = relPath ? relPath + '/' + name : name;
        if (entry.files) {
            if (!fullyUnpackedDirs.includes(child)) {
                findPartialFiles(entry, child);
            }
        } else if (entry.unpacked && !entry.link) {
            // Is the child's directory already in the fully-unpacked set?
            const parent = child.split('/').slice(0, -1).join('/');
            if (!fullyUnpackedDirs.some(d => parent === d || parent.startsWith(d + '/'))) {
                partialUnpackedFiles.push(child);
            }
        }
    }
}
findPartialFiles(header, '');
log('Partially-unpacked individual files: ' + partialUnpackedFiles.length);

const unpackPattern = partialUnpackedFiles.length
    ? '{' + partialUnpackedFiles.map(p =>
        p.replace(/[{}(),*?[\]!|+@\\]/g, ch => '\\' + ch)
    ).join(',') + '}'
    : undefined;

assertRequiredPatches();

// ---------------------------------------------------------------------------
// Pack.
//
// We only edit main/index.js, which lives inside the asar (packed). The
// sibling <asar>.unpacked/ sidecar directory therefore does not need to
// change — and we explicitly avoid touching it so that any files the
// install.sh step already placed there (e.g. rebuilt native modules,
// Linux ripgrep binary, the original resources/icon.png) stay as-is.
//
// The repack produces its own sidecar directory matching the header's
// unpack set. We throw that output away.
// ---------------------------------------------------------------------------
(async () => {
    const outPath = asarPath + '.new';
    const stagingSidecar = outPath + '.unpacked';
    try { fs.rmSync(outPath, { force: true }); } catch (_) {}
    try { fs.rmSync(stagingSidecar, { recursive: true, force: true }); } catch (_) {}

    await asar.createPackageWithOptions(tmpDir, outPath, {
        unpackDir: unpackDirPattern,
        unpack: unpackPattern,
    });
    log('wrote ' + path.basename(outPath) + ' (' + fs.statSync(outPath).size + ' bytes)');

    // Atomically replace app.asar only. Leave app.asar.unpacked alone.
    fs.renameSync(asarPath, asarPath + '.prepatch');
    try {
        fs.renameSync(outPath, asarPath);
    } catch (err) {
        // Roll back on failure.
        try { fs.renameSync(asarPath + '.prepatch', asarPath); } catch (_) {}
        throw err;
    }
    try { fs.rmSync(asarPath + '.prepatch'); } catch (_) {}

    // Discard the repack's sidecar directory; the on-disk one is already
    // correct and contains additional files (rebuilt native modules,
    // Linux binaries) that the staging dir does not have.
    try { fs.rmSync(stagingSidecar, { recursive: true, force: true }); } catch (_) {}

    const reportPath = path.join(path.dirname(asarPath), '..', '.workbuddy-linux', 'patch-report.json');
    try {
        fs.mkdirSync(path.dirname(reportPath), { recursive: true });
        fs.writeFileSync(reportPath, JSON.stringify(patchReport, null, 2));
    } catch (err) {
        console.warn('[apply-linux-patches] failed to write patch report: ' + err.message);
    }

    log('replaced app.asar in place (app.asar.unpacked left untouched)');
})().catch(err => {
    console.error('[apply-linux-patches] pack failed:', err);
    process.exit(6);
});
