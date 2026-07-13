/** @param {NS} ns */
export async function main(ns) {
    ns.disableLog("ALL");

    const flags  = ns.flags([["silent", false]]);
    const SILENT = flags.silent; // true: suppress ns.tprint (terminal) but keep ns.print (log window)
    const tprint = (...args) => { ns.print(...args); if (!SILENT) ns.tprint(...args); };

    const WORKERS     = ["hack.js", "grow.js", "weaken.js", "share.js"];
    const HACK_FRAC   = 0.50;
    const SPACING     = 50;   // ms between op landing times
    const BATCH_BUF   = 200;  // ms after batch completes before next
    const HOME_RESERVE = 40;  // GB to keep free on home

    // ── Network helpers ───────────────────────────────────────────────────────

    function allHosts() {
        const visited = new Set(["home"]);
        const queue   = ["home"];
        while (queue.length > 0) {
            for (const n of ns.scan(queue.shift())) {
                if (!visited.has(n)) { visited.add(n); queue.push(n); }
            }
        }
        return [...visited];
    }

    function getRootedServers() {
        return allHosts().filter(h => ns.hasRootAccess(h));
    }

    // Open ports and nuke any newly-crackable servers so target/worker selection
    // always sees the fullest possible fleet — port-opener programs and hacking
    // skill both improve over time, so this can't be a one-shot startup check.
    const OPENERS = [
        { fn: (h) => ns.brutessh(h),  name: "BruteSSH" },
        { fn: (h) => ns.ftpcrack(h),  name: "FTPCrack" },
        { fn: (h) => ns.relaysmtp(h), name: "relaySMTP" },
        { fn: (h) => ns.httpworm(h),  name: "HTTPWorm" },
        { fn: (h) => ns.sqlinject(h), name: "SQLInject" },
    ];

    function kickDoors() {
        let nuked = 0;
        for (const host of allHosts()) {
            const s = ns.getServer(host);
            if (s.purchasedByPlayer || s.hasAdminRights) continue;

            let opened = 0;
            for (const op of OPENERS) {
                try { op.fn(host); opened++; } catch (_) { /* program not owned */ }
            }
            if (opened >= s.numOpenPortsRequired) {
                ns.nuke(host);
                nuked++;
            }
        }
        return nuked;
    }

    // ns.exec returns 0 on failure (e.g. a RAM race where our map thought a host
    // was free but it wasn't) instead of throwing — silently ignoring that return
    // value means a launch can just vanish with no signal, indistinguishable from
    // a timing desync. Track failures so real launch failures show up in stats
    // separately from batch-timing desyncs.
    let execFailures = 0;
    let lastExecFailWarn = 0;
    function execChecked(script, host, threads, ...args) {
        const pid = ns.exec(script, host, threads, ...args);
        if (pid === 0) {
            execFailures++;
            const now = Date.now();
            if (now - lastExecFailWarn >= 60_000) {
                tprint(`[batcher] WARNING: ns.exec failed — ${script} x${threads} on ${host} (target ${args[0]})`);
                lastExecFailWarn = now;
            }
        }
        return pid;
    }

    async function distributeWorkers(servers) {
        for (const host of servers) {
            if (host === "home") continue;
            for (const w of WORKERS) await ns.scp(w, host);
        }
    }

    // ── RAM allocation ────────────────────────────────────────────────────────

    // Build a mutable free-RAM map for a coordinated multi-target allocation.
    function buildFreeRam(servers) {
        const map = new Map();
        for (const h of servers) {
            const raw = ns.getServerMaxRam(h) - ns.getServerUsedRam(h);
            map.set(h, h === "home" ? Math.max(0, raw - HOME_RESERVE) : Math.max(0, raw));
        }
        return map;
    }

    // Total RAM available for planning purposes — ignores what's currently
    // in flight, since selectTargets decides the target SET, not a live
    // allocation. Live allocation (prep/batch passes) still uses buildFreeRam.
    function buildTotalRam(servers) {
        const map = new Map();
        for (const h of servers) {
            const raw = ns.getServerMaxRam(h);
            map.set(h, h === "home" ? Math.max(0, raw - HOME_RESERVE) : raw);
        }
        return map;
    }

    // Attempt to fit `ops` into `freeRam`, mutating it on success.
    // Returns assignments array or null.
    function tryAllocOps(freeRam, ops) {
        const snapshot = new Map(freeRam);
        const results  = [];
        for (const op of ops) {
            const slots = [...snapshot.entries()]
                .filter(([, free]) => free >= op.ram)
                .sort((a, b) => b[1] - a[1]);
            let remaining   = op.threads;
            const assignments = [];
            for (const [host, free] of slots) {
                if (remaining <= 0) break;
                const t = Math.min(remaining, Math.floor(free / op.ram + 1e-9));
                if (t > 0) {
                    assignments.push({ host, threads: t });
                    snapshot.set(host, free - t * op.ram);
                    remaining -= t;
                }
            }
            if (remaining > 0) return null;
            results.push(assignments);
        }
        // Commit
        for (const [k, v] of snapshot) freeRam.set(k, v);
        return results;
    }

    // Allocate share threads from whatever free RAM remains in the map.
    function allocShareFromMap(freeRam) {
        const assignments = [];
        for (const [host, free] of freeRam) {
            const t = Math.floor(free / 4 + 1e-9);
            if (t > 0) assignments.push({ host, threads: t });
        }
        return assignments;
    }

    // ── Formulas API gate ─────────────────────────────────────────────────────

    const HAS_FORMULAS = ns.fileExists("Formulas.exe", "home");

    // Returns { hackThreads, w1Threads, growThreads, w2Threads } pinned to ideal
    // server state. Uses Formulas API when available, falls back to live estimates.
    function calcThreads(host) {
        const GROW_MULT = 1 / (1 - HACK_FRAC);
        if (HAS_FORMULAS) {
            const sv     = ns.getServer(host);
            const player = ns.getPlayer();
            // Pin to fully prepped state for accurate steady-state calculations
            sv.hackDifficulty = sv.minDifficulty;
            sv.moneyAvailable = sv.moneyMax;
            const hackPerT    = ns.formulas.hacking.hackPercent(sv, player);
            const hackThreads = Math.max(1, Math.floor(HACK_FRAC / hackPerT));
            const w1Threads   = Math.max(1, Math.ceil(hackThreads * 0.002 / 0.05));
            const growThreads = Math.ceil(ns.formulas.hacking.growThreads(sv, player, GROW_MULT));
            const w2Threads   = Math.max(1, Math.ceil(growThreads * 0.004 / 0.05));
            return { hackThreads, w1Threads, growThreads, w2Threads };
        } else {
            const hackPerT    = ns.hackAnalyze(host);
            const hackThreads = Math.max(1, Math.floor(HACK_FRAC / hackPerT));
            const w1Threads   = Math.max(1, Math.ceil(hackThreads * 0.002 / 0.05));
            const growThreads = Math.ceil(ns.growthAnalyze(host, GROW_MULT));
            const w2Threads   = Math.max(1, Math.ceil(growThreads * 0.004 / 0.05));
            return { hackThreads, w1Threads, growThreads, w2Threads };
        }
    }

    // Grow threads needed to reach maxMoney from the server's CURRENT money —
    // unlike calcThreads (which always plans from a pinned, fully-depleted state
    // for steady-state batch sizing), prep needs the threads for whatever partial
    // deficit actually exists right now. Uses Formulas when available for the
    // same precision calcThreads gets, falls back to growthAnalyze otherwise.
    function growThreadsFor(host, growMult) {
        if (HAS_FORMULAS) {
            const sv     = ns.getServer(host);
            const player = ns.getPlayer();
            return Math.ceil(ns.formulas.hacking.growThreads(sv, player, growMult));
        }
        return Math.ceil(ns.growthAnalyze(host, growMult));
    }

    // ── Target scoring ────────────────────────────────────────────────────────

    // Rough estimate of how long a target needs in 'prep' before it can start
    // batching: one weaken pass to shed security (if needed) followed by one
    // grow pass to restore money (if needed). Prep actually loops until it
    // converges, but a single pass covers the overwhelming majority of the
    // deficit, so this is a reasonable approximation for ranking purposes.
    function estimatePrepTime(host, sv) {
        let t = 0;
        if (sv.hackDifficulty > sv.minDifficulty + 0.05) t += ns.getWeakenTime(host);
        if (sv.moneyAvailable < sv.moneyMax * 0.99)       t += ns.getGrowTime(host);
        return t;
    }

    function scoredTargets() {
        const hackLevel = ns.getHackingLevel();
        return allHosts()
            .filter(h => {
                const s = ns.getServer(h);
                return !s.purchasedByPlayer && s.hasAdminRights &&
                       s.requiredHackingSkill <= hackLevel &&
                       s.moneyMax > 0;
            })
            .map(h => {
                const s = ns.getServer(h);
                const { hackThreads, w1Threads, growThreads, w2Threads } = calcThreads(h);
                const batchRam  = (w1Threads + w2Threads + growThreads) * 1.75 + hackThreads * 1.70;
                const weakenTime = ns.getWeakenTime(h);
                // $/sec if run forever, independent of RAM cost or time-to-first-payoff.
                const score = (s.moneyMax / s.minDifficulty) * ns.hackAnalyzeChance(h) / weakenTime;
                // Rank by $/sec per GB (RAM efficiency), discounted by how long this
                // target sits idle in prep relative to its own cycle time — a target
                // that needs several weakenTime's worth of prep before its first
                // payout is worth less *right now* than one that's ready to fire,
                // even if their steady-state scores are comparable.
                const prepTime   = estimatePrepTime(h, s);
                const prepPenalty = 1 + prepTime / weakenTime;
                const rank = (score / batchRam) / prepPenalty;
                return { host: h, score, rank, batchRam, prepTime, hackThreads, w1Threads, growThreads, w2Threads };
            })
            .sort((a, b) => b.rank - a.rank);
    }

    // ── Batch ops for a target ────────────────────────────────────────────────

    function batchOpsFor(t) {
        const weakenTime  = ns.getWeakenTime(t);
        const growTime    = ns.getGrowTime(t);
        const hackTime    = ns.getHackTime(t);
        const { hackThreads, w1Threads, growThreads, w2Threads } = threadOverrides.get(t) ?? calcThreads(t);

        return {
            weakenTime,
            ops: [
                { script: "weaken.js", threads: w1Threads,   delay: 0,                                  ram: 1.75 },
                { script: "weaken.js", threads: w2Threads,   delay: 2 * SPACING,                        ram: 1.75 },
                { script: "grow.js",   threads: growThreads, delay: Math.round(weakenTime - growTime + SPACING), ram: 1.75 },
                { script: "hack.js",   threads: hackThreads, delay: Math.round(weakenTime - hackTime - SPACING), ram: 1.70 },
            ],
        };
    }

    // ── Startup ───────────────────────────────────────────────────────────────

    tprint(`[batcher] Formulas API: ${HAS_FORMULAS ? "YES — using pinned thread calculations" : "no — using live estimates"}`);
    kickDoors();
    let servers = getRootedServers();
    tprint(`[batcher] distributing workers to ${servers.length} servers...`);
    await distributeWorkers(servers);

    // Pick initial target set: greedily add targets by score until RAM is exhausted
    const candidates = scoredTargets();
    if (candidates.length === 0) {
        tprint("[batcher] No eligible targets found.");
        return;
    }

    const threadOverrides = new Map(); // host -> scaled thread counts for partial targets

    // Currently-picked targets get a score bonus before sorting, so a new
    // candidate must beat them by more than HYSTERESIS_MARGIN to displace them.
    // Without this, a fresh greedy pack every RETARGET_INTERVAL can drop a
    // perfectly good in-progress target for a marginally-higher-scoring one,
    // discarding its prep/pipeline progress for a negligible gain.
    const HYSTERESIS_MARGIN = 1.15;

    // Greedy pack: claim targets in score order until a new one doesn't fit,
    // then try to squeeze in one partial target with whatever RAM remains.
    // Re-run periodically since RAM and hacking skill change which targets are best.
    function selectTargets(servers, currentTargets = [], { silent = false } = {}) {
        const cands = scoredTargets();
        if (cands.length === 0) return { targets: [], overrides: new Map() };

        const currentSet = new Set(currentTargets);
        cands.sort((a, b) => {
            const aKey = a.rank * (currentSet.has(a.host) ? HYSTERESIS_MARGIN : 1);
            const bKey = b.rank * (currentSet.has(b.host) ? HYSTERESIS_MARGIN : 1);
            return bKey - aKey;
        });

        const overrides = new Map();
        let freeRam = buildTotalRam(servers);
        const picked = [];
        for (const c of cands) {
            if (c.batchRam <= [...freeRam.values()].reduce((s, v) => s + v, 0)) {
                const ops = [
                    { ram: 1.75, threads: c.w1Threads },
                    { ram: 1.75, threads: c.w2Threads },
                    { ram: 1.75, threads: c.growThreads },
                    { ram: 1.70, threads: c.hackThreads },
                ];
                // Tentatively reserve this target's RAM
                const probe = tryAllocOps(new Map(freeRam), ops);
                if (probe) {
                    // Commit the reservation so subsequent targets see reduced RAM
                    tryAllocOps(freeRam, ops);
                    picked.push(c.host);
                }
            }
        }
        if (picked.length === 0) picked.push(cands[0].host);

        // Try to add next candidate as a partial target if ≥15% of its batch RAM fits
        const PARTIAL_MIN_FRAC = 0.15;
        const nextCand = cands.find(c => !picked.includes(c.host));
        if (nextCand) {
            const remainingFree = [...freeRam.values()].reduce((s, v) => s + v, 0);
            const frac = Math.min(1, remainingFree / nextCand.batchRam);
            if (frac >= PARTIAL_MIN_FRAC) {
                const scale = n => Math.max(1, Math.floor(n * frac));
                overrides.set(nextCand.host, {
                    hackThreads:  scale(nextCand.hackThreads),
                    w1Threads:    scale(nextCand.w1Threads),
                    growThreads:  scale(nextCand.growThreads),
                    w2Threads:    scale(nextCand.w2Threads),
                });
                picked.push(nextCand.host);
                if (!silent) tprint(`[batcher] Partial target: ${nextCand.host} at ${(frac * 100).toFixed(0)}% scale`);
            }
        }
        return { targets: picked, overrides };
    }

    let targets;
    if (flags._[0]) {
        targets = [flags._[0]];
        tprint(`[batcher] Manual target: ${flags._[0]}`);
    } else {
        const sel = selectTargets(servers);
        targets = sel.targets;
        for (const [host, ov] of sel.overrides) threadOverrides.set(host, ov);

        const totalRam = [...buildFreeRam(servers).values()].reduce((s, v) => s + v, 0);
        tprint(`[batcher] Auto-selected ${targets.length} target(s): ${targets.join(", ")}`);
        tprint(`[batcher] Total worker RAM: ${totalRam.toFixed(1)} GB`);
    }

    tprint(`[batcher] === UNIFIED LOOP (${targets.length} target(s)) ===`);

    // ── Per-target state: prep individually, batch as soon as each is ready ──
    // All allocations draw from the same freeRam map per tick — no double-booking
    // between prep and batch ops. Targets transition prep→batch independently, so
    // a 3000s prep on one target never blocks another that's already ready.

    const BATCH_INTERVAL   = 4 * SPACING;
    const SHARE_DURATION   = 10_500; // ns.share() runs for ~10s; respawn no faster than this
    const RETARGET_INTERVAL = 10 * 60_000; // re-evaluate best targets every 10 min

    let nextShareSpawn = 0;
    let nextRetarget    = Date.now() + RETARGET_INTERVAL;
    const manualTarget   = !!flags._[0];

    // Batch timing assumes each landing sees the target at min-security/max-money.
    // If a launch silently fails or ticks get skipped under RAM pressure, security
    // and money drift away from that assumption and hack chance degrades with no
    // visible symptom. These margins say "drifted enough to matter" — loose enough
    // to ignore normal one-batch noise, tight enough to catch real desync.
    //
    // Money is NOT a point-in-time check: a healthy pipeline legitimately dips to
    // ~(1 - HACK_FRAC) of max every single cycle (a hack just landed, its paired
    // grow hasn't landed yet) — that sawtooth is the batcher working as intended,
    // not desync. So low money only counts if it PERSISTS longer than one grow
    // cycle, i.e. the recovery that should have happened, didn't.
    const DESYNC_SEC_MARGIN = 5;    // security points above minDifficulty
    const DESYNC_MONEY_FRAC = 0.90; // fraction of maxMoney below which money counts as "low"
    const DESYNC_LOG_MIN_WEAKEN_TIME = 30_000; // only log desyncs on targets slower than this (ms)

    // ── Stats tracking ────────────────────────────────────────────────────────
    // Piggybacks on the retarget cadence so tuning changes (hysteresis margin,
    // prep penalty, desync thresholds, etc.) can be judged by actual $/sec
    // instead of eyeballing money-over-time.
    let statsLastCheck = Date.now();
    let statsLastMoney = ns.getPlayer().money;
    let statsDesyncCount = 0; // real desyncs only — logged ones, fast-target noise excluded

    function logStats() {
        const nowMs      = Date.now();
        const elapsedSec = (nowMs - statsLastCheck) / 1000;
        const curMoney   = ns.getPlayer().money;
        const incomeRate = elapsedSec > 0 ? (curMoney - statsLastMoney) / elapsedSec : 0;

        const ram      = buildFreeRam(servers);
        const freeGb   = [...ram.values()].reduce((s, v) => s + v, 0);
        const totalGb  = [...buildTotalRam(servers).values()].reduce((s, v) => s + v, 0);
        const usedPct  = totalGb > 0 ? 100 * (1 - freeGb / totalGb) : 0;

        const line = `[batcher] Stats: $${ns.format.number(incomeRate)}/sec | RAM ${usedPct.toFixed(0)}% used | ` +
            `${statsDesyncCount} desync(s), ${execFailures} exec failure(s) since last check`;
        tprint(line);

        statsLastCheck  = nowMs;
        statsLastMoney  = curMoney;
        statsDesyncCount = 0;
        execFailures     = 0;
    }

    const targetState = new Map(targets.map(t => [t, {
        phase:          'prep',
        nextCheck:      0,
        nextFire:       0,
        lastSkipWarn:   0,
        lastDesyncWarn: 0,
        moneyLowSince:  0,
    }]));

    // Fleet topology (server list) only changes when a server is bought/deleted —
    // scanning the whole network for it on every 200ms tick is pure waste. Piggyback
    // on the same cadence as retargeting instead of its own timer.
    let nextFleetCheck = Date.now();

    while (true) {
        const now = Date.now();

        // Refresh server list for newly purchased servers
        if (now >= nextFleetCheck) {
            nextFleetCheck = now + RETARGET_INTERVAL;
            const freshServers = getRootedServers();
            if (freshServers.length !== servers.length) {
                const newHosts = freshServers.filter(h => !servers.includes(h));
                await distributeWorkers(newHosts);
                servers = freshServers;
                tprint(`[batcher] Server fleet expanded to ${freshServers.length} — workers distributed`);
            }
        }

        // Periodically re-score targets: RAM and hacking skill both grow over time,
        // so the best target set at startup won't stay the best target set forever.
        if (!manualTarget && now >= nextRetarget) {
            nextRetarget = now + RETARGET_INTERVAL;
            const nuked = kickDoors();
            if (nuked > 0) {
                const freshlyRooted = getRootedServers();
                const newHosts = freshlyRooted.filter(h => !servers.includes(h));
                await distributeWorkers(newHosts);
                servers = freshlyRooted;
                tprint(`[batcher] Doorkickers: nuked ${nuked} new server(s)`);
            }
            const sel = selectTargets(servers, targets, { silent: true });
            const dropped = targets.filter(t => !sel.targets.includes(t));
            const added   = sel.targets.filter(t => !targets.includes(t));
            if (dropped.length > 0 || added.length > 0) {
                for (const t of dropped) {
                    targetState.delete(t);
                    threadOverrides.delete(t);
                }
                for (const t of added) {
                    targetState.set(t, { phase: 'prep', nextCheck: 0, nextFire: 0, lastSkipWarn: 0, lastDesyncWarn: 0, moneyLowSince: 0 });
                }
                for (const [host, ov] of sel.overrides) threadOverrides.set(host, ov);
                targets = sel.targets;
                tprint(`[batcher] Retarget: +[${added.join(", ")}] -[${dropped.join(", ")}] → now ${targets.length} target(s): ${targets.join(", ")}`);
            }
            ns.print(`[batcher] Retarget check: ${targets.length} target(s): ${targets.join(", ")}`);
            logStats();
        }

        const freeRam = buildFreeRam(servers);

        // === DESYNC CHECK ======================================================
        // Batch-phase targets are assumed to sit at min-security/max-money between
        // landings. Detect drift (failed exec, starved tick, etc.) and drop back to
        // 'prep' so the target self-heals instead of quietly hacking at reduced
        // chance/yield forever.
        for (const t of targets) {
            const st = targetState.get(t);
            if (st.phase !== 'batch') continue;

            const curSec   = ns.getServerSecurityLevel(t);
            const minSec   = ns.getServerMinSecurityLevel(t);
            const curMoney = ns.getServerMoneyAvailable(t);
            const maxMoney = ns.getServerMaxMoney(t);
            const moneyLow = curMoney < maxMoney * DESYNC_MONEY_FRAC;

            if (moneyLow) {
                if (st.moneyLowSince === 0) st.moneyLowSince = now;
            } else {
                st.moneyLowSince = 0;
            }
            const moneyStuck = moneyLow && (now - st.moneyLowSince) > ns.getGrowTime(t);

            if (curSec > minSec + DESYNC_SEC_MARGIN || moneyStuck) {
                st.phase        = 'prep';
                st.nextCheck    = 0;
                st.moneyLowSince = 0;
                // Fast/cheap targets (short weakenTime) desync often as a side effect
                // of rising hacking skill shifting in-flight batch timings — expected
                // and self-correcting, so don't log those. Only surface desyncs on
                // slower targets, where it's more likely to indicate a real problem.
                if (ns.getWeakenTime(t) >= DESYNC_LOG_MIN_WEAKEN_TIME) {
                    statsDesyncCount++;
                    const sinceWarn = now - st.lastDesyncWarn;
                    if (sinceWarn >= 60_000) {
                        tprint(`[batcher] WARNING: ${t} desynced (sec ${curSec.toFixed(1)}/${minSec.toFixed(1)}, money ${(100 * curMoney / maxMoney).toFixed(0)}%) — dropping to prep`);
                        st.lastDesyncWarn = now;
                    }
                }
            }
        }

        // === PREP PASS ========================================================
        // Build one shared freeRam so concurrent prep targets don't double-book.
        // nextCheck only advances when an allocation actually launches.
        for (const t of targets) {
            const st = targetState.get(t);
            if (st.phase !== 'prep' || now < st.nextCheck) continue;

            const curSec = ns.getServerSecurityLevel(t);
            const minSec = ns.getServerMinSecurityLevel(t);

            if (curSec > minSec + 0.05) {
                const threadsNeeded = Math.ceil((curSec - minSec) / 0.05);
                const alloc = tryAllocOps(freeRam, [{ ram: 1.75, threads: threadsNeeded }]);
                if (alloc) {
                    for (const { host, threads } of alloc[0])
                        execChecked("weaken.js", host, threads, t, 0);
                    st.nextCheck = now + ns.getWeakenTime(t) + BATCH_BUF;
                } else {
                    st.nextCheck = now + BATCH_INTERVAL; // retry next tick
                }
                continue;
            }

            const curMoney = ns.getServerMoneyAvailable(t);
            const maxMoney = ns.getServerMaxMoney(t);

            if (curMoney < maxMoney * 0.99) {
                const growMult    = maxMoney / Math.max(curMoney, 1);
                const growThreads = growThreadsFor(t, growMult);
                const w2Threads   = Math.ceil(growThreads * 0.004 / 0.05);
                const alloc = tryAllocOps(freeRam, [
                    { ram: 1.75, threads: growThreads },
                    { ram: 1.75, threads: w2Threads },
                ]);
                if (alloc) {
                    for (const { host, threads } of alloc[0]) execChecked("grow.js",   host, threads, t, 0);
                    for (const { host, threads } of alloc[1]) execChecked("weaken.js", host, threads, t, 0);
                    st.nextCheck = now + ns.getGrowTime(t) + BATCH_BUF;
                } else {
                    st.nextCheck = now + BATCH_INTERVAL; // retry next tick
                }
                continue;
            }

            st.phase    = 'batch';
            st.nextFire = 0;
        }

        // === BATCH PASS =======================================================
        const toFire = [];
        for (const t of targets) {
            const st = targetState.get(t);
            if (st.phase !== 'batch' || now < st.nextFire) continue;

            const { ops } = batchOpsFor(t);
            const batchRamNeeded = ops.reduce((s, op) => s + op.ram * op.threads, 0);
            const allocs = tryAllocOps(freeRam, ops);
            if (allocs) {
                toFire.push({ t, ops, allocs });
                st.nextFire = now + BATCH_INTERVAL;
            } else {
                st.nextFire = now + BATCH_INTERVAL;
                const totalFree = [...freeRam.values()].reduce((s, v) => s + v, 0);
                if (totalFree >= batchRamNeeded * 1.5) {
                    const sinceWarn = now - st.lastSkipWarn;
                    if (sinceWarn >= 60_000) {
                        tprint(`[batcher] WARNING: ${t} skipping — needs ${batchRamNeeded.toFixed(1)} GB but allocation failed despite ${totalFree.toFixed(1)} GB free (fragmentation?)`);
                        st.lastSkipWarn = now;
                    }
                }
            }
        }

        // Fire all reserved batches — no awaits, so no RAM race
        for (const { t, ops, allocs } of toFire) {
            for (let i = 0; i < ops.length; i++) {
                const { script, delay } = ops[i];
                for (const { host, threads } of allocs[i]) {
                    execChecked(script, host, threads, t, delay);
                }
            }
        }

        // Fill remaining RAM with share threads — but only once per share duration
        // so we don't spawn 50 overlapping generations that starve batch allocations.
        if (now >= nextShareSpawn) {
            const shareAssignments = allocShareFromMap(freeRam);
            for (const { host, threads } of shareAssignments) {
                execChecked("share.js", host, threads);
            }
            if (shareAssignments.length > 0) nextShareSpawn = now + SHARE_DURATION;
        }

        await ns.sleep(BATCH_INTERVAL);
    }
}
