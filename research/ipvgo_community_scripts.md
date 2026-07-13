# Bitburner IPvGO Community Bot Scripts and Strategies

*Researched 2026-06-26*

## Overview

This report covers all publicly found Bitburner IPvGO automation scripts and community approaches. IPvGO is a Go-like mini-game in Bitburner where players write Netscript/JavaScript to automate play.

---

## Source 1: alainbryden/bitburner-scripts — `go.js`

**URL:** https://github.com/alainbryden/bitburner-scripts/blob/master/go.js  
**Stars:** 737 (most-starred Bitburner scripts repo)  
**Language:** JavaScript  
**Status:** Active (1,213 commits, updated 2025)

### Algorithm
Priority-waterfall heuristic. No tree search. Each turn, the script tries each tactic in a fixed priority order and plays the first that returns a valid move.

### Move Priority Order
1. `getRandomCounterLib()` — rescue friendly chains at 1 liberty by finding a neighbor also adjacent to an enemy chain at 1 liberty (BFS-based)
2. `getRandomLibAttack(88)` — attack enemy chains with combined value ≥ 88
3. `getRandomLibDefend()` — rescue own chains at 1 liberty
4. `getSnakeEyes(6)` — cheat move (BN14.2): capture enemy 2-liberty chains in one double-move
5. `getAggroAttack(2,2,2)` — attack enemies at 2 liberties
6. `disruptEyes()` — break enemy eye formations via 4×4 and 5×5 patterns
7. `getDefPattern()` — apply defensive board patterns
8. `getAggroAttack(3,3,3,1,6)` / `getDefAttack(...)` — broader attack passes
9. `attackGrowDragon()` — grow large connected chains
10. `getRandomExpand()` — territorial expansion
11. `getRandomStrat()` — general positional play
12. `passTurn()`

### Faction-Specific Logic
Seven distinct pipelines selected by `ns.go.getOpponent()`. Key differences:
- **Netburners:** adds `getDefAttack(8,20,2)` before expansion
- **Slum Snakes:** replaces aggro variant with `getDefAttack(4,7,3,1,6)`
- **Daedalus:** `getAggroAttack(3,4,3,1,6)` + `getDefAttack(5,7,3,2,6)`
- **Tetrads:** two aggro passes, no defensive fallback
- **Illuminati:** single aggro pass, no defensive fallback
- **???????????? (w0r1d_d43m0n):** balanced hybrid

### Opening Book
Hard-coded star-point sequences per board size, played only in the first 3 turns when all neighbors are empty:
- 7×7: (2,2)→(2,4)→(4,4)→(4,2)→(3,3)→(1,1)→(5,1)→(5,5)→(1,5)
- 9×9: (2,2)→(2,6)→(6,6)→(6,2)→(3,3)→(3,5)→(5,5)→(5,3)
- 13×13: 12-position sequence, corners first
- 19×19: center then four corners

### Pattern Matching
4×4 and 5×5 patterns, 8 orientations each (4 rotations × vertical mirror). Rich symbol set: `X O x o . W B b A ? *`. Six disrupt4 patterns for breaking enemy eyes, eight disrupt5 patterns, four def5 corner containment patterns. Quality-rated in comments with `#GREAT`.

### Key Heuristics
- `getChainValue(x,y)`: BFS flood-fill chain size count
- `getEyeValue(x,y)`: BFS counting player-controlled cells reachable from neighbors
- `getHeatMap(x,y,player,depth=2)`: 2-depth influence square; friendly pieces = 1.5, empty = 1.0
- `createsLib(x,y)`: gate that skips moves reducing a friendly chain to exactly 1 liberty
- `getSurroundLibs(x,y)`: weighted breathing room around a position

### Wipeout / Loss Handling
After game-over, resets board to a random opponent at size 13 and continues. Error recovery wraps the main loop in try/catch with 10-second retry.

---

## Source 2: nanogyth/go_bot — `get_move_ref.ts`

**URL:** https://github.com/nanogyth/go_bot  
**Language:** TypeScript  
**Status:** 8 commits, last updated March 15, 2025

### Algorithm
Expert system. Rule-based with faction personality profiles. Top-level `getMove()` calls `getFactionMove()` (faction-specific priority), falls back to random selection from a lazy `MoveOptions` object.

### Core Architecture
`MoveOptions` is a lazy-evaluated object where each key is a function computing one move category on demand. Results are cached per turn. Categories: `capture, defendCapture, eyeMove, eyeBlock, pattern, growth, surround, corner, expansion, jump, defend, random`.

### Faction Priority Stacks

| Faction | Priority Order |
|---|---|
| Netburners | 20% Illuminati, expansion, growth, random |
| Slum Snakes | Defend, 20% Illuminati, growth, random |
| The Black Hand | Capture, surround≤1lib, defend, surround≤2libs, 30% Illuminati |
| Tetrads | Capture, defend, pattern, surround≤1lib, 40% Illuminati |
| Daedalus | 90% Illuminati, else random |
| Illuminati | capture → defend → eye → surround≤1lib → eyeblock → corner → pattern(75%) → jump(60%) → surround≤2libs |

**Smartness gate:** Netburners never smart, SlumSnakes smart 30%, Black Hand smart 80%, rest always smart. Smart mode gates patterns to moves with >1 effective liberty.

### Key Tactics
- **`getSurroundMove()`**: classifies moves as capture (enemy ≤1 lib), atari (enemy =2 libs, safe to play), or surround (enemy lib reduction, new piece safe ≥2 libs). Safety filter: skip if `newLibertyCount <= 2 && enemyChainLibertyCount > 2`.
- **`getEyeCreationMoves()`**: simulates each candidate, counts resulting eyes and living groups (chains with ≥2 eyes). Sorts `createsLife: true` moves first.
- **`getEyeBlockingMove()`**: only fires when opponent has exactly one eye-creating move available.
- **`findDisputedTerritory()`**: filters out moves deep in enemy-controlled space unless the border enemy chain has ≤4 liberties, is touched externally by the player, and has all liberties inside the void.
- **`getLibertyGrowthMoves()`**: delta `newLibertyCount - oldLibertyCount`, requires `newLibertyCount >= oldLibertyCount && > 1`.

### Pattern Library
13 classical Go joseki/tesuji patterns (hane, kiri, de, keima, sagari, etc.) expanded to up to 52 variants via 4 rotations and vertical + horizontal mirrors. Matched moves are randomly selected (no weighting among matched patterns). Liberty filter applied when smart mode is on.

---

## Source 3: nanogyth/go5x5 — `bad_bot.js`

**URL:** https://github.com/nanogyth/go5x5  
**Language:** JavaScript  
**Status:** 7 commits, last updated March 8, 2025

### Algorithm
Not an AI — a deterministic exploit. Forces the Illuminati opponent into a known starting state via brute-force RNG reset, then plays a pre-solved lookup table.

**Phase 1:** Calls `ns.go.resetBoardState("Illuminati", 5)` in a tight loop until board string equals `"............O............"` — opponent's single stone at center (2,2). Reported retry count: 1,802,240.

**Phase 2:** Plays three fixed moves, records opponent responses, computes hash from second response.

**Phase 3:** Lookup table maps each hash to a sequence of move/expect pairs.

Only works on 5×5 Illuminati. Depends on opponent AI being deterministic from a given seed state.

---

## Source 4: G4mingJon4s/bitburner-ipvgo-rust

**URL:** https://github.com/G4mingJon4s/bitburner-ipvgo-rust  
**Language:** Rust  
**Status:** 39 commits, last updated March 18, 2025

### Architecture
External microservice communicating with Bitburner via a local HTTP server.

### Board Representation
Flat array `Vec<Option<usize>>` mapping positions to chain IDs. Four tile states: `White`, `Black`, `Dead` (offline), `Free` (empty). Undo system via `MoveChange` / `Mod` enum (Assignment, Addition, Change ops applied in reverse for tree search).

### Evaluation Engine

**Alpha-Beta (negamax with transposition table):**
- Depth configurable at construction
- Parallel root search via Rayon `par_iter()`
- LRU-bounded transposition table with Exact/LowerBound/UpperBound entries

**Monte Carlo Tree Search (UCT):**
- UCB1 exploration constant: 1.1
- Exploitation via sigmoid: `1.0 / (1.0 + exp(-0.3 * score))`
- Time-bounded iterations (configurable `Duration`)
- Pure random rollout policy
- Tree reuse: subtree preserved after each move (`MonteCarloSession`)

**Scoring formula:** `score = -komi + black_tiles + black_territory - white_tiles - white_territory`

### Move Generation
Restricts single-liberty free spaces: placement only allowed if it captures an opponent chain or joins a friendly chain with ≥2 liberties (anti-suicide rule).

---

## Source 5: tautastic/gogo-server

**URL:** https://github.com/tautastic/gogo-server  
**Language:** Go (server) + JavaScript (client)

### Algorithm
Wraps KataGo — a professional-strength open-source Go AI (deep residual CNN + MCTS, trained via self-play).

### Architecture
Go HTTP server. KataGo runs as a subprocess. Bitburner client posts to:
- `POST /init` — board size, komi, handicap stones
- `POST /play-move` — submit player's move
- `POST /gen-move` — request AI move (returns coordinate)

**Limitation:** KataGo is strongest on standard Go boards; Bitburner's irregular board shapes (dead nodes) may not be handled correctly.

---

## Source 6: chuhanuman/BitBurner-Go

**URL:** https://github.com/chuhanuman/BitBurner-Go  
**Language:** C++ + JavaScript  
**Status:** Last updated November 20, 2024

### Algorithm
Basic MCTS. External microservice communicating via WebSockets (`localhost:8080`). 5×5 recommended; variable sizes supported.

---

## Source 7: Glahf42/Bitburner-IPvGO — `makeBoards.js`

**URL:** https://github.com/Glahf42/Bitburner-IPvGO/blob/main/makeBoards.js  
**Status:** 1 commit, December 25, 2025

### Algorithm
Board analysis engine focused on influence/gravity mapping.

### Gravity System
For each stone in each chain, casts ~40 rays (0 to 2π in 0.157-radian steps). Each ray propagates outward with `gravity = mass / distance²` where mass = liberty count (negative for opponent chains). Maximum gravity per cell per chain recorded, then chains summed. `gravityTest()` simulates placing a stone, recomputes total gravity, and returns the delta as a move score.

---

## Source 8: Official Bitburner Game Source — IPvGO Opponent AI

**URL:** https://github.com/bitburner-official/bitburner-src/tree/dev/src/Go  
**Key files:** `boardAnalysis/goAI.ts`, `boardAnalysis/patternMatching.ts`, `boardAnalysis/scoring.ts`

### Faction Definitions

| Opponent | Komi | Style | Bonus |
|---|---|---|---|
| Netburners | 1.5 | Easy/Random | Hacknet ×1.3 |
| Slum Snakes | 3.5 | Spread | Crime success ×1.2 |
| The Black Hand | 3.5 | Aggro | Hacking money ×0.9 |
| Tetrads | 5.5 | Martial | Combat ×0.7 |
| Daedalus | 5.5 | Mid | Reputation ×1.1 |
| Illuminati | 7.5 | Hard | Script speed ×0.7 |
| w0r1d_d43m0n | 9.5 | ??? | Hacking ×2.0 |

### Opponent AI Priority Stacks (from goAI.ts)

**Illuminati (full stack):** capture → defend → eye creation → surround≤1lib → eye block → corner → pattern(75%) → jump(60%) → surround≤2libs

**Daedalus:** 90% Illuminati, else random fallback

**Tetrads:** capture → defend → pattern → surround≤1lib → 40% Illuminati

**The Black Hand:** capture → surround≤1lib → defend → surround≤2libs → 30% Illuminati → 75% any surround → 80% random

**Slum Snakes:** defend → 20% Illuminati → growth(60%) → random(65%)

**Netburners:** 20% Illuminati → expansion(40%) → growth(60%) → random(75%)

**Smartness gate:** Netburners never smart. Slum Snakes: smart 30%. Black Hand: smart 80%. Tetrads/Daedalus/Illuminati: always smart. Smart mode prevents self-atari patterns and adds liberty-quality filters.

### Pattern Library (from patternMatching.ts)
13 named classical Go patterns: 4 hane variants (enclosing, non-cutting, magari), 1 katatsuke/diagonal attachment, 3 cut patterns (kiri unprotected, kiri peeped, de), 1 cut keima, and 4 side patterns (chase, block side cut, block side connection, sagari). Expanded to up to 52 variants via 4 rotations + vertical + horizontal mirrors. Uniform random selection among matched patterns.

### Scoring (from scoring.ts)
Area scoring: pieces + territory + komi. Territory = empty chains fully bordered by one player. Empty chains larger than `boardSize² - 3` are unowned (prevents claiming the whole open board). Node power awarded even on loss: `nodePower += blackScore × difficultyMultiplier × winstreakMultiplier`. Every 2nd consecutive win grants faction reputation. 10-game winstreak vs. Illuminati grants an achievement.

### Controlled Territory (from controlledTerritory.ts)
`findDisputedTerritory()`: prunes moves inside enemy-controlled voids unless a border enemy chain has ≤4 liberties, is externally touched by the player, and has all liberties inside the void. This prevents both player and opponent from pointlessly filling unwinnable territory.

---

## Cross-Cutting Themes

### Wipeout Prevention
No script specifically handles wipeout (losing all stones to capture) as a distinct case — prevention is preferred over recovery. The key prevention mechanisms: (1) defend atari chains immediately, (2) build two-eye formations for immortal groups, (3) don't play into enemy-controlled territory.

### MCTS / Minimax Approaches
- **G4mingJon4s/bitburner-ipvgo-rust**: alpha-beta (negamax + transposition table + parallel search) AND MCTS (UCT, time-bounded, tree reuse, pure random rollout). Most technically sophisticated.
- **chuhanuman/BitBurner-Go**: Basic MCTS in C++, WebSocket integration.
- **tautastic/gogo-server**: wraps KataGo (CNN + MCTS), strongest raw engine but not Bitburner-specific.
- All heuristic bots (alainbryden, nanogyth) avoid tree search entirely in favor of cascading priority rules.

### Pattern Matching
All serious heuristic bots use pattern matching. The official game AI uses 13 3×3 patterns (52 variants); nanogyth's expert system uses the same 13; alainbryden's uses 4×4/5×5 patterns with richer symbol language. None use weighted pattern priorities — all use uniform random selection among matched moves.

### Influence Maps
Two approaches found: alainbryden's `getHeatMap()` (2-depth square scan with fixed weights) and Glahf42's inverse-square gravity system (ray-casting with mass/distance² falloff). Neither is used as a primary decision mechanism — both serve as scoring inputs.

---

## Key URLs

| Resource | URL |
|---|---|
| alainbryden go.js (source) | https://raw.githubusercontent.com/alainbryden/bitburner-scripts/master/go.js |
| nanogyth go_bot (source) | https://raw.githubusercontent.com/nanogyth/go_bot/main/get_move_ref.ts |
| nanogyth go5x5 bad_bot | https://github.com/nanogyth/go5x5 |
| G4mingJon4s ipvgo-rust | https://github.com/G4mingJon4s/bitburner-ipvgo-rust |
| tautastic gogo-server | https://github.com/tautastic/gogo-server |
| chuhanuman BitBurner-Go | https://github.com/chuhanuman/BitBurner-Go |
| Glahf42 Bitburner-IPvGO | https://github.com/Glahf42/Bitburner-IPvGO |
| Official game AI (goAI.ts) | https://github.com/bitburner-official/bitburner-src/blob/dev/src/Go/boardAnalysis/goAI.ts |
| Official patterns | https://github.com/bitburner-official/bitburner-src/blob/dev/src/Go/boardAnalysis/patternMatching.ts |
| Official scoring | https://github.com/bitburner-official/bitburner-src/blob/dev/src/Go/boardAnalysis/scoring.ts |
| Official constants | https://github.com/bitburner-official/bitburner-src/blob/dev/src/Go/Constants.ts |
