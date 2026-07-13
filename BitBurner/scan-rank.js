/** @param {NS} ns */
export async function main(ns) {
    ns.disableLog("ALL");

    // Full BFS — no depth limit
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

    const playerHackLevel = ns.getHackingLevel();

    // --- RAM tally: all rooted servers in visited (including home) ---
    // Home reserves 40 GB for management scripts.
    let totalWorkerRam = 0;
    for (const host of visited) {
        const sv = ns.getServer(host);
        if (!sv.hasAdminRights) continue;
        const maxRam  = ns.getServerMaxRam(host);
        const usedRam = ns.getServerUsedRam(host);
        const freeRam = maxRam - usedRam;
        if (host === "home") {
            totalWorkerRam += Math.max(0, freeRam - 40);
        } else {
            totalWorkerRam += Math.max(0, freeRam);
        }
    }

    const HACK_FRAC = 0.50;
    const RAM_HACK   = 1.70;  // GB per thread
    const RAM_WEAKEN = 1.75;  // GB per thread
    const RAM_GROW   = 1.75;  // GB per thread

    const results = [];

    for (const host of servers) {
        const s = ns.getServer(host);

        if (s.purchasedByPlayer) continue;
        if (s.requiredHackingSkill > playerHackLevel) continue;
        if (!s.moneyMax || s.moneyMax <= 0) continue;

        const hackChance  = ns.hackAnalyzeChance(host);
        const weakenTime  = ns.getWeakenTime(host);   // longest op; bottleneck for batching

        // Score: money per second throughput proxy.
        // moneyMax / minDifficulty weights quality; dividing by weakenTime favors fast targets.
        const score = (s.moneyMax / s.minDifficulty) * hackChance / weakenTime;

        // --- Batch RAM calculation ---
        const hackPerThread  = ns.hackAnalyze(host);          // fraction stolen per hack thread
        const hackThreads    = Math.max(1, Math.floor(HACK_FRAC / hackPerThread));
        const w1Threads      = Math.ceil(hackThreads * 0.04);
        const growThreads    = Math.ceil(ns.growthAnalyze(host, 2.0));
        const w2Threads      = Math.ceil(growThreads * 0.08);
        const batchRamGB     = (w1Threads + w2Threads + growThreads) * RAM_WEAKEN
                             + hackThreads * RAM_HACK;
        const fits           = batchRamGB <= totalWorkerRam;

        results.push({
            host,
            moneyMax:    s.moneyMax,
            minSec:      s.minDifficulty,
            curSec:      s.hackDifficulty,
            hackReq:     s.requiredHackingSkill,
            hackChance,
            growth:      s.serverGrowth,
            portsNeeded: s.numOpenPortsRequired,
            hasRoot:     s.hasAdminRights,
            weakenTime,
            score,
            batchRamGB,
            fits,
        });
    }

    results.sort((a, b) => b.score - a.score);

    function fmt(n) {
        if (n >= 1e9) return (n / 1e9).toFixed(2) + "b";
        if (n >= 1e6) return (n / 1e6).toFixed(2) + "m";
        if (n >= 1e3) return (n / 1e3).toFixed(2) + "k";
        return n.toFixed(0);
    }

    function fmtRam(gb) {
        if (gb >= 1024 * 1024) return (gb / (1024 * 1024)).toFixed(2) + " PB";
        if (gb >= 1024)        return (gb / 1024).toFixed(2) + " TB";
        return gb.toFixed(0) + " GB";
    }

    const header = [
        "HOST".padEnd(22),
        "MAX $".padStart(9),
        "MIN-SEC".padStart(8),
        "CHANCE".padStart(8),
        "GROWTH".padStart(7),
        "W-TIME".padStart(8),
        "PORTS".padStart(6),
        "ROOT".padStart(5),
        "SCORE".padStart(14),
        "BATCH-RAM".padStart(10),
        "FITS".padStart(5),
    ].join(" ");

    ns.tprint(`=== SCAN-ANALYZE (full network) — targets hackable at level ${playerHackLevel} ===`);
    ns.tprint(`Total available worker RAM: ${fmtRam(totalWorkerRam)}`);
    ns.tprint(header);
    ns.tprint("-".repeat(header.length));

    for (const r of results) {
        const row = [
            r.host.padEnd(22),
            fmt(r.moneyMax).padStart(9),
            r.minSec.toFixed(1).padStart(8),
            ((r.hackChance * 100).toFixed(1) + "%").padStart(8),
            String(r.growth).padStart(7),
            (Math.round(r.weakenTime / 1000) + "s").padStart(8),
            String(r.portsNeeded).padStart(6),
            (r.hasRoot ? "YES" : "no").padStart(5),
            fmt(r.score * 1000).padStart(14),  // scaled for readability
            fmtRam(r.batchRamGB).padStart(10),
            (r.fits ? "YES" : "no").padStart(5),
        ].join(" ");
        ns.tprint(row);
    }

    ns.tprint("-".repeat(header.length));

    if (results.length === 0) {
        ns.tprint(`No servers found within hack level ${playerHackLevel}.`);
        return;
    }

    const best = results[0];
    if (best.fits) {
        ns.tprint(`OPTIMAL TARGET: ${best.host}`);
        ns.tprint(`  Max money: ${fmt(best.moneyMax)}  |  Min security: ${best.minSec}  |  Hack chance: ${(best.hackChance * 100).toFixed(1)}%`);
        ns.tprint(`  Weaken time: ${Math.round(best.weakenTime / 1000)}s  |  Ports needed: ${best.portsNeeded}  |  Root access: ${best.hasRoot ? "YES" : "NO — need to nuke first"}`);
        ns.tprint(`  Batch RAM needed: ${fmtRam(best.batchRamGB)}  |  Worker RAM available: ${fmtRam(totalWorkerRam)}`);
        ns.tprint(`  Score formula: (maxMoney / minSecurity × hackChance) / weakenTime`);
    } else {
        ns.tprint(`OPTIMAL TARGET (${best.host}) does NOT fit — needs ${fmtRam(best.batchRamGB)}, only ${fmtRam(totalWorkerRam)} available.`);
        const bestFit = results.find(r => r.fits);
        if (bestFit) {
            ns.tprint(`BEST FITTING TARGET: ${bestFit.host}`);
            ns.tprint(`  Max money: ${fmt(bestFit.moneyMax)}  |  Min security: ${bestFit.minSec}  |  Hack chance: ${(bestFit.hackChance * 100).toFixed(1)}%`);
            ns.tprint(`  Weaken time: ${Math.round(bestFit.weakenTime / 1000)}s  |  Ports needed: ${bestFit.portsNeeded}  |  Root access: ${bestFit.hasRoot ? "YES" : "NO — need to nuke first"}`);
            ns.tprint(`  Batch RAM needed: ${fmtRam(bestFit.batchRamGB)}  |  Worker RAM available: ${fmtRam(totalWorkerRam)}`);
            ns.tprint(`  Score formula: (maxMoney / minSecurity × hackChance) / weakenTime`);
        } else {
            ns.tprint(`No targets fit in current worker RAM (${fmtRam(totalWorkerRam)}). Expand your server fleet first.`);
        }
    }
}
