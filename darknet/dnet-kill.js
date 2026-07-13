/** dnet-kill.js
 * Kills all running dnet-explore.js instances across the standard network,
 * darkweb, and any darknet servers recorded in the password file.
 * Usage: run darknet/dnet-kill.js
 */

const SCRIPT    = "darknet/dnet-explore.js";
const PASS_FILE = "darknet/dnet-passwords.txt";

/** @param {NS} ns */
export async function main(ns) {
    ns.disableLog("ALL");

    const killed  = [];
    const failed  = [];
    const checked = new Set();

    function tryKill(host) {
        if (checked.has(host)) return;
        checked.add(host);
        try {
            if (ns.kill(SCRIPT, host)) killed.push(host);
        } catch { failed.push(host); }
    }

    // Standard network BFS
    const queue = ["home"];
    const visited = new Set(["home"]);
    while (queue.length) {
        for (const n of ns.scan(queue.shift())) {
            if (!visited.has(n)) { visited.add(n); queue.push(n); }
        }
    }
    for (const host of visited) tryKill(host);

    // Darkweb hub (not in standard BFS)
    tryKill("darkweb");

    // Darknet hosts from password file — use connectToSession to reach them
    const raw = ns.read(PASS_FILE);
    if (raw) {
        for (const line of raw.split("\n")) {
            const idx = line.indexOf("=");
            if (idx === -1) continue;
            const host     = line.slice(0, idx);
            const password = line.slice(idx + 1);
            if (checked.has(host)) continue;
            try {
                ns.dnet.connectToSession(host, password);
            } catch { /* offline or stale password */ }
            tryKill(host);
        }
    }

    if (killed.length === 0) ns.tprint("[dnet-kill] No dnet-explore instances found.");
    else ns.tprint(`[dnet-kill] Killed on: ${killed.join(", ")}`);
    if (failed.length > 0) ns.tprint(`[dnet-kill] Unreachable (offline?): ${failed.join(", ")}`);
}
