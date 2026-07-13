/** @param {NS} ns */
export async function main(ns) {
    ns.disableLog("ALL");

    const MIN_RAM = 8;  // smallest useful size

    const maxServers = ns.cloud.getServerLimit();
    const maxRam     = ns.cloud.getRamLimit();

    // Build list of valid RAM tiers (powers of 2 from MIN_RAM to max)
    const ramTiers = [];
    for (let r = MIN_RAM; r <= maxRam; r *= 2) ramTiers.push(r);

    const existing = ns.cloud.getServerNames();
    const toFill   = maxServers - existing.length;

    if (toFill <= 0) {
        ns.tprint(`[buy-servers] Already at server cap (${maxServers}). Run upgrade-servers.js to improve RAM.`);
        return;
    }

    const money = ns.getPlayer().money;
    ns.tprint(`[buy-servers] Have $${ns.format.number(money)} — buying ${toFill} server(s).`);

    // Pick highest RAM tier we can afford for ALL remaining slots
    let chosenRam = MIN_RAM;
    for (const tier of ramTiers) {
        const totalCost = ns.cloud.getServerCost(tier) * toFill;
        if (totalCost <= money) chosenRam = tier;
        else break;
    }

    const costEach  = ns.cloud.getServerCost(chosenRam);
    ns.tprint(`[buy-servers] Buying at ${chosenRam} GB each (${toFill} servers × $${ns.format.number(costEach)} = $${ns.format.number(costEach * toFill)} total)`);

    let bought = 0;
    for (let i = 0; i < toFill; i++) {
        const hostname = `pserv-${existing.length + i}`;
        const result   = ns.cloud.purchaseServer(hostname, chosenRam);
        if (result) {
            ns.tprint(`  Purchased: ${result} (${chosenRam} GB)`);
            bought++;
        } else {
            ns.tprint(`  Failed to purchase server ${hostname} — out of money?`);
            break;
        }
    }

    ns.tprint(`[buy-servers] Done. Bought ${bought} server(s). Total owned: ${existing.length + bought}/${maxServers}`);
}
