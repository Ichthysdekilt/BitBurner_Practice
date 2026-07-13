/** dnet-explore.js
 * Multi-hop darknet exploration via self-replication.
 * Each instance probes its own neighbors, authenticates, grabs lore, then
 * replicates to each newly-authenticated server so the BFS fans out hop-by-hop.
 * preventDuplicates stops the script running twice on the same node.
 *
 * Shared state on home:
 *   darknet/dnet-passwords.txt  — hostname=password, one per line (append mode)
 *   darknet/dnet-hints.txt      — parsed password hints from .data.txt files (append mode)
 *   darknet/map/<host>.txt      — per-node scan results
 *   darkweb:/text/              — .txt files gathered from all nodes (flat)
 *   home:/lore/                 — .lit files copied from all nodes (flat; ns.write can't write .lit so no subdir)
 *
 * Usage: run dnet-explore.js   (always start from home)
 */

const DNET_HUB    = "darkweb";
const LORE_DEST   = "home";
const TXT_DEST    = "darkweb";
const TXT_DIR     = "/text/";
const LORE_EXTS   = [".lit", ".txt", ".msg", ".lore", ".log"];
const STASIS_SCRIPT = "darknet/dnet-stasis.js";
const PASS_FILE  = "darknet/dnet-passwords.txt";
const HINTS_FILE = "darknet/dnet-hints.txt";

// Set once in main() from --silent; each replicated instance re-parses its
// own ns.args so this stays correct per-process.
let SILENT_MODE = false;

// Drop-in replacement for ns.tprint: always logs to ns.print, only surfaces
// to the terminal when SILENT_MODE is off.
function tp(ns, ...args) {
    ns.print(...args);
    if (!SILENT_MODE) ns.tprint(...args);
}

/** @param {NS} ns */
export async function main(ns) {
    ns.disableLog("ALL");

    const flags = ns.flags([["silent", false]]);
    SILENT_MODE = flags.silent;
    const silentArg = SILENT_MODE ? ["--silent"] : [];

    const here   = ns.getHostname();
    const script = ns.getScriptName();

    // Bootstrap: home just replicates to darkweb and exits
    if (here === "home") {
        tp(ns, "Replicating to darkweb...");
        await ns.scp([script, STASIS_SCRIPT], DNET_HUB);
        const pid = ns.exec(script, DNET_HUB, { preventDuplicates: true }, ...silentArg);
        if (pid === 0) tp(ns, "ERROR: Failed to exec on darkweb. Enough RAM?");
        else            tp(ns, `Running on darkweb (pid ${pid}). Exploring...`);
        return;
    }

    ns.print(`=== Darknet Explore from: ${here} ===`);

    try {
        await exploreFrom(ns, here, script, silentArg);
    } catch(e) {
        tp(ns, `[dnet-explore] FATAL ERROR on ${here}: ${e}`);
        ns.print(`FATAL ERROR on ${here}: ${e}`);
    }
}

async function exploreFrom(ns, here, script, silentArg) {
    tp(ns, `[dnet-explore] Starting explore from ${here}`);

    // Pull latest shared state from home
    await ns.scp(PASS_FILE,  here, LORE_DEST);
    await ns.scp(HINTS_FILE, here, LORE_DEST);

    const passwords   = loadPasswords(ns);
    const hints       = loadHints(ns);
    // Snapshot which hosts were already known before this run — we only
    // propagate to genuinely new hosts, never re-spawn on existing ones.
    // Always include the hub itself so no instance ever re-spawns back onto darkweb.
    const knownBefore = new Set([DNET_HUB, ...Object.keys(passwords)]);
    ns.print(`  -> Loaded ${knownBefore.size} passwords, ${hints.dict.size} dict words`);

    const neighbors = probeAdjacent(ns);
    tp(ns, `[dnet-explore] Probe from ${here}: [${neighbors.join(", ") || "(none)"}]`);
    if (neighbors.length === 0) return;

    const nodeResults = {};

    for (const host of neighbors) {
        let details = ns.dnet.getServerDetails(host);

        if (!details.hasSession && details.isOnline) {
            // Try a cheap connectToSession first if we already have the password
            if (passwords[host] !== undefined) {
                ns.dnet.connectToSession(host, passwords[host]);
                details = ns.dnet.getServerDetails(host);
            }
            // If still no session, authenticate (discovers new password or retries)
            if (!details.hasSession) {
                const password = await tryAuthenticate(ns, host, details, passwords, hints);
                if (password !== null) {
                    passwords[host] = password;
                    ns.write(PASS_FILE, `${host}=${password}\n`, "a");
                    await ns.scp(PASS_FILE, LORE_DEST);
                    details = ns.dnet.getServerDetails(host);
                }
            }
        }

        nodeResults[host] = details;
        ns.print(`  ${details.isOnline ? "[ONLINE]" : "[OFFLINE]"} ${details.hasSession ? "[SESSION]" : "         "}  ${host}  model=${details.modelId ?? "?"}${details.passwordHint ? `  hint="${details.passwordHint}"` : ""}`);

        if (details.hasSession && details.isOnline) {
            await grabLore(ns, host, hints);
            await ns.scp(HINTS_FILE, LORE_DEST);

            // Only propagate to hosts not previously known — true frontier nodes only.
            if (!knownBefore.has(host)) {
                await ns.scp([script, STASIS_SCRIPT], host);
                const pid = ns.exec(script, host, { preventDuplicates: true }, ...silentArg);
                if (pid > 0) tp(ns, `[dnet-explore] Spawned on ${host} (pid ${pid})`);
            }
        }
    }

    writeNodeMap(ns, here, nodeResults);
    await ns.scp(`darknet/map/${here}.txt`, LORE_DEST);

    // Reward operations after all exploration is complete
    await freeMemory(ns);
    await openCaches(ns);

    tp(ns, `[dnet-explore] Done exploring from ${here}.`);
}

// ─── Memory / Cache ───────────────────────────────────────────────────────────

async function freeMemory(ns) {
    let freed = 0;
    for (let i = 0; i < 20; i++) {
        try { await ns.dnet.memoryReallocation(); freed++; }
        catch(e) { break; }
    }
    if (freed > 0) ns.print(`  -> Freed ${freed} memory block(s) on ${ns.getHostname()}`);
}

async function openCaches(ns) {
    const here   = ns.getHostname();
    const caches = ns.ls(here, ".cache");
    for (const cache of caches) {
        try {
            await ns.dnet.openCache(cache);
            tp(ns, `[dnet-explore] Opened cache on ${here}: ${cache}`);
            // Cache rewards may include data files — grab anything new after opening
            for (const file of ns.ls(here)) {
                if (!LORE_EXTS.some(ext => file.endsWith(ext))) continue;
                if (file.startsWith("darknet/") || file === ns.getScriptName()) continue;
                if (file.endsWith(".txt")) {
                    const content  = ns.read(file);
                    const baseName = file.split("/").pop();
                    const destPath = `${TXT_DIR}${baseName}`;
                    ns.write(destPath, content, "w");
                    await ns.scp(destPath, TXT_DEST);
                    ns.rm(destPath);
                    tp(ns, `[dnet-explore] Cache drop (txt) -> darkweb:${destPath}: ${file}`);
                } else {
                    await ns.scp(file, LORE_DEST);
                    tp(ns, `[dnet-explore] Cache drop copied: ${file}`);
                }
            }
        } catch(e) { ns.print(`  -> Failed to open cache: ${cache}: ${e}`); }
    }
}

// ─── Lore / Data files ────────────────────────────────────────────────────────

/**
 * Copy lore files from host to home/darknet-lore/<host>/, organized by source.
 * Parse any .data.txt files for password hints.
 */
// Files we own — never treat as lore regardless of extension
const OWN_FILES = new Set([PASS_FILE, HINTS_FILE]);

async function grabLore(ns, host, hints) {
    const script    = ns.getScriptName();
    const here      = ns.getHostname();
    const files     = ns.ls(host);

    // .exe files: apply stasis lock via helper script and alert — do NOT run automatically
    const exeFiles = files.filter(f => f.endsWith(".exe"));
    if (exeFiles.length > 0) {
        tp(ns, `[dnet-explore] *** EXE FOUND on ${host}: ${exeFiles.join(", ")} — applying stasis lock for manual inspection ***`);
        try {
            const scpOk = await ns.scp(STASIS_SCRIPT, host);
            if (!scpOk) { tp(ns, `[dnet-explore] WARNING: scp of stasis script failed to ${host}`); }
            else {
                const spid = ns.exec(STASIS_SCRIPT, host, { preventDuplicates: true });
                if (spid === 0) tp(ns, `[dnet-explore] WARNING: stasis script failed to launch on ${host} (no RAM or already running?)`);
            }
        } catch(e) { tp(ns, `[dnet-explore] WARNING: stasis lock failed on ${host}: ${e}`); }
    }

    const loreFiles = files.filter(f =>
        LORE_EXTS.some(ext => f.endsWith(ext)) &&
        !OWN_FILES.has(f) &&
        !f.startsWith("darknet/") &&
        f !== script
    );
    if (loreFiles.length === 0) return;

    ns.print(`    -> ${loreFiles.length} lore file(s) on ${host}`);

    for (const file of loreFiles) {
        if (file.endsWith(".txt")) {
            // Stage through current server, then write flat to darkweb:/text/
            const staged = await ns.scp(file, here, host);
            if (!staged) { ns.print(`       FAILED (stage): ${file}`); continue; }

            const content  = ns.read(file);
            const baseName = file.split("/").pop();
            const destPath = `${TXT_DIR}${baseName}`;
            ns.write(destPath, content, "w");
            const ok = await ns.scp(destPath, TXT_DEST);
            ns.print(`       ${ok ? "Copied" : "FAILED"}: ${file} -> darkweb:${destPath}`);

            if (file.endsWith(".data.txt")) {
                const newHints = parseDataFile(content);
                for (const h of newHints) {
                    const line = serializeHint(h);
                    if (!hintAlreadyKnown(hints, h)) {
                        ns.write(HINTS_FILE, line + "\n", "a");
                        applyHint(hints, h);
                        tp(ns, `[dnet-explore] New hint from ${host}: ${line}`);
                    }
                }
            }

            ns.rm(file);
            ns.rm(destPath);
        } else {
            // .lit/.msg/.lore/.log — scp flat to home
            const ok = await ns.scp(file, LORE_DEST, host);
            ns.print(`       ${ok ? "Copied" : "FAILED"}: ${file} (flat copy to home)`);
        }
    }
}

/**
 * Parse a .data.txt file for password hints.
 * Returns array of hint objects.
 */
function parseDataFile(content) {
    const hints = [];

    // "The password for <host> contains X and Y" (and more)
    const serverRe = /password for (\S+) contains (.+)/gi;
    let m;
    while ((m = serverRe.exec(content)) !== null) {
        const host  = m[1];
        const chars = m[2].split(/\s*(?:and|,)\s*/).map(s => s.trim()).filter(Boolean);
        if (chars.length > 0) hints.push({ type: "server", host, chars });
    }

    // "Some common passwords include word1, word2, ..."
    const dictRe = /(?:common passwords include|passwords include)\s+(.+)/i;
    const dictM  = content.match(dictRe);
    if (dictM) {
        const words = dictM[1].split(/,\s*/).map(s => s.trim()).filter(Boolean);
        if (words.length > 0) hints.push({ type: "dict", words });
    }

    return hints;
}

function serializeHint(h) {
    if (h.type === "server") return `server:${h.host}:${h.chars.join(",")}`;
    if (h.type === "dict")   return `dict:${h.words.join(",")}`;
    return "";
}

function hintAlreadyKnown(hints, h) {
    if (h.type === "server") return hints.server[h.host] !== undefined;
    if (h.type === "dict")   return hints.dict.size > 0; // simple: don't double-add dict lists
    return false;
}

function applyHint(hints, h) {
    if (h.type === "server") hints.server[h.host] = (hints.server[h.host] || []).concat(h.chars);
    if (h.type === "dict")   for (const w of h.words) hints.dict.add(w);
}

/** Load hints from file into { server: {host: chars[]}, dict: Set<string> } */
function loadHints(ns) {
    const result = { server: {}, dict: new Set() };
    const raw = ns.read(HINTS_FILE);
    if (!raw) return result;
    for (const line of raw.split("\n")) {
        if (line.startsWith("server:")) {
            const parts = line.slice(7).split(":");
            if (parts.length < 2) continue;
            const [host, charStr] = parts;
            result.server[host] = (result.server[host] || []).concat(charStr.split(",").map(s => s.trim()));
        } else if (line.startsWith("dict:")) {
            for (const w of line.slice(5).split(",")) result.dict.add(w.trim());
        }
    }
    return result;
}

// ─── Authentication ───────────────────────────────────────────────────────────

async function tryAuthenticate(ns, host, details, passwords, hints) {
    const model = details.modelId;
    const hint  = details.passwordHint ?? "";

    if (passwords[host] !== undefined) {
        const r = await ns.dnet.authenticate(host, passwords[host]);
        if (r.success) return passwords[host];
    }

    switch (model) {
        case "ZeroLogon": {
            const r = await ns.dnet.authenticate(host, "");
            if (r.success) { tp(ns, `    -> AUTH OK  [ZeroLogon]: ${host}`); return ""; }
            tp(ns, `    -> AUTH FAIL [ZeroLogon]: ${host}`);
            return null;
        }

        case "FreshInstall_1.0": {
            const freshDefaults = [
                "0000", "12345", "admin", "password",
                "1234", "123456", "root", "guest", "default", "",
            ];
            for (const pwd of freshDefaults) {
                const r = await ns.dnet.authenticate(host, pwd);
                if (r.success) { tp(ns, `[dnet-explore] AUTH OK [FreshInstall] pwd="${pwd}": ${host}`); return pwd; }
            }
            tp(ns, `[dnet-explore] AUTH FAIL [FreshInstall] exhausted defaults: ${host}  hint="${hint}"`);
            return null;
        }

        case "DeskMemo_3.1": {
            const match = hint.match(/\d+/);
            if (!match) { tp(ns, `    -> SKIP [DeskMemo] no digits in hint: ${host}`); return null; }
            const r = await ns.dnet.authenticate(host, match[0]);
            if (r.success) { tp(ns, `    -> AUTH OK  [DeskMemo]: ${host}`); return match[0]; }
            tp(ns, `    -> AUTH FAIL [DeskMemo] tried "${match[0]}": ${host}`);
            return null;
        }

        case "PHP 5.4": {
            // Hint gives the password's digits sorted ("I accidentally sorted the
            // password: 059") — try every permutation of those digits, not the
            // sorted string itself.
            const match = hint.match(/\d+/);
            if (!match) { tp(ns, `    -> SKIP [PHP 5.4] no digits in hint: ${host}`); return null; }
            const permute = (digits) => {
                if (digits.length <= 1) return [digits];
                const out = [];
                for (let i = 0; i < digits.length; i++) {
                    const rest = digits.slice(0, i) + digits.slice(i + 1);
                    for (const p of permute(rest)) out.push(digits[i] + p);
                }
                return [...new Set(out)];
            };
            for (const candidate of permute(match[0])) {
                const r = await ns.dnet.authenticate(host, candidate);
                if (r.success) { tp(ns, `    -> AUTH OK  [PHP 5.4] pwd="${candidate}": ${host}`); return candidate; }
            }
            tp(ns, `    -> AUTH FAIL [PHP 5.4] exhausted permutations of "${match[0]}": ${host}`);
            return null;
        }

        case "AccountsManager_4.2": {
            // Hint may say "between 0 and N" — parse upper bound, default 10
            const rangeMatch = hint.match(/between\s+\d+\s+and\s+(\d+)/i);
            const maxVal = rangeMatch ? parseInt(rangeMatch[1]) : 10;
            // Use log hints to try likely digits first
            const { logs: amLogs } = await ns.dnet.heartbleed(host, { peek: true, logsToCapture: 10 });
            const hinted = new Set();
            const digitRe = /\b(\d+)\b/g;
            for (const log of amLogs) {
                if (/heartbeat check/.test(log)) continue;
                digitRe.lastIndex = 0;
                let dm;
                while ((dm = digitRe.exec(log)) !== null) {
                    const v = parseInt(dm[1]);
                    if (v >= 0 && v <= maxVal) hinted.add(v);
                }
            }
            // Try hinted values first, then full range
            const candidates = [...hinted, ...Array.from({length: maxVal + 1}, (_, i) => i).filter(i => !hinted.has(i))];
            for (const i of candidates) {
                const r = await ns.dnet.authenticate(host, String(i));
                if (r.success) { tp(ns, `    -> AUTH OK  [AccountsManager] pwd="${i}": ${host}`); return String(i); }
            }
            tp(ns, `    -> AUTH FAIL [AccountsManager] exhausted 0-${maxVal}: ${host}`);
            return null;
        }

        case "CloudBlare(tm)": {
            // Helper: extract digit-only string from a candidate value
            const digitsOnly = (s) => s ? String(s).replace(/\D/g, "") : "";

            const tryCaptchaFromLogs = async () => {
                // Poke to (re)generate captcha, then read logs
                await ns.dnet.authenticate(host, "0");
                const { logs: cbLogs } = await ns.dnet.heartbleed(host, { peek: true, logsToCapture: 10 });
                for (const log of cbLogs) {
                    let captcha = null;
                    try {
                        const parsed = JSON.parse(log);
                        if (parsed.data) captcha = digitsOnly(parsed.data);
                    } catch {}
                    if (!captcha) {
                        const dataMatch = log.match(/^[Dd]ata:\s*(.+)/);
                        if (dataMatch) captcha = digitsOnly(dataMatch[1]);
                    }
                    if (!captcha && !/\s/.test(log.trim())) captcha = digitsOnly(log);
                    if (!captcha || captcha.length === 0) continue;
                    const r = await ns.dnet.authenticate(host, captcha);
                    if (r.success) { tp(ns, `[dnet-explore] AUTH OK [CloudBlare] captcha="${captcha}": ${host}`); return captcha; }
                }
                return cbLogs.length === 0 ? null : "fail";
            };

            // Try up to 3 times — parallel instances can race and empty the log
            // NOTE: "attempt" keyword triggers false codingcontract.attempt RAM charge (Bitburner bug) — use "tries" instead
            for (let tries = 0; tries < 3; tries++) {
                const result = await tryCaptchaFromLogs();
                if (result && result !== "fail") return result;
                if (result === "fail") break; // logs non-empty but captcha not found — no point retrying
                // logs were empty — poke again
            }
            const { logs: finalLogs } = await ns.dnet.heartbleed(host, { peek: true, logsToCapture: 10 });
            tp(ns, `[dnet-explore] AUTH FAIL [CloudBlare] no captcha found: ${host} logs=${JSON.stringify(finalLogs)}`);
            return null;
        }

        case "Factori-Os": {
            // Hint gives divisor; length comes directly from details.passwordLength
            // (same field the NIL solver uses) — no need to probe for it.
            const divisorMatch = hint.match(/divisible by (\d+)/i);
            if (!divisorMatch) {
                tp(ns, `[dnet-explore] SKIP [Factori-Os] can't parse divisor from hint on ${host}: "${hint}"`);
                return null;
            }
            const divisor = parseInt(divisorMatch[1]);
            const length = details.passwordLength;
            if (!length) {
                tp(ns, `[dnet-explore] SKIP [Factori-Os] no passwordLength on details: ${host} details=${JSON.stringify(details)}`);
                return null;
            }
            const max = Math.pow(10, length);
            tp(ns, `[dnet-explore] [Factori-Os] divisor=${divisor} length=${length} candidates=${Math.ceil(max/divisor)}: ${host}`);
            for (let i = 0; i < max; i++) {
                if (i % divisor !== 0) continue;
                const pwd = String(i).padStart(length, "0");
                const r = await ns.dnet.authenticate(host, pwd);
                if (r.success) { tp(ns, `[dnet-explore] AUTH OK [Factori-Os] pwd="${pwd}": ${host}`); return pwd; }
            }
            tp(ns, `[dnet-explore] AUTH FAIL [Factori-Os] exhausted all ${length}-digit multiples of ${divisor}: ${host}`);
            return null;
        }

        case "Pr0verFl0": {
            const match = hint.match(/(\d+)\s+bytes/);
            if (!match) { tp(ns, `    -> SKIP [Pr0verFl0] can't parse buffer size from hint: ${host}`); return null; }
            const bufSize = parseInt(match[1]);
            for (let extra = 1; extra <= 20; extra++) {
                const payload = "A".repeat(bufSize + extra);
                const r = await ns.dnet.authenticate(host, payload);
                if (r.success) { tp(ns, `    -> AUTH OK  [Pr0verFl0] overflow=${bufSize}+${extra}: ${host}`); return payload; }
            }
            tp(ns, `    -> AUTH FAIL [Pr0verFl0] exhausted overflow lengths 1-20: ${host}`);
            return null;
        }

        case "DeepGreen": {
            const requiredChars = hints.server[host] || [];
            const pwdLength = await detectMastermindLength(ns, host);
            if (!pwdLength) {
                tp(ns, `    -> SKIP [DeepGreen] cannot determine password length: ${host} — dumping logs:`);
                const { logs: dgDump } = await ns.dnet.heartbleed(host, { peek: true, logsToCapture: 10 });
                for (const l of dgDump) tp(ns, `  [DeepGreen log] ${l}`);
                return null;
            }
            const password = await solveMastermind(ns, host, pwdLength, requiredChars);
            if (password !== null) {
                tp(ns, `    -> AUTH OK  [DeepGreen] pwd="${password}": ${host}`);
                return password;
            }
            tp(ns, `    -> AUTH FAIL [DeepGreen] Mastermind solver exhausted: ${host}`);
            return null;
        }

        case "BellaCuore": {
            // Hint contains a Roman numeral: "The password is the value of the number 'LXXVIII'"
            const rnMatch = hint.match(/['"'']([IVXLCDM]+)['"'']/i);
            if (!rnMatch) { tp(ns, `    -> SKIP [BellaCuore] no Roman numeral in hint: ${host}`); return null; }
            const value = String(fromRoman(rnMatch[1].toUpperCase()));
            const r = await ns.dnet.authenticate(host, value);
            if (r.success) { tp(ns, `    -> AUTH OK  [BellaCuore] ${rnMatch[1]}=${value}: ${host}`); return value; }
            tp(ns, `    -> AUTH FAIL [BellaCuore] tried "${value}": ${host}`);
            return null;
        }

        case "OctantVoxel": {
            // Hint: "the password is the base X number NNNN in base Y"
            // Ambiguous: could mean convert NNNN from base X to Y, or from Y to X.
            // Try both directions.
            const ovMatch = hint.match(/base\s+(\d+)\s+number\s+([0-9a-zA-Z]+)\s+in\s+base\s+(\d+)/i);
            if (!ovMatch) { tp(ns, `[dnet-explore] SKIP [OctantVoxel] can't parse hint on ${host}: "${hint}"`); return null; }
            const baseA  = parseInt(ovMatch[1]);
            const numStr = ovMatch[2];
            const baseB  = parseInt(ovMatch[3]);
            // Direction 1: numStr is in baseA, express in baseB
            const v1 = parseInt(numStr, baseA);
            if (!isNaN(v1)) {
                const pwd1 = v1.toString(baseB);
                const r1 = await ns.dnet.authenticate(host, pwd1);
                if (r1.success) { tp(ns, `[dnet-explore] AUTH OK [OctantVoxel] ${numStr}(b${baseA})->${pwd1}(b${baseB}): ${host}`); return pwd1; }
            }
            // Direction 2: numStr is in baseB, express in baseA
            const v2 = parseInt(numStr, baseB);
            if (!isNaN(v2)) {
                const pwd2 = v2.toString(baseA);
                const r2 = await ns.dnet.authenticate(host, pwd2);
                if (r2.success) { tp(ns, `[dnet-explore] AUTH OK [OctantVoxel] ${numStr}(b${baseB})->${pwd2}(b${baseA}): ${host}`); return pwd2; }
            }
            tp(ns, `[dnet-explore] AUTH FAIL [OctantVoxel] tried both directions: ${host}  hint="${hint}"`);
            return null;
        }

        case "Laika4": {
            // Password is a dog name.
            const DOG_NAMES = ["fido", "spot", "max", "rover", "laika"];
            const allNames = [...new Set([...DOG_NAMES, ...hints.dict])];
            for (const name of allNames) {
                const r = await ns.dnet.authenticate(host, name);
                if (r.success) { tp(ns, `[dnet-explore] AUTH OK [Laika4] pwd="${name}": ${host}`); return name; }
            }
            tp(ns, `[dnet-explore] AUTH FAIL [Laika4] exhausted ${allNames.length} names: ${host}`);
            return null;
        }

        case "NIL": {
            // Per-position numeric feedback: "yes" = correct digit, "yesn't" = wrong.
            // Token count reflects GUESS length, not password length — use details.passwordLength.
            // details.data holds the live feedback string directly (no heartbleed needed).

            const length = details.passwordLength;
            if (!length) {
                tp(ns, `[dnet-explore] SKIP [NIL] no passwordLength on details: ${host} details=${JSON.stringify(details)}`);
                return null;
            }

            const getNilFeedback = async (pwd) => {
                const r = await ns.dnet.authenticate(host, pwd);
                if (r.success) return { success: true };
                // details.data holds the live feedback string — re-fetch details after auth
                const d = ns.dnet.getServerDetails(host);
                const fb = parseNilFeedback([`data: ${d.data}`]);
                return { success: false, tokens: fb ? fb.tokens : null };
            };

            // Step 1: all-zeros probe for initial feedback
            const digits = Array(length).fill(0);
            const locked = Array(length).fill(false);
            const init = await getNilFeedback(digits.join(""));
            if (init.success) { tp(ns, `[dnet-explore] AUTH OK [NIL] pwd="${digits.join("")}": ${host}`); return digits.join(""); }
            if (init.tokens) for (let i = 0; i < length; i++) if (init.tokens[i] === "yes") locked[i] = true;

            // Step 2: increment wrong positions 1–9 until each locks
            for (let pos = 0; pos < length; pos++) {
                if (locked[pos]) continue;
                for (let d = 1; d <= 9; d++) {
                    digits[pos] = d;
                    const res = await getNilFeedback(digits.join(""));
                    if (res.success) { tp(ns, `[dnet-explore] AUTH OK [NIL] pwd="${digits.join("")}": ${host}`); return digits.join(""); }
                    if (res.tokens && res.tokens[pos] === "yes") { locked[pos] = true; break; }
                }
                if (!locked[pos]) {
                    tp(ns, `[dnet-explore] AUTH FAIL [NIL] couldn't lock position ${pos}: ${host}`);
                    return null;
                }
            }
            tp(ns, `[dnet-explore] AUTH FAIL [NIL] all positions locked but never succeeded: ${host}`);
            return null;
        }

        case "OpenWebAccessPoint": {
            // Empty auth triggers a log entry leaking the password inside a
            // badly-redacted string: [REDACTE megacorp:4127:271285 D]
            // The password is the last colon-separated segment before " D]".
            await ns.dnet.authenticate(host, "");
            const { logs: owLogs } = await ns.dnet.heartbleed(host, { peek: true, logsToCapture: 10 });
            for (const log of owLogs) {
                let data = null;
                try { data = JSON.parse(log).data; } catch {}
                if (!data) {
                    const dm = log.match(/^data:\s*(.+)/i);
                    if (dm) data = dm[1];
                }
                if (!data) continue;
                // Password is the last all-digit segment following a colon in the data
                const colonRe = /:(\d+)/g;
                let colonMatch, lastDigits = null;
                colonRe.lastIndex = 0;
                while ((colonMatch = colonRe.exec(data)) !== null) lastDigits = colonMatch[1];
                if (!lastDigits) continue;
                const pwd = lastDigits;
                const r = await ns.dnet.authenticate(host, pwd);
                if (r.success) { tp(ns, `[dnet-explore] AUTH OK [OpenWebAccessPoint] pwd="${pwd}": ${host}`); return pwd; }
                tp(ns, `[dnet-explore] AUTH FAIL [OpenWebAccessPoint] tried "${pwd}": ${host}`);
                return null;
            }
            tp(ns, `[dnet-explore] AUTH FAIL [OpenWebAccessPoint] no redacted leak found: ${host} logs=${JSON.stringify(owLogs)}`);
            return null;
        }

        default: {
            // Try server-specific hints first, then full dictionary
            const serverChars = hints.server[host];
            if (serverChars && serverChars.length > 0) {
                tp(ns, `    -> Trying server-specific hints for ${host}: must contain [${serverChars.join(", ")}]`);
            }

            for (const word of hints.dict) {
                if (serverChars && !serverChars.every(c => word.includes(c))) continue;
                const r = await ns.dnet.authenticate(host, word);
                if (r.success) {
                    tp(ns, `    -> AUTH OK  [dict] pwd="${word}": ${host}`);
                    return word;
                }
            }

            if (hints.dict.size > 0) tp(ns, `    -> FAIL [dict] exhausted ${hints.dict.size} words: ${host}`);
            tp(ns, `    -> SKIP (unknown model "${model}"): ${host}  hint="${hint}"`);
            return null;
        }
    }
}

// ─── DeepGreen (Mastermind) ───────────────────────────────────────────────────

async function detectMastermindLength(ns, host) {
    const { logs } = await ns.dnet.heartbleed(host, { peek: true, logsToCapture: 10 });
    const lengths = [];
    for (let i = 0; i < logs.length; i++) {
        const pa = logs[i].match(/^passwordAttempted:\s*(\S+)/);
        if (!pa) continue;
        const nearby = logs.slice(Math.max(0, i - 3), Math.min(logs.length, i + 3));
        if (nearby.some(l => /^data:\s*\d+,\d+/.test(l))) lengths.push(String(pa[1]).length);
    }
    if (lengths.length > 0) {
        const freq = {};
        for (const l of lengths) freq[l] = (freq[l] || 0) + 1;
        return parseInt(Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0]);
    }
    for (let len = 1; len <= 6; len++) {
        const guess = "0".repeat(len);
        const r = await ns.dnet.authenticate(host, guess);
        if (r.success) return len;
        const { logs: pl } = await ns.dnet.heartbleed(host, { peek: true, logsToCapture: 10 });
        if (pl.some(l => /^data:\s*\d+,\d+/.test(l))) return len;
    }
    return 0;
}

async function solveMastermind(ns, host, length, requiredChars) {
    const total = Math.pow(10, length);
    let candidates = [];
    for (let i = 0; i < total; i++) {
        const c = String(i).padStart(length, "0");
        if (requiredChars.every(ch => c.includes(ch))) candidates.push(c);
    }
    tp(ns, `    [DeepGreen] length=${length} requiredChars=[${requiredChars.join(",")}] candidates=${candidates.length}`);

    for (let round = 0; round < 20 && candidates.length > 0; round++) {
        const guess = candidates[0];
        const r = await ns.dnet.authenticate(host, guess);
        if (r.success) return guess;

        const { logs } = await ns.dnet.heartbleed(host, { peek: true, logsToCapture: 10 });
        const feedback = parseMastermindFeedback(logs);
        if (!feedback) {
            tp(ns, `    [DeepGreen] couldn't parse feedback after guess "${guess}", aborting`);
            tp(ns, `    Logs: ${JSON.stringify(logs.slice(0, 8))}`);
            return null;
        }

        const { exact, wrongPlace } = feedback;
        tp(ns, `    [DeepGreen] guess="${guess}" exact=${exact} wrong=${wrongPlace} remaining=${candidates.length}`);

        candidates = candidates.filter(c => {
            if (c === guess) return false;
            const s = scoreMastermind(guess, c);
            return s.exact === exact && s.wrongPlace === wrongPlace;
        });
    }
    return null;
}

function parseNilFeedback(logs) {
    // NIL model: data field is "yes,yes,yesn't,..." — one token per digit position.
    // Returns { tokens: string[], length: number, probeLength: number } or null.
    for (const l of logs) {
        let data = null;
        try { data = JSON.parse(l).data; } catch {}
        if (!data) {
            const m = l.match(/^data:\s*(.+)/i);
            if (m) data = m[1];
        }
        if (!data) continue;
        const tokens = data.split(",").map(s => s.trim()).filter(s => s === "yes" || s === "yesn't");
        if (tokens.length > 0) return { tokens, length: tokens.length };
    }
    return null;
}

function parseMastermindFeedback(logs) {
    for (const l of logs) {
        const m = l.match(/^data:\s*(\d+),(\d+)/);
        if (m) return { exact: parseInt(m[1]), wrongPlace: parseInt(m[2]) };
    }
    return null;
}

function scoreMastermind(guess, secret) {
    let exact = 0;
    const gCount = {};
    const sCount = {};
    for (let i = 0; i < guess.length; i++) {
        if (guess[i] === secret[i]) {
            exact++;
        } else {
            gCount[guess[i]] = (gCount[guess[i]] || 0) + 1;
            sCount[secret[i]] = (sCount[secret[i]] || 0) + 1;
        }
    }
    let wrongPlace = 0;
    for (const d in gCount) wrongPlace += Math.min(gCount[d], sCount[d] || 0);
    return { exact, wrongPlace };
}

// ─── Roman numeral parser ─────────────────────────────────────────────────────

function fromRoman(s) {
    const vals = { I:1, V:5, X:10, L:50, C:100, D:500, M:1000 };
    let total = 0;
    for (let i = 0; i < s.length; i++) {
        const cur  = vals[s[i]]  || 0;
        const next = vals[s[i+1]] || 0;
        total += cur < next ? -cur : cur;
    }
    return total;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function probeAdjacent(ns) {
    try {
        return ns.dnet.probe();
    } catch (e) {
        tp(ns, "ERROR: ns.dnet.probe() failed — is DarkscapeNavigator.exe present?");
        return [];
    }
}

function printNode(ns, host, d) {
    const online  = d.isOnline   ? "[ONLINE] " : "[OFFLINE]";
    const session = d.hasSession ? "[SESSION]" : "         ";
    const adj     = d.isConnectedToCurrentServer ? "[ADJ]" : "     ";
    const hint    = d.passwordHint ? `  hint="${d.passwordHint}"` : "";
    tp(ns, `  ${online} ${session} ${adj}  ${host}  model=${d.modelId ?? "?"}${hint}`);
}

function loadPasswords(ns) {
    const raw = ns.read(PASS_FILE);
    if (!raw) return {};
    const result = {};
    for (const line of raw.split("\n")) {
        const idx = line.indexOf("=");
        if (idx === -1) continue;
        result[line.slice(0, idx)] = line.slice(idx + 1);
    }
    return result;
}

function writeNodeMap(ns, host, nodes) {
    const lines = [`Darknet scan from: ${host}`, "=".repeat(60), ""];
    for (const [h, d] of Object.entries(nodes)) {
        lines.push(`Host:    ${h}`);
        lines.push(`  Online:  ${d.isOnline}`);
        lines.push(`  Session: ${d.hasSession}`);
        lines.push(`  Model:   ${d.modelId ?? "unknown"}`);
        if (d.passwordHint) lines.push(`  Hint:    ${d.passwordHint}`);
        lines.push("");
    }
    ns.write(`darknet/map/${host}.txt`, lines.join("\n"), "w");
}
