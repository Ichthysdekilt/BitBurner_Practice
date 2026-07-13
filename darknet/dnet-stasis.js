/** dnet-stasis.js — run on a darknet server to apply a stasis lock. */
/** @param {NS} ns */
export async function main(ns) {
    await ns.dnet.setStasisLink();
    ns.tprint(`[dnet-stasis] Stasis link applied on ${ns.getHostname()}`);
}
