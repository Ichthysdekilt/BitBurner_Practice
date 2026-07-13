/** @param {NS} ns */
export async function main(ns) {
    ns.disableLog("ALL");

    // BFS — track parent for path reconstruction
    const parent = new Map([["home", null]]);
    const queue = ["home"];

    while (queue.length > 0) {
        const host = queue.shift();
        for (const neighbor of ns.scan(host)) {
            if (!parent.has(neighbor)) {
                parent.set(neighbor, host);
                queue.push(neighbor);
            }
        }
    }

    function pathTo(host) {
        const path = [];
        let cur = host;
        while (cur !== null) {
            path.unshift(cur);
            cur = parent.get(cur);
        }
        return path;
    }

    const playerHackLevel = ns.getHackingLevel();
    const todo = [];

    for (const host of parent.keys()) {
        if (host === "home") continue;
        const s = ns.getServer(host);
        if (s.purchasedByPlayer) continue;
        if (!s.hasAdminRights) continue;
        if (s.backdoorInstalled) continue;
        if (s.requiredHackingSkill > playerHackLevel) continue;
        todo.push(host);
    }

    if (todo.length === 0) {
        ns.tprint("All rooted servers already have backdoor installed.");
        return;
    }

    ns.tprint(`=== BACKDOOR TODO — ${todo.length} server(s) ===`);
    ns.tprint("");

    for (const host of todo) {
        const connectChain = pathTo(host).slice(1).map(h => `connect ${h}`).join("; ");
        ns.tprint(`${host}`);
        ns.tprint(`  home; ${connectChain}; backdoor`);
        ns.tprint("");
    }
}
