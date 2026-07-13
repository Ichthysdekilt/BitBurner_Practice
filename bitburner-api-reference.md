# Bitburner Netscript API Reference

Source: deepwiki.com/bitburner-official/bitburner-src (commit da4c7a01)
**WARNING: Source is outdated. Trust in-game API docs over this file. Known divergences noted inline.**

---

## Table of Contents
1. [Architecture Overview](#architecture-overview)
2. [RAM Costs](#ram-costs)
3. [Core Hacking Functions](#core-hacking-functions)
4. [Server & Network Functions](#server--network-functions)
5. [Script Execution Functions](#script-execution-functions)
6. [Port Communication](#port-communication)
7. [Hacknet Namespace](#hacknet-namespace)
8. [Stock Namespace](#stock-namespace)
9. [Gang Namespace](#gang-namespace)
10. [Bladeburner Namespace](#bladeburner-namespace)
11. [Sleeve Namespace](#sleeve-namespace)
12. [Coding Contract Namespace](#coding-contract-namespace)
13. [UI Namespace](#ui-namespace)
14. [Stanek Namespace](#stanek-namespace)
15. [Singularity Namespace (SF4)](#singularity-namespace-sf4)
16. [Formulas Namespace](#formulas-namespace)
17. [Corporation Namespace](#corporation-namespace)
18. [Enums](#enums)
19. [Server Object Reference](#server-object-reference)
20. [Player Progression Reference](#player-progression-reference)

---

## Architecture Overview

The `NS` object is passed as the first parameter to every script entry point (`main(ns)`). It contains direct functions and sub-namespaces. All functions are validated via `NetscriptHelpers`, and RAM is enforced dynamically via `NSProxy`.

- **Script base RAM**: 1.6 GB minimum per script
- RAM is calculated statically at launch by AST-parsing all referenced NS functions
- Exceeding allocated RAM terminates the script

Key source files:
- `src/NetscriptFunctions.ts` — root NS assembly
- `src/Netscript/APIWrapper.ts` — proxy handler
- `src/Netscript/RamCostGenerator.ts` — cost constants
- `src/ScriptEditor/NetscriptDefinitions.d.ts` — full TypeScript definitions

---

## RAM Costs

| Category | Cost | Notes |
|---|---|---|
| Script base | 1.6 GB | Every script |
| `hack()` | 0.1 GB | |
| `grow()` | 0.15 GB | |
| `weaken()` | 0.15 GB | |
| `hackAnalyze` / `growthAnalyze` | 1.0 GB each | |
| `run()` | 1.0 GB | |
| `exec()` | 1.3 GB | |
| `spawn()` | 2.0 GB | |
| `scp()` | 0.60 GB | |
| `kill()` | 0.50 GB | |
| `killall()` | 0.50 GB | |
| `ps()` | 0.20 GB | |
| `ls()` | 0.20 GB | |
| `isRunning()` | 0.10 GB | |
| `scan()` | 0.20 GB | |
| `getServer()` | 2.0 GB | Previously documented as 0.1 GB (was wrong) |
| Server getters (`getServerMaxMoney`, `getServerMoneyAvailable`, etc.) | 0.10 GB each | |
| `getServerMaxRam()` / `getServerUsedRam()` | 0.05 GB each | |
| `hasRootAccess()` | 0.05 GB | |
| `getServerNumPortsRequired()` | 0.10 GB | |
| `fileExists()` | 0.10 GB | |
| `getHackingLevel()` | 0.05 GB | |
| `getHackTime()` / `getGrowTime()` / `getWeakenTime()` | 0.05 GB each | |
| `hackAnalyze()` / `growthAnalyze()` / `hackAnalyzeChance()` | 1.0 GB each | |
| `brutessh/ftpcrack/relaysmtp/httpworm/sqlinject()` | 0.05 GB each | |
| `nuke()` | 0.05 GB | |
| `ns.format.*` (number/percent/ram/time) | 0 GB | Replaces deprecated `ns.formatNumber()` |
| `kill()` / `killall()` / `ps()` / `isRunning()` / `getRunningScript()` | See above | |
| `ns.hacknet.*` | 0.5 GB base | |
| `ns.stock.*` | 2.0–2.5 GB base | |
| `ns.gang.*` | 4 GB base | |
| `ns.bladeburner.*` | 4 GB base | |
| `ns.sleeve.*` | 4 GB base | |
| `ns.codingcontract.*` | 10 GB base | |
| `ns.ui.*` | 0 GB | Free |
| `ns.format.*` | 0 GB | Free — replaces deprecated `ns.formatNumber()` |
| `ns.stanek.*` | 0.4–5 GB | Varies |
| `ns.corporation.*` | 10 GB (info) / 20 GB (action) | |
| `ns.formulas.*` | 0 GB after namespace access | Requires Formulas.exe |
| Singularity functions | SF4Cost × SF4 multiplier | See SF4 Scaling below |

### SF4 (Singularity) Cost Multiplier
| Condition | Multiplier |
|---|---|
| BitNode 4 native OR SF-4 level 3 | 1× |
| SF-4 level 2 | 4× |
| SF-4 level 1 | 16× |
| No SF-4 (outside BN4) | 16× |

---

## Core Hacking Functions

All three HGW functions are **async** (use `await`). They return a Promise.

### `ns.hack(host, opts?)`
- **RAM**: 0.1 GB
- Steals money from target server
- Side effect: +0.002 security per thread
- Time determined by `calculateHackingTime`

### `ns.grow(host, opts?)`
- **RAM**: 0.15 GB
- Increases server's available money
- Side effect: +0.004 security per thread
- Time determined by `calculateGrowTime`

### `ns.weaken(host, opts?)`
- **RAM**: 0.15 GB
- Decreases server security level
- Side effect: −0.05 security per thread
- Time determined by `calculateWeakenTime`

### `BasicHGWOptions` (optional second param for all three)
Optional object to configure thread behavior.

### `ns.getHackTime(host)` — 0.05 GB
Returns time in milliseconds for a hack() to complete on `host`.

### `ns.getGrowTime(host)` — 0.05 GB
Returns time in milliseconds for a grow() to complete on `host`.

### `ns.getWeakenTime(host)` — 0.05 GB
Returns time in milliseconds for a weaken() to complete on `host`.

---

## Analysis Functions

### `ns.hackAnalyze(host)` — 1.0 GB
Returns fraction of money stolen per thread (as a decimal, e.g. 0.02 = 2%).

### `ns.hackAnalyzeThreads(host, amount)` — 1.0 GB
Returns number of threads needed to steal `amount` money.

### `ns.hackAnalyzeChance(host)` — 1.0 GB
Returns probability of hack success (0–1).

### `ns.growthAnalyze(host, mult, cores?)` — 1.0 GB
Returns threads needed to multiply server money by `mult`.
- Uses `numCycleForGrowthCorrected` internally
- Optional `cores` parameter for multi-core servers

### `ns.weakenAnalyze(threads, cores?)` — 1.0 GB
Returns total security reduction from `threads` weaken threads.
- Core multiplier formula: `1 + (cores - 1) / 16`

---

## Server & Network Functions

### `ns.scan(host?)` — 0.2 GB
Returns `string[]` of hostnames directly connected to `host` (defaults to current server).
Use recursively to map the full network.

### Server Property Getters

| Function | RAM | Returns |
|---|---|---|
| `ns.getServerMaxMoney(host)` | 0.1 GB | Max money the server can hold |
| `ns.getServerMoneyAvailable(host)` | 0.1 GB | Current money on server |
| `ns.getServerSecurityLevel(host)` | 0.1 GB | Current security level |
| `ns.getServerMinSecurityLevel(host)` | 0.1 GB | Minimum possible security level |
| `ns.getServerMaxRam(host)` | 0.05 GB | Max RAM in GB |
| `ns.getServerUsedRam(host)` | 0.05 GB | RAM currently in use |
| `ns.getServerRequiredHackingLevel(host)` | 0.1 GB | Hacking level required |
| `ns.getServerNumPortsRequired(host)` | 0.1 GB | Number of ports to open before nuke |
| `ns.hasRootAccess(host)` | 0.05 GB | Whether you have admin rights |

### `ns.getServer(host)` — 2.0 GB
Returns the full `Server` object with all properties (see [Server Object Reference](#server-object-reference)).

### `ns.getHackingLevel()` — 0.05 GB
Returns the player's current hacking skill level as a number.

### Port-Opening Programs (RAM ~0.05 GB each)

| Function | Program Required | Port |
|---|---|---|
| `ns.brutessh(host)` | BruteSSH.exe | 22 |
| `ns.ftpcrack(host)` | FTPCrack.exe | 21 |
| `ns.relaysmtp(host)` | relaySMTP.exe | 25 |
| `ns.httpworm(host)` | HTTPWorm.exe | 80 |
| `ns.sqlinject(host)` | SQLInject.exe | 1433 |

### `ns.nuke(host)` — 0.05 GB
Requires `openPortCount >= numOpenPortsRequired`. Sets `hasAdminRights = true`.

---

## Script Execution Functions

### `ns.scp(files, destination, source?)` — 0.60 GB
Copies one or more script/text files to a remote server. Source defaults to home.

### `ns.run(script, opts?, ...args)` — 1.0 GB
Launches a script on the **current** server.

### `ns.exec(script, host, opts?, ...args)` — 1.3 GB
Launches a script on a **remote** server.

### `ns.spawn(script, opts?, ...args)` — 2.0 GB
Launches a new script then **kills the calling script**. Use at end of a script to chain without RAM overlap.

### `ns.kill(script, host?, ...args)` — 0.50 GB
Kills a running script by filename + host + args, or by PID.

### `ns.killall(host?, safetyguard?)` — 0.50 GB
Kills all scripts on a host.

### `ns.ps(host?)` — 0.20 GB
Returns array of `ProcessInfo` objects for running scripts on host.

### `ns.ls(host?, grep?)` — 0.20 GB
Returns array of filenames on a server, optionally filtered by substring.

### `ns.isRunning(script, host?, ...args)` — 0.10 GB
Returns `boolean` — whether a script is currently running.

### `ns.fileExists(filename, host?)` — 0.10 GB
Returns `boolean` — whether a file exists on a server.

### `ns.getRunningScript(fn?, host?, ...args)` — 0 GB
Returns `RunningScript` object or `null`.

---

## Port Communication

### `ns.getPortHandle(port)` 
Returns a `NetscriptPort` object for the given port number (1–20).

**`NetscriptPort` methods:**
- `.read()` — removes and returns first item; returns `"NULL PORT DATA"` if empty
- `.peek()` — reads without removing
- `.write(value)` — adds to port queue (pushes oldest out if full)
- `.tryWrite(value)` — non-blocking; returns `false` if port is full
- `.nextWrite()` — returns a `Promise` that resolves on next write
- `.clear()` — empties the port
- `.full()` — returns `boolean`
- `.empty()` — returns `boolean`

### Direct Port Functions
- `ns.readPort(port)` — reads from port
- `ns.writePort(port, data)` — writes to port
- `ns.tryWritePort(port, data)` — non-blocking write, returns `boolean`
- `ns.peek(port)` — peek without consuming

---

## Hacknet Namespace

`ns.hacknet.*` — base RAM: 0.5 GB

| Function | Description |
|---|---|
| `numNodes()` | Number of owned Hacknet nodes |
| `maxNumNodes()` | Maximum purchasable nodes |
| `purchaseNode()` | Buy a new node; returns index or -1 |
| `getPurchaseNodeCost()` | Cost to buy next node |
| `getNodeStats(i)` | Returns `NodeStats` for node `i` |
| `upgradeLevel(i, n)` | Upgrade node `i` level by `n`; returns boolean |
| `upgradeRam(i, n)` | Upgrade node `i` RAM by `n`; returns boolean |
| `upgradeCore(i, n)` | Upgrade node `i` cores by `n`; returns boolean |
| `upgradeCache(i, n)` | (BN9 Hacknet Servers) Upgrade cache |
| `getLevelUpgradeCost(i, n)` | Cost to upgrade level |
| `getRamUpgradeCost(i, n)` | Cost to upgrade RAM |
| `getCoreUpgradeCost(i, n)` | Cost to upgrade cores |
| `numHashes()` | (BN9) Current hash count |
| `hashCapacity()` | (BN9) Max hash storage |
| `hashCost(upgrade, n?)` | (BN9) Hash cost for an upgrade |
| `spendHashes(upgrade, arg?, n?)` | (BN9) Spend hashes on an upgrade |
| `getHashUpgrades()` | (BN9) List of available hash upgrades |
| `getStudyMult()` | (BN9) Current study multiplier from hashes |
| `getTrainingMult()` | (BN9) Current training multiplier from hashes |

---

## Stock Namespace

`ns.stock.*` — requires TIX API access (`Player.hasTixApiAccess`)

| Function | RAM | Description |
|---|---|---|
| `getSymbols()` | 2.0 GB | List of all stock symbols |
| `getPrice(sym)` | 2.0 GB | Current stock price |
| `getAskPrice(sym)` | 2.0 GB | Ask price |
| `getBidPrice(sym)` | 2.0 GB | Bid price |
| `getMaxShares(sym)` | 2.0 GB | Max purchasable shares |
| `getPosition(sym)` | 2.0 GB | `[longShares, longAvgPrice, shortShares, shortAvgPrice]` |
| `buyStock(sym, shares)` | 2.5 GB | Buy long position |
| `sellStock(sym, shares)` | 2.5 GB | Sell long position |
| `buyShort(sym, shares)` | 2.5 GB | Buy short (requires BN8/SF8) |
| `sellShort(sym, shares)` | 2.5 GB | Sell short |
| `placeOrder(sym, shares, price, type, pos)` | 2.5 GB | Place limit/stop order |
| `cancelOrder(sym, shares, price, type, pos)` | 2.5 GB | Cancel an order |
| `getOrders()` | 2.5 GB | Get all pending orders |
| `getForecast(sym)` | 2.5 GB | Forecast (0–1, >0.5 = likely rising) |
| `getVolatility(sym)` | 2.5 GB | Price volatility |
| `purchase4SMarketData()` | — | Buy 4S Market Data access |
| `purchase4SMarketDataTixApi()` | — | Buy 4S + TIX API access |
| `has4SData()` | 2.0 GB | Whether 4S data is owned |
| `has4SDataTixApi()` | 2.0 GB | Whether 4S TIX API is owned |

---

## Gang Namespace

`ns.gang.*` — base RAM: 4 GB. Requires being in a gang.

| Function | Description |
|---|---|
| `inGang()` | Returns boolean |
| `createGang(faction)` | Create a gang from a faction |
| `isLadderized()` | Whether gang is in gang warfare |
| `getGangInformation()` | Returns `GangGenInfo` object |
| `getOtherGangInformation()` | Returns info on all other gangs |
| `getMemberNames()` | String array of member names |
| `getMemberInformation(name)` | Returns `GangMemberInfo` with stats and ascension multipliers |
| `canRecruitMember()` | Whether you can recruit now |
| `recruitMember(name)` | Recruit a new member |
| `getTaskNames()` | List of available tasks |
| `getTaskStats(taskName)` | Stats and details for a task |
| `setMemberTask(name, task)` | Assign a task to a member |
| `ascendMember(name)` | Ascend a member (resets XP, applies multiplier) |
| `getAscensionResult(name)` | Preview ascension result without committing |
| `purchaseEquipment(name, equipment)` | Buy equipment for a member |
| `getEquipmentNames()` | List of equipment |
| `getEquipmentCost(equipment)` | Cost of equipment |
| `getEquipmentType(equipment)` | Type of equipment |
| `getEquipmentStats(equipment)` | Stat bonuses of equipment |
| `getBonusTime()` | Bonus time in ms |
| `getChanceToWinClash(gang)` | Probability of winning territory clash |
| `getClashWinChance(gang)` | Alias |
| `setTerritoryWarfare(engage)` | Toggle territory warfare |

---

## Bladeburner Namespace

`ns.bladeburner.*` — base RAM: 4 GB. Requires BN6/BN7 or relevant SF.

| Function | Description |
|---|---|
| `inBladeburner()` | Whether in Bladeburner |
| `joinBladeburnerDivision()` | Join Bladeburner |
| `getBladeburnerCity()` | Current city |
| `switchCity(city)` | Switch to a different city |
| `getCurrentAction()` | `{type, name}` of current action |
| `startAction(type, name)` | Start a Bladeburner action |
| `stopBladeburnerAction()` | Stop current action |
| `getActionCountRemaining(type, name)` | How many times this action can run |
| `getActionMaxLevel(type, name)` | Max level of an action |
| `getActionCurrentLevel(type, name)` | Current level |
| `getActionSuccessChance(type, name)` | `[min, max]` success range |
| `getActionEstimatedSuccessChance(type, name)` | Estimated chance |
| `getActionTime(type, name)` | Duration in ms |
| `getActionRepGain(type, name, level?)` | Reputation gain |
| `getContractNames()` | List of contracts |
| `getOperationNames()` | List of operations |
| `getBlackOpNames()` | List of black ops |
| `getGeneralActionNames()` | List of general actions |
| `getSkillNames()` | List of Bladeburner skills |
| `getSkillLevel(skill)` | Current skill level |
| `getSkillUpgradeCost(skill, count?)` | SP cost to upgrade |
| `upgradeSkill(skill, count?)` | Purchase skill upgrade |
| `getRank()` | Current Bladeburner rank |
| `getBlackOpRank(name)` | Rank required for a Black Op |
| `getBonusTime()` | Bonus time in ms |
| `getStamina()` | `[current, max]` stamina |
| `getCityEstimatedPopulation(city)` | Estimated population |
| `getCityChaos(city)` | Chaos level |
| `getCommunities(city)` | Number of communities |
| `setTeamSize(type, name, size)` | Set team size for an action |
| `getTeamSize(type, name)` | Current team size |

Action types (use `ns.enums.BladeburnerActionType`):
- `"Contracts"`, `"Operations"`, `"BlackOps"`, `"General"`

---

## Sleeve Namespace

`ns.sleeve.*` — base RAM: 4 GB

| Function | Description |
|---|---|
| `getNumSleeves()` | Number of sleeves owned |
| `getSleeve(i)` | Returns `SleevePerson` object |
| `getSleeveStats(i)` | Returns sleeve stats |
| `getSleeveAugmentations(i)` | Augmentations installed on sleeve `i` |
| `getSleevePurchasableAugs(i)` | Augmentations available to buy |
| `purchaseSleeveAug(i, aug)` | Buy aug for sleeve |
| `setToIdle(i)` | Set sleeve to idle |
| `setToShockRecovery(i)` | Set to shock recovery |
| `setToSynchronize(i)` | Set to synchronize |
| `setToCommitCrime(i, crime)` | Set to commit a crime |
| `setToUniversityCourse(i, university, course)` | Study at university |
| `setToGymWorkout(i, gym, stat)` | Train at gym |
| `setToFactionWork(i, faction, work)` | Work for faction |
| `setToCompanyWork(i, company)` | Work at company |
| `setToBladeburnerAction(i, type, name?)` | Perform Bladeburner action |
| `getTask(i)` | Returns current task |

---

## Coding Contract Namespace

`ns.codingcontract.*` — base RAM: 10 GB

| Function | Parameters | Description |
|---|---|---|
| `attempt(answer, filename, host?)` | answer: any, filename, host | Submit answer; returns reward string or empty string on failure |
| `getContractType(filename, host?)` | — | Returns contract type string |
| `getData(filename, host?)` | — | Returns contract input data |
| `getDescription(filename, host?)` | — | Returns problem description |
| `getNumTriesRemaining(filename, host?)` | — | Tries left before contract disappears |

---

## UI Namespace

`ns.ui.*` — 0 GB (free)

| Function | Description |
|---|---|
| `clearTerminal()` | Clears the terminal |
| `getTheme()` | Returns current theme object |
| `setTheme(theme)` | Sets the game theme |
| `resetTheme()` | Resets to default theme |
| `getStyles()` | Returns current styles object |
| `setStyles(styles)` | Sets custom styles |
| `getGameInfo()` | Returns game version info |
| `openTail(pid?, host?)` | Opens tail window for a script |
| `closeTail(pid?)` | Closes tail window |
| `moveTail(x, y, pid?)` | Moves tail window |
| `resizeTail(w, h, pid?)` | Resizes tail window |
| `setTailTitle(title, pid?)` | Sets tail window title |
| `setTailMinimized(minimized, pid?)` | Minimizes/restores tail window |
| `windowSize()` | Returns `{width, height}` of game window |

---

## Stanek Namespace

`ns.stanek.*` — RAM: 0.4–5 GB

| Function | RAM | Description |
|---|---|---|
| `giftWidth()` | 0.4 GB | Width of Stanek's Gift grid |
| `giftHeight()` | 0.4 GB | Height of the grid |
| `chargeFragment(rootX, rootY)` | 0.4 GB | Charge a placed fragment |
| `fragmentDefinitions()` | 5 GB | All fragment type definitions |
| `activeFragments()` | 5 GB | Currently placed fragments |
| `clearFragment(rootX, rootY)` | 0 GB | Remove a fragment |
| `canPlaceFragment(rootX, rootY, rotation, id)` | 0.5 GB | Check if placement is valid |
| `placeFragment(rootX, rootY, rotation, id)` | 5 GB | Place a fragment |

---

## Singularity Namespace (SF4)

`ns.singularity.*` — Requires Source-File 4 (or being in BitNode 4). All costs scale by SF4 multiplier.

### Player Actions & Work

| Function | Base RAM | Description |
|---|---|---|
| `applyToCompany(company, field)` | SF4Cost(3) | Apply for a job |
| `workForCompany(company, focus?)` | SF4Cost(3) | Work at current company |
| `workForFaction(faction, workType, focus?)` | SF4Cost(3) | Work for faction |
| `commitCrime(crime, focus?)` | SF4Cost(3) | Commit a crime (use `ns.enums.CrimeType`) |
| `universityCourse(university, course, focus?)` | SF4Cost(2) | Study at university |
| `gymWorkout(gym, stat, focus?)` | SF4Cost(2) | Train a stat at gym |
| `stopAction()` | SF4Cost(1) | Stop current action |
| `getCurrentWork()` | SF4Cost(0.5) | Returns current work info or null |

### Faction & Reputation

| Function | Base RAM | Description |
|---|---|---|
| `checkFactionInvitations()` | SF4Cost(3) | Returns array of pending invitations |
| `joinFaction(faction)` | SF4Cost(3) | Join a faction |
| `getFactionRep(faction)` | SF4Cost(2) | Current reputation with faction |
| `getFactionFavor(faction)` | SF4Cost(2) | Current favor with faction |
| `getFactionFavorGain(faction)` | SF4Cost(0.75) | Favor gain on next reset |
| `donateToFaction(faction, amount)` | SF4Cost(5) | Donate money for rep |
| `getAugmentationsFromFaction(faction)` | SF4Cost(5) | Augmentations available from faction |

### Augmentation Management

| Function | Base RAM | Description |
|---|---|---|
| `getOwnedAugmentations(purchased?)` | SF4Cost(5) | List owned/queued augmentations |
| `getAugmentationFactions(augName)` | SF4Cost(5) | Factions offering this aug |
| `getAugmentationPrereq(augName)` | SF4Cost(5) | Prerequisite aug names |
| `getAugmentationPrice(augName)` | SF4Cost(2.5) | Current price |
| `getAugmentationBasePrice(augName)` | SF4Cost(2.5) | Base price before multipliers |
| `getAugmentationRepReq(augName)` | SF4Cost(2.5) | Reputation required |
| `getAugmentationStats(augName)` | SF4Cost(5) | Stat multiplier effects |
| `purchaseAugmentation(faction, augName)` | SF4Cost(5) | Purchase an augmentation |
| `installAugmentations(cbScript?)` | SF4Cost(5) | Install queued augs and reset |
| `softReset(cbScript?)` | SF4Cost(5) | Soft reset without installing augs |

### Programs

| Function | Description |
|---|---|
| `createProgram(programName, focus?)` | Begin creating a hacking program |
| `purchaseProgram(programName)` | Buy from dark web |
| `getDarkwebProgramCost(programName)` | Dark web price |
| `getHackingLevelRequirementOfProgram(programName)` | Hacking level to create |

### Navigation & Locations

| Function | Base RAM | Description |
|---|---|---|
| `travelToCity(city)` | SF4Cost(2) | Travel to another city |
| `goToLocation(locationName)` | SF4Cost(5) | Visit a specific location |
| `getOwnedHomes()` | SF4Cost(2) | List owned homes |
| `upgradeHomeRam()` | SF4Cost(3) | Upgrade home RAM |
| `upgradeHomeCores()` | SF4Cost(3) | Upgrade home CPU cores |
| `getUpgradeHomeRamCost()` | SF4Cost(1.5) | Cost to upgrade RAM |
| `getUpgradeHomeCoresCost()` | SF4Cost(1.5) | Cost to upgrade cores |
| `purchaseServer(hostname, ram)` | SF4Cost(2.25) | Buy a server |
| `deleteServer(hostname)` | SF4Cost(2.25) | Delete a purchased server |
| `getOwnedServers()` | SF4Cost(2.25) | List purchased server hostnames |

### Player Info

| Function | Base RAM | Description |
|---|---|---|
| `getStats()` | SF4Cost(0.5) | Returns player stat levels |
| `getCharacterOverview()` | SF4Cost(0.5) | Returns overview of player character |
| `isBusy()` | SF4Cost(0.5) | Whether player is currently working |
| `getCompanyRep(company)` | SF4Cost(2) | Reputation at a company |
| `getCompanyFavor(company)` | SF4Cost(2) | Favor at a company |
| `getCompanyFavorGain(company)` | SF4Cost(1) | Favor gain on reset |
| `getCrimeChance(crime)` | SF4Cost(5) | Success probability for crime |
| `getCrimeStats(crime)` | SF4Cost(5) | Stats gained from crime |

### Prestige & BitNodes

| Function | Base RAM | Description |
|---|---|---|
| `b1tflum3(nextBN, cbScript?, options?)` | SF4Cost(16) | Enter a specific BitNode |
| `destroyW0r1dD43m0n(nextBN, cbScript?, options?)` | SF4Cost(32) | Destroy final boss, move to next BN |
| `getOwnedSourceFiles()` | SF4Cost(5) | List owned Source Files and levels |

---

## Formulas Namespace

`ns.formulas.*` — Requires `Formulas.exe`. Nearly 0 GB RAM after access check.

These functions accept game-state objects as parameters rather than reading live game state, enabling **simulation of hypothetical scenarios**.

### Mock Object Factories

| Function | Returns | Description |
|---|---|---|
| `ns.formulas.mockServer()` | `Server` | Server with safe defaults |
| `ns.formulas.mockPlayer()` | `Player` | Player with base stats |
| `ns.formulas.mockPerson()` | `Person` | Generic person object |

### `ns.formulas.hacking`

| Function | Parameters | Returns | Description |
|---|---|---|---|
| `hackChance(server, player)` | Server, Player | number (0–1) | Probability of hack success |
| `hackExp(server, player)` | Server, Player | number | XP per hack thread |
| `hackPercent(server, player)` | Server, Player | number | Money fraction stolen per thread |
| `hackTime(server, player)` | Server, Player | number (ms) | Hack duration |
| `growTime(server, player)` | Server, Player | number (ms) | Grow duration |
| `weakenTime(server, player)` | Server, Player | number (ms) | Weaken duration |
| `growPercent(server, threads, player, cores?)` | Server, number, Player, number | number | Growth multiplier |
| `growThreads(server, player, targetMoney, cores?)` | Server, Player, number, number | number | Threads to reach target money |
| `weakenEffect(threads, cores?)` | number, number | number | Security reduction |

### `ns.formulas.reputation`

| Function | Parameters | Returns | Description |
|---|---|---|---|
| `calculateFavorToRep(favor)` | number | number | Favor points → reputation |
| `calculateRepToFavor(rep)` | number | number | Reputation → favor |
| `repFromDonation(amount, player)` | number, Person | number | Rep from donation |
| `donationForRep(reputation, player)` | number, Person | number | Money needed for target rep |
| `sharePower(threads, cpuCores)` | number, number | number | Share power multiplier — formula: `Math.log(threads * cpuCores) / 25 + 1` (reverse-engineered: ~3895 threads → 1.3346x, matches ln(4299)/25+1 where 4299 accounts for cpuCores) |

### `ns.formulas.hacknetNodes`

- `moneyGainRate(level, ram, cores, mult?)` — $/sec based on node stats
- `levelUpgradeCost(startingLevel, extraLevels, costMult?)` — cost to upgrade levels
- `ramUpgradeCost(startingRam, extraLevels, costMult?)` — cost to upgrade RAM
- `coreUpgradeCost(startingCore, extraCores, costMult?)` — cost to upgrade cores
- `hacknetNodeCost(n, mult)` — cost to buy nth node

### `ns.formulas.hacknetServers` (BN9)

- `hashGainRate(level, ramUsed, maxRam, cores, mult?)` — hashes/sec
- `hashUpgradeCost(upgName, level)` — hash cost for named upgrade
- `hacknetServerCost(n, mult)` — cost to buy nth server
- `constants()` — returns Hacknet Server constants

### `ns.formulas.work`

| Function | Description |
|---|---|
| `crimeGains(player, crime)` | Returns `{money, karma, kills, exp}` |
| `crimeSuccessChance(player, crime)` | Probability (0–1) |
| `companyGains(player, company, position, favor)` | $/sec and rep/sec |
| `factionGains(player, workType, favor)` | rep/sec and exp/sec |

### `ns.formulas.gang`

| Function | Description |
|---|---|
| `respectGain(gang, member, task)` | Respect/sec for member on task |
| `wantedLevelGain(gang, member, task)` | Wanted level change rate |
| `moneyGain(gang, member, task)` | $/sec for member |
| `ascensionPointsGain(exp)` | Ascension points from XP |
| `ascensionMultiplier(points)` | Stat multiplier from ascension points |

---

## Corporation Namespace

`ns.corporation.*` — RAM: 10 GB (info) / 20 GB (action). Gated by unlocks.

Key unlocks: `OfficeAPI`, `WarehouseAPI`, `Export`, `SmartSupply`, `GovernmentPartnership`

### Corporation Lifecycle

| Function | Description |
|---|---|
| `hasCorporation()` | Whether player owns a corporation |
| `canCreateCorporation(selfFund)` | Check prerequisites |
| `createCorporation(name, selfFund)` | Create corporation |
| `getCorporation()` | Returns full corp data including `totalShares`, `numShares`, `issuedShares` |

### Division Management

| Function | Description |
|---|---|
| `getDivision(divisionName)` | Returns `Division` object |
| `getIndustryData(industryName)` | Info about an industry type |
| `expandIndustry(industryName, divisionName)` | Create new division |
| `expandCity(divisionName, cityName)` | Open office in a city |
| `removeDivision(divisionName)` | Remove division, recoup funds |
| `getDivisionNames()` | List of division names |

### Investor & IPO

| Function | Description |
|---|---|
| `getInvestmentOffer()` | View current investor offer |
| `acceptInvestmentOffer()` | Accept offer, receive funds |
| `goPublic(numShares)` | IPO |
| `buyBackShares(amount)` | Repurchase shares |
| `sellShares(amount)` | Sell player shares |
| `bribe(factionName, amountCash)` | Bribe faction (needs `GovernmentPartnership`) |

### Warehouse API (requires `WarehouseAPI` unlock)

| Function | Description |
|---|---|
| `getWarehouse(divisionName, cityName)` | Warehouse data |
| `hasWarehouse(divisionName, cityName)` | Boolean check |
| `purchaseWarehouse(divisionName, cityName)` | Buy warehouse |
| `upgradeWarehouse(divisionName, cityName, amt?)` | Upgrade capacity |
| `getWarehouseUpgradeCost(divisionName, cityName, amt)` | Cost |
| `getMaterial(divisionName, cityName, materialName)` | Material data |
| `getProduct(divisionName, cityName, productName)` | Product data (has `progress` 0–100) |
| `makeProduct(divisionName, cityName, productName, designInvest, marketInvest)` | Start product development |
| `discontinueProduct(divisionName, productName)` | Stop a product |
| `setSmartSupply(divisionName, cityName, enabled)` | Toggle smart supply |
| `setSmartSupplyOption(divisionName, cityName, materialName, option)` | Configure smart supply |
| `buyMaterial(divisionName, cityName, materialName, amt)` | Buy material per second |
| `bulkPurchase(divisionName, cityName, materialName, amount)` | One-time bulk buy |
| `sellMaterial(divisionName, cityName, materialName, amt, price)` | Set sell amount/price |
| `sellProduct(divisionName, cityName, productName, amt, price, all)` | Set product sell settings |
| `setProductMarketTA1(divisionName, productName, on)` | Toggle Market-TA1 |
| `setProductMarketTA2(divisionName, productName, on)` | Toggle Market-TA2 |
| `setMaterialMarketTA1(divisionName, cityName, materialName, on)` | Toggle Market-TA1 for material |
| `setMaterialMarketTA2(divisionName, cityName, materialName, on)` | Toggle Market-TA2 for material |
| `exportMaterial(...)` | Set up material export between cities/divisions |
| `cancelExportMaterial(...)` | Cancel export |
| `importBoost(divisionName, cityName)` | Boost from imported materials |

### Office API (requires `OfficeAPI` unlock)

| Function | Description |
|---|---|
| `getOffice(divisionName, cityName)` | Office data |
| `hireEmployee(divisionName, cityName, position?)` | Hire random employee |
| `upgradeOfficeSize(divisionName, cityName, size)` | Expand office |
| `getOfficeSizeUpgradeCost(divisionName, cityName, amt)` | Cost |
| `setJobAssignment(divisionName, cityName, job, amount)` | Assign employees to role |
| `buyTea(divisionName, cityName)` | Buy tea for morale |
| `throwParty(divisionName, cityName, costPerEmployee)` | Party for morale/energy |
| `research(divisionName, researchName)` | Purchase research |
| `getResearchCost(divisionName, researchName)` | Research point cost |
| `hasResearched(divisionName, researchName)` | Whether research is purchased |

### Corp Upgrades

| Function | Description |
|---|---|
| `getUpgradeLevel(upgradeName)` | Current level of a corp upgrade |
| `getUpgradeLevelCost(upgradeName)` | Cost to upgrade |
| `levelUpgrade(upgradeName)` | Purchase corp upgrade level |
| `getUnlockCost(unlockName)` | Cost of a one-time unlock |
| `purchaseUnlock(unlockName)` | Purchase unlock |
| `hasUnlock(unlockName)` | Whether unlock is owned |
| `getConstants()` | Corp system constants |

---

## Enums

Access via `ns.enums.*`

### `CityName`
`Sector12`, `Aevum`, `Volhaven`, `Chongqing`, `NewTokyo`, `Ishima`

### `FactionName`
Includes: `CyberSec`, `NiteSec`, `TheBlackHand`, `BitRunners`, `Daedalus`, `Illuminati`, `NWO`, `ECorp`, `MegaCorp`, `KuaiGong`, `FourSigma`, `OmniTekIncorporated`, `BladeIndustries`, `FulcrumSecretTechnologies`, `Netburners`, `Tian Di Hui`, `SlumSnakes`, `Tetrads`, `Silhouette`, `SpeakersForTheDead`, `TheDarkArmy`, `TheSyndicate`, `Volhaven`

### `CrimeType`
`shoplift`, `robStore`, `mug`, `larceny`, `dealDrugs`, `bondForgery`, `traffickArms`, `homicide`, `grandTheftAuto`, `kidnap`, `assassination`, `heist`

### `BladeburnerActionType`
`"Contracts"`, `"Operations"`, `"BlackOps"`, `"General"`

### `ToastVariant`
`success`, `info`, `warning`, `error`

---

## Server Object Reference

The `Server` object returned by `ns.getServer(host)`:

### BaseServer Fields
| Property | Type | Description |
|---|---|---|
| `hostname` | string | Unique server name |
| `ip` | string | Server IP address |
| `maxRam` | number | Total RAM in GB |
| `ramUsed` | number | Currently used RAM |
| `serversOnNetwork` | string[] | Adjacent hostnames |
| `isConnectedTo` | boolean | Whether player is connected |
| `numOpenPortsRequired` | number | Ports to open before nuke |
| `openPortCount` | number | Currently opened ports |
| `hasAdminRights` | boolean | Whether root access is gained |
| `sshPortOpen` | boolean | SSH port opened |
| `ftpPortOpen` | boolean | FTP port opened |
| `smtpPortOpen` | boolean | SMTP port opened |
| `httpPortOpen` | boolean | HTTP port opened |
| `sqlPortOpen` | boolean | SQL port opened |

### Hacking Fields
| Property | Type | Description |
|---|---|---|
| `moneyAvailable` | number | Current money on server |
| `moneyMax` | number | Maximum money |
| `hackDifficulty` | number | Current security level |
| `minDifficulty` | number | Minimum security level |
| `requiredHackingSkill` | number | Hacking level required |
| `serverGrowth` | number | Growth rate parameter |
| `hackChance` | number (calculated) | Probability of hack success |

### Network Notes
- Network is a bidirectional graph; edges stored in `serversOnNetwork`
- All servers indexed in `AllServers` map by both hostname and IP
- `connectServers(s1, s2)` creates a bidirectional link
- Purchased servers connect to `home` by default
- `prestigeAllServers()` wipes the entire map on soft/hard reset

---

## Player Progression Reference

### Core Stats
`hacking`, `strength`, `defense`, `dexterity`, `agility`, `charisma`
- **Intelligence** is special: permanent and persistent across all resets

### Augmentations
- Queued in `Player.queuedAugmentations` before installation
- Require prerequisite augmentations
- Price increases for every additional queued augmentation (`MultipleAugMultiplier: 1.9`)
- **Grafting**: install without resetting (higher cost/time)
- On install: triggers soft reset, applies all multipliers permanently

### Factions
- Joined by meeting requirements (hacking level, money, location, etc.)
- Rep earned via: Hacking Work, Field Work, Security Work
- Favor persists through soft resets (converted from accumulated rep)
- High favor enables donations for instant rep in later runs
- Faction access gates augmentations

### BitNodes & Source Files
- BitNodes modify game balance via multipliers (e.g., `HackingLevelMultiplier`)
- Source Files are permanent rewards from destroying a BitNode
- SF4 (Singularity): unlocks `ns.singularity.*` and reduces RAM costs at levels 1/2/3

### Prestige Reset Types
| Type | Trigger | What Persists |
|---|---|---|
| Soft Reset | Install augmentations | Aug multipliers, faction favor, intelligence |
| Hard Reset | Destroy World Daemon (`w0r1d_d43m0n`) | Source Files, intelligence |

### Key Constants
- `NeuroFluxGovernorLevelMult`: 1.14 (per level)
- `MultipleAugMultiplier`: 1.9 (price increase per queued aug)
- Game loop cycle: 200ms (`MilliPerCycle`)

---

## IPvGO (`ns.go`) — Go Board Minigame

### Rules vs Standard Go
- **Superko enforced:** no move may return the board to any prior state
- **Komi:** white receives bonus points for moving second (varies by opponent)
- **Offline nodes (`#`):** permanently removed grid positions — cannot be played
- Stones = "routers", territory = "nodes/subnets" (cosmetic rename only)

### Board Sizes
| Size | Notes |
|---|---|
| 5×5 | Easiest, recommended for learning/farming |
| 7×7 | Medium |
| 9×9 | Standard |
| 13×13 | Large |
| 19×19 | Used exclusively by w0r1d_d43m0n |

### Coordinate System
- Origin `[0][0]` = **bottom-left** corner of the board
- `getBoardState()` returns columns — access as `board[x][y]`
- Board symbols: `X` = black (player), `O` = white (AI), `.` = empty, `#` = offline

### AI Opponents
| Faction | Style |
|---|---|
| Netburners | Primarily random — weakest |
| Slum Snakes | Aggressive, focuses on captures |
| The Black Hand | Defensive, prioritizes eyes |
| Daedalus | Advanced — pattern matching + territory influence |
| Illuminati | High-level, starts with handicap routers |
| w0r1d_d43m0n | Expert, 19×19 only |

### Rewards
- **Node Power** granted on game completion: scales by territory controlled × difficulty (board size × komi) × winstreak multiplier
- **Winstreak bonus:** every 2 consecutive wins vs same opponent, if player is in that faction, reputation converts to Favor immediately
- Losing or starting a new game mid-match resets the winstreak

### Scoring
1 point per router on board + 1 point per surrounded empty node controlled

### Core API

| Function | RAM | Signature | Notes |
|---|---|---|---|
| `ns.go.makeMove(x, y)` | 4 GB | `(x: number, y: number) => Promise<{type, x, y}>` | Places piece, awaits and returns AI response |
| `ns.go.passTurn()` | 0 GB | `() => Promise<{type, x, y}>` | Pass turn; two consecutive passes end game |
| `ns.go.getBoardState()` | 4 GB | `() => string[]` | Array of column strings; `board[x][y]` |
| `ns.go.getGameState()` | 0 GB | `() => {currentPlayer, score, previousMove}` | Score + whose turn + last move coords |
| `ns.go.getCurrentPlayer()` | 0 GB | `() => 'Black' \| 'White' \| 'None'` | `'None'` means game over |
| `ns.go.getOpponent()` | 0 GB | `() => string` | Name of current AI faction |
| `ns.go.getMoveHistory()` | 0 GB | `() => string[][][]` | Array of prior board state snapshots |
| `ns.go.resetBoardState(opponent, boardSize)` | 0 GB | `(opponent: string, boardSize: number) => string[]` | Starts new game; resets winstreak if prior game had moves |
| `ns.go.opponentNextTurn(logOpponentMove?)` | 0 GB | `(log?: boolean) => Promise<{type, x, y}>` | Waits for AI move — use to resync after script restart |

**`makeMove` / `passTurn` / `opponentNextTurn` return object:**
```
{ type: "move" | "pass" | "gameOver", x: number | null, y: number | null }
```
`x`/`y` are the opponent's response coords, or `null` on pass/gameOver.

### Analysis API (`ns.go.analysis`)

| Function | RAM | Returns | Notes |
|---|---|---|---|
| `getValidMoves(boardState?, priorBoardState?, playAsWhite?)` | 8 GB | `boolean[][]` — `[x][y]` | Superko not checked for custom board states |
| `getChains(boardState?)` | 16 GB | `(number\|null)[][]` | Shared ID = same chain; `null` = dead node |
| `getLiberties(boardState?)` | 16 GB | `number[][]` | Liberty count per chain; `-1` for empty/dead |
| `getControlledEmptyNodes(boardState?)` | 16 GB | `string[][]` | `X`=black, `O`=white, `?`=contested, `#`=dead, `.`=filled |
| `highlightPoint(x, y, color, text)` | 0 GB | void | UI only; cleared on next move |
| `clearPointHighlight(x, y)` | 0 GB | void | Clears single highlight |
| `clearAllPointHighlights()` | 0 GB | void | Clears all highlights |
| `getStats()` | 0 GB | object | History, captures, bonuses per opponent |
| `resetStats(resetAll)` | 0 GB | void | Resets win/loss records for "No AI" |
| `setTestingBoardState(boardState, komi, nextPlayerIsWhite)` | 0 GB | void | Sets up a "No AI" game with custom layout |

### Cheat API (`ns.go.cheat`) — Requires Source-File 14.2
| Function | Effect |
|---|---|
| `removeRouter(x, y)` | Remove opponent piece without capture |
| `playTwoMoves(x1, y1, x2, y2)` | Place two pieces in one turn |
| `destroyNode(x, y)` | Convert node to `#` permanently |
| `repairOfflineNode(x, y)` | Restore `#` node to empty |

---

## Darknet Namespace (`ns.dnet`)

Source: in-game API documentation (Bitburner v3.0.2). This is custom game content not in the deepwiki source.

Requires `DarkscapeNavigator.exe` for most functions (exceptions noted). Scripts must run on a darknet server (or home for bootstrapping) to use most of these.

**Known RAM bug:** The word `attempt` anywhere in a script triggers a false `codingcontract.attempt` RAM charge (+10 GB). Use `tries`, `retry`, `round`, etc. instead.

### Type Definitions

#### `DarknetResult`
```ts
type DarknetResult = { success: boolean; code: DarknetResponseCode; message: string };
```
Extended by some methods: `authenticate()` adds `data?: any` (intentionally undocumented); `heartbleed()` adds `logs: string[]`.

#### `DarknetServerDetails`
```ts
interface DarknetServerDetails {
  blockedRam:               number;   // RAM blocked by server owner's processes
  data:                     string;   // Live data from passwordHint (e.g. captcha value, NIL feedback)
  depth:                    number;   // Current depth in darknet tree
  difficulty:               number;   // Difficulty rating, associated with original depth
  hasSession:               boolean;  // True if current script has an active session
  isConnectedToCurrentServer: boolean;
  isStationary:             boolean;  // Fixed/story servers that cannot move
  logTrafficInterval:       number;   // Seconds between server's own self-log entries
  modelId:                  string;   // Auth model name (intentionally undocumented)
  passwordFormat:           "numeric" | "alphabetic" | "alphanumeric" | "ASCII" | "unicode";
  passwordHint:             string;   // Static hint text
  passwordLength:           number;   // Number of characters in the password
  requiredCharismaSkill:    number;   // Charisma required to authenticate (not just heartbleed)
}
// getServerDetails() returns DarknetServerDetails & { isOnline: boolean }
```
**Notable:** `data` is the *live* data value shown in the server UI (e.g. CloudBlare captcha, NIL feedback). May be readable directly without heartbleed. `passwordLength` confirmed — used by NIL solver.

#### `HeartbleedOptions`
```ts
interface HeartbleedOptions {
  additionalMsec?: number;  // Extra ms added to run time. Default: 0.
  logsToCapture?:  number;  // Number of log lines to retrieve/remove. Default: 1. Must be positive integer.
  peek?:           boolean; // If true, read logs without removing them. Default: false.
}
```
**⚠ Important:** Default `logsToCapture` is **1**. If the server has multiple log entries (e.g. a heartbeat check + auth feedback), only 1 is returned. Pass `{ peek: true, logsToCapture: 10 }` or similar to get full context.

#### `CacheResult`
```ts
type CacheResult = { success: boolean; message: string; karmaLoss: number };
```

#### `DarknetInstability`
```ts
interface DarknetInstability {
  authenticationDurationMultiplier: number;  // Multiplier on auth time (decimal)
  authenticationTimeoutChance:      number;  // Chance auth times out instead of resolving (decimal)
}
```

#### `DarknetResponseCode` (`DarknetResponseCodeType`)
```ts
type DarknetResponseCodeType = {
  Success:                  200;
  DirectConnectionRequired: 351;  // Target not directly connected; may be user error or server moved
  AuthFailure:              401;  // Wrong password
  Forbidden:                403;
  NotFound:                 404;  // Required resource (e.g. exe file) not present on server
  RequestTimeOut:           408;  // Network instability; password may or may not have been correct
  NotEnoughCharisma:        451;
  StasisLinkLimitReached:   453;
  NoBlockRAM:               454;
  PhishingFailed:           455;
  ServiceUnavailable:       503;  // Server is offline
};
```
The `code` field on every `DarknetResult` will be one of these values. Useful for distinguishing wrong password (401) from timeout (408) from charisma gate (451).

### Formulas Namespace (`ns.formulas.dnet`)

Requires `Formulas.exe` on home. The `ns.formulas` top-level namespace has sub-namespaces: `bladeburner`, `dnet`, `gang`, `hacking`, `hacknetNodes`, `hacknetServers`, `reputation`, `skills`, `work`.

**TODO:** Fetch the `DarknetFormulas` type page (`formulas.dnet`) for timing/cost calculation functions (e.g. `getHeartbleedTime` referenced in the heartbleed docs).

### Methods

| Method | RAM | Returns | Description |
|---|---|---|---|
| `authenticate(host, password, additionalMsec?)` | 0.4 GB | `Promise<DarknetResult & { data?: any }>` | Authenticate on a directly-connected darknet server. Grants session to current PID only. Speed scales with threads; slower if player charisma < server charisma level. `additionalMsec` adds extra delay (default 0). |
| `connectToSession(host, password)` | 0.05 GB | `DarknetResult` | Get a session on a previously-authenticated server at any distance. Allows scp to target; allows exec if directly connected or target has stasis link/backdoor. |
| `getBlockedRam(host?)` | 0 GB | `number` | RAM blocked by server owner's processes. Defaults to current server. |
| `getDarknetInstability()` | 0 GB | `DarknetInstability` | Current instability from excessive backdooring. |
| `getDepth(host?)` | 0.1 GB | `number` | Depth of server in darknet tree (darkweb neighbors = depth 0). Returns -1 if offline/not found. Defaults to current server. |
| `getServerDetails(host?)` | 0.1 GB | `DarknetServerDetails & { isOnline: boolean }` | Darknet-specific server details. Returns dummy object with `isOnline: false` if server recently went offline. Defaults to current server. |
| `getServerRequiredCharismaLevel(host)` | 0.1 GB | `number` | Charisma required to use heartbleed on this server. Below this level, authentication also takes much longer (or is impossible on deep servers). |
| `getStasisLinkedServers(returnByIP?)` | 0 GB | `string[]` | Hostnames/IPs of all stasis-linked servers. |
| `getStasisLinkLimit()` | 0 GB | `number` | Max global stasis links allowed. Increased by deep darknet augmentations. |
| `heartbleed(host, options?)` | 0.6 GB | `Promise<DarknetResult & { logs: string[] }>` | Extract (and remove) recent logs from a directly-connected server. Use `{ peek: true }` to read without removing. Speed scales with threads. Requires player charisma ≥ server's required level. |
| `induceServerMigration(host)` | 4 GB | `Promise<DarknetResult>` | Increase chance the server moves elsewhere in the darknet. Target must be directly connected and non-stationary. Scales with threads and charisma. |
| `isDarknetServer(host?)` | 0.1 GB | `boolean` | Whether the server is a darknet server. Does NOT require DarkscapeNavigator.exe. |
| `labradar()` | 0 GB | `Promise<Result<any>>` | "There is more than meets the eye." (Undocumented/secret function.) |
| `labreport()` | 0 GB | `Promise<Result<any>>` | "Not all who wander are lost." (Undocumented/secret function.) |
| `memoryReallocation(host?)` | 1 GB | `Promise<DarknetResult>` | Free some blocked RAM on an authenticated, directly-connected server. Amount scales with charisma and threads. Defaults to current server. |
| `nextMutation()` | 0 GB | `Promise<void>` | Sleep until the next darknet mutation cycle. Mutations include: nothing, servers moving/going offline/restarting, new servers appearing. |
| `openCache(filename, suppressToast?)` | 2 GB | `CacheResult` | Open a `.cache` file on the current server. Returns contents and karma lost. `suppressToast` silences the notification. |
| `phishingAttack()` | 2 GB | `Promise<DarknetResult>` | Build charisma and steal money. Only usable from darknet servers. Scales with threads. Occasionally drops a cache file. |
| `probe(returnByIP?)` | 0.2 GB | `string[]` | List all darknet servers directly connected to the current server. Returns `["darkweb"]` when called from home. |
| `promoteStock(sym)` | 2 GB | `Promise<DarknetResult>` | Increase stock volatility via propaganda. Does not change forecasts. Scales with charisma and threads; effect degrades over time. |
| `setStasisLink(shouldLink?)` | 12 GB | `Promise<DarknetResult>` | Apply (`true`, default) or remove (`false`) a stasis link on the current server. Enables remote exec/connectToSession; prevents server from going offline or moving. Global limit applies. |
| `unleashStormSeed()` | 0.1 GB | `DarknetResult` | Execute STORM_SEED.exe if present. Creates a webstorm — "catastrophic damage to the darknet." **Do not run without understanding consequences.** |

### Notes & Discovered Behavior

- Sessions are **per-PID** — each script instance must call `connectToSession` or `authenticate` independently.
- `heartbleed` with `peek: true` leaves logs on the server; without peek, logs are consumed. Parallel BFS instances can race and drain the log queue, returning `[]`.
- `setStasisLink` costs 12 GB — isolate in a separate helper script (`dnet-stasis.js`) and scp+exec to the target rather than referencing it in the main explorer.
- `authenticate()` only returns `{ success }` in the base result — use `heartbleed` after failed attempts to read server feedback.
- Authentication speed scales with threads; charisma below server's requirement slows or blocks it.
- `memoryReallocation` can be called repeatedly (up to ~20 times) until it throws, freeing blocks each time.

Cheat success probability decreases each use within a game. On failure: immediate game loss + winstreak reset.
