/** @param {NS} ns */
export async function main(ns) {
    ns.disableLog("ALL");

    const POLL_MS = 30_000;
    const MAX_RAM = ns.cloud.getRamLimit();

    function fmtRam(gb) {
        if (gb >= 1024 * 1024) return (gb / (1024 * 1024)).toFixed(2) + " PB";
        if (gb >= 1024)        return (gb / 1024).toFixed(2) + " TB";
        return gb.toFixed(0) + " GB";
    }

    const servers = ns.cloud.getServerNames();
    if (servers.length === 0) {
        ns.tprint("[upgrade-servers] No purchased servers found. Run buy-servers.js first.");
        return;
    }

    // Print initial server listing
    ns.tprint("[upgrade-servers] Starting — current server RAM:");
    for (const host of servers) {
        ns.tprint(`  ${host.padEnd(20)} ${fmtRam(ns.getServerMaxRam(host))}`);
    }
    ns.tprint(`  (max upgradeable: ${fmtRam(MAX_RAM)})`);

    while (true) {
        const hosts = ns.cloud.getServerNames();

        // Find the server with the least RAM
        let target = null;
        let minRam = Infinity;
        for (const host of hosts) {
            const ram = ns.getServerMaxRam(host);
            if (ram < minRam) { minRam = ram; target = host; }
        }

        const nextRam = minRam * 2;
        if (nextRam > MAX_RAM) {
            ns.tprint("[upgrade-servers] All servers are at max RAM. Done.");
            return;
        }

        const cost  = ns.cloud.getServerUpgradeCost(target, nextRam);
        const money = ns.getPlayer().money;

        if (money >= cost) {
            const ok = ns.cloud.upgradeServer(target, nextRam);
            if (!ok) {
                ns.tprint(`[upgrade-servers] ERROR: upgradeServer failed for ${target}`);
            } else {
                ns.print(`[upgrade-servers] Upgraded ${target}: ${fmtRam(minRam)} → ${fmtRam(nextRam)}`);
            }
        } else {
            ns.print(`[upgrade-servers] Waiting: need $${ns.format.number(cost)} for ${target} → ${fmtRam(nextRam)} (have $${ns.format.number(money)})`);
        }

        await ns.sleep(POLL_MS);
    }
}
