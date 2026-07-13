/** @param {NS} ns */
export async function main(ns) {
    ns.disableLog("ALL");

    // BFS full network scan (no depth limit)
    const visited = new Set(["home"]);
    const queue = ["home"];
    const servers = [];

    while (queue.length > 0) {
        const host = queue.shift();
        if (host !== "home") servers.push(host);
        for (const neighbor of ns.scan(host)) {
            if (!visited.has(neighbor)) {
                visited.add(neighbor);
                queue.push(neighbor);
            }
        }
    }

    const openers = [
        { fn: (h) => ns.brutessh(h),   name: "BruteSSH" },
        { fn: (h) => ns.ftpcrack(h),   name: "FTPCrack" },
        { fn: (h) => ns.relaysmtp(h),  name: "relaySMTP" },
        { fn: (h) => ns.httpworm(h),   name: "HTTPWorm" },
        { fn: (h) => ns.sqlinject(h),  name: "SQLInject" },
    ];

    let nuked = 0;
    let alreadyOwned = 0;
    let failed = 0;

    for (const host of servers) {
        const s = ns.getServer(host);

        if (s.purchasedByPlayer) continue;

        if (s.hasAdminRights) {
            alreadyOwned++;
            continue;
        }

        // Count only ports opened in this run — start at 0, not s.openPortCount
        let opened = 0;
        for (const op of openers) {
            try {
                op.fn(host);
                opened++;
            } catch (_) { /* program not owned */ }
        }

        if (opened >= s.numOpenPortsRequired) {
            ns.nuke(host);
            ns.tprint(`SUCCESS  ${host} — nuked (${s.numOpenPortsRequired} port(s) needed)`);
            nuked++;
        } else {
            ns.tprint(`SKIPPED  ${host} — need ${s.numOpenPortsRequired} ports, only opened ${opened}`);
            failed++;
        }
    }

    ns.tprint("─────────────────────────────────────────");
    ns.tprint(`Done. Nuked: ${nuked}  |  Already owned: ${alreadyOwned}  |  Skipped: ${failed}`);
}
