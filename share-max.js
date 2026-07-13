/** @param {NS} ns */
export async function main(ns) {
    ns.disableLog("ALL");

    const SHARE_RAM   = 4;
    const HOME_RESERVE = 40;
    const POLL_MS     = 10_500; // slightly longer than ns.share() duration (10s)

    function allRooted() {
        const visited = new Set(["home"]);
        const queue   = ["home"];
        while (queue.length > 0) {
            for (const n of ns.scan(queue.shift())) {
                if (!visited.has(n)) { visited.add(n); queue.push(n); }
            }
        }
        return [...visited].filter(h => ns.hasRootAccess(h));
    }

    let servers = allRooted();
    ns.tprint(`[share-max] Distributing share.js to ${servers.length} servers...`);
    for (const host of servers) {
        if (host !== "home") await ns.scp("share.js", host);
    }

    let firstRun = true;
    while (true) {
        const fresh = allRooted();
        if (fresh.length !== servers.length) {
            const newHosts = fresh.filter(h => !servers.includes(h));
            for (const host of newHosts) await ns.scp("share.js", host);
            servers = fresh;
        }

        let totalThreads = 0;
        for (const host of servers) {
            const free = ns.getServerMaxRam(host) - ns.getServerUsedRam(host)
                       - (host === "home" ? HOME_RESERVE : 0);
            const threads = Math.floor(free / SHARE_RAM + 1e-9);
            if (threads > 0) {
                ns.exec("share.js", host, threads);
                totalThreads += threads;
            }
        }

        const cores = ns.getServer("home").cpuCores;
        const power = ns.fileExists("Formulas.exe", "home")
            ? ns.formulas.sharePower(totalThreads, cores)
            : Math.log(totalThreads * cores) / 25 + 1;
        if (firstRun) {
            ns.tprint(`[share-max] ${totalThreads} threads across ${servers.length} servers — rep gain: ${power.toFixed(4)}x`);
            firstRun = false;
        }

        await ns.sleep(POLL_MS);
    }
}
