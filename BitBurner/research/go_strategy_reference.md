# Go Strategy Reference for IPvGO Bot

*Researched 2026-06-26. Focused on tactics applicable to a JavaScript heuristic bot on 5–13×13 boards.*

---

## §1 — Ladder Reading

### What it is
A ladder is a sequence of forced moves where a group tries to escape by running, but gets caught in a zig-zag pattern toward the board edge. The pursuer fills liberties one at a time; the escapee has only one legal reply each time. Ladders always terminate at the edge unless a "ladder-breaker" stone intervenes.

### Algorithm
Simulate the forced sequence. After placing each capture threat, the defender has exactly one liberty to run to. Check each step:
- If the fleeing group reaches 0 liberties → captured (ladder works)
- If the fleeing group reaches 2+ liberties → escaped (ladder fails)
- Stop after `boardSize * 2` steps (depth limit)

Branching factor is ~1, so this is nearly free to compute. The key check is whether any friendly stone lies on the ladder path — if so, the ladder breaks.

### Application to bot
- Before playing a "smother" (reducing enemy to 1 lib), verify the resulting atari is actually a working ladder, not a free escape.
- When our group is fleeing with 1 liberty: check if we can escape via a ladder breaker already on the board.
- Addresses: **close losses** (playing ineffective smothers), **wipeouts** (missing ladder escapes).

---

## §2 — Joseki Corner Sequences

### What it is
Joseki are established locally optimal opening sequences. On small boards, encoding full joseki is counterproductive — applying a joseki sequence without whole-board awareness is actively harmful. Instead, use the principles behind joseki:

### Actionable heuristics
- **3-3 point** (one in from each corner): most efficient single-stone claim on 7×7 and 9×9. Claims the corner immediately; opponent invading at 3-3 cedes the corner.
- **Ponnuki shape** (+30 value): four stones in a diamond around a captured stone. Extremely strong — worth ~30 points of influence according to Go proverb.
- **Empty triangle** (penalty): three connected stones forming an L/V shape with an empty interior corner. Bad shape — inefficient liberty use. Penalize in scorer.
- **Hane-at-the-head**: playing on top of two adjacent opponent stones in a row. Strong forcing move worth a bonus.

### Application to bot
Add shape bonuses/penalties to the scorer:
- `+2.0` if move creates or extends a ponnuki (capture that makes a diamond)
- `-1.0` if move creates an empty triangle in our stones
- These are cheaper than full joseki and avoid the "joseki without context" trap.

---

## §3 — Direction of Play

### What it is
Choosing which side of the board to develop. The core principle: **play away from thickness** (both yours and the opponent's). Thick = a large, secure, well-connected group. Playing near thickness wastes the potential of that thickness and compresses your own space.

### Key principles
1. **Don't walk into opponent strength**: a move adjacent to a large opponent group gives them extra influence at no cost.
2. **Extend from your own strength**: stones near your thick groups are over-concentrated and wasteful.
3. **Seek open space**: moves toward the largest open areas grow territory most efficiently.
4. **Extension distance rule**: extend 2–3 stones along an edge from a group. Too close = inefficient; too far = weak.

### Application to bot
Add to scorer:
- Measure distance to nearest large (≥5 cell) opponent group. Penalize moves within 2 of opponent thickness.
- `spaceScore`: bonus proportional to reachable empty space from that position (a move that opens up more space is better).
- Addresses: **encirclement** (the main wipeout cause — we're getting pushed into corners).

---

## §4 — Influence Maps

### What it is
A numeric map of how much each player "controls" each cell, based on stone positions and board topology. Used to estimate territorial balance and flag encirclement.

### GNU Go's influence formula
- Influence decays by factor 3 axially (orthogonal) and factor 6 diagonally per step.
- Territory estimate per cell: `sign((white_inf - black_inf) / (white_inf + black_inf))^3`
- Apply a neighbor-minimum step to smooth the map.

### Simplified version for bot
```js
function buildInfluenceMap(board) {
    const sz = board.length;
    const inf = Array.from({length: sz}, () => new Array(sz).fill(0));
    for (let x = 0; x < sz; x++) {
        for (let y = 0; y < sz; y++) {
            const c = board[x][y];
            if (c !== 'X' && c !== 'O') continue;
            const sign = c === 'X' ? 1 : -1;
            // Spread influence with decay
            for (let dx = -sz; dx <= sz; dx++) {
                for (let dy = -sz; dy <= sz; dy++) {
                    const nx = x + dx, ny = y + dy;
                    if (nx < 0 || nx >= sz || ny < 0 || ny >= sz) continue;
                    const dist = Math.abs(dx) + Math.abs(dy);
                    if (dist === 0) continue;
                    inf[nx][ny] += sign * (1.0 / (dist * dist));
                }
            }
        }
    }
    return inf;
}
```

### Application to bot
- Use influence map to identify cells where we're losing control (negative inf) as targets.
- Replace the current `reachableSpace` ratio gate with a more accurate influence-based encirclement detector.
- Addresses: **global encirclement** / wipeout prevention.

---

## §5 — Ko Fights

### What it is
Ko is a situation where two players could theoretically capture each other's stones indefinitely (same board state repeated). The ko rule forbids immediately recapturing. A "ko fight" is when both players make "ko threats" — big moves elsewhere — forcing the opponent to respond before recapturing.

### Superko vs. basic ko
- **Basic ko**: only forbids recreating the *immediately preceding* board state.
- **Superko**: forbids any previously seen board state (full game history). The official Bitburner scoring uses superko.

### Algorithm for detection
Hash the board state (e.g., join board strings). Keep a Set of seen hashes. Before making a move, check that the resulting board hash is not in the set.

### Ko fight strategy
- If you expect to *win* the ko (more/bigger threats): play your *smallest* threat first (save biggest for later).
- If you expect to *lose* the ko: play your *largest* threat first (minimize damage).
- Ko value ≈ `70%` of a direct win if you have initiative, `50%` otherwise.

### Application to bot
- Add superko check to `simulateMove` to avoid illegal moves.
- If a ko position is detected (our move creates a position in the history), prefer a different move unless the ko is very large.

---

## §6 — Territorial Efficiency

### What it is
Corners, edges, and center have different "yield" per stone. Corner stones secure 2 directions with walls; edge stones secure 1; center stones secure none. This means the same number of stones claims far more territory near corners.

### Line-height weights
In full-size Go:
- 1st line (edge): often too low in the long run (territory is thin, can be invaded)
- 2nd line: good for securing territory already claimed
- 3rd line: optimal balance of territory and influence for most positions  
- 4th line: better for influence/thickness than territory

On small boards (7×7), the 3rd line = `coord 2` (0-indexed). The 3-4 point is often optimal.

### Shape bonuses for scorer
| Shape | Bonus/Penalty |
|---|---|
| Ponnuki (diamond after capture) | +3.0 |
| Corner claim (stone at 2-2 or 3-3) | already in bot as +1.0 |
| Edge extension (stone on 3rd line) | +0.5 |
| Empty triangle (our stones form L with empty corner) | -1.0 |
| Hane-at-the-head (atop 2 opponent stones) | +1.5 |

---

## §7 — Life and Death (True/False Eyes, Nakade)

### True vs. false eyes
An "eye" is an enclosed empty region. A **true eye** is one the opponent cannot fill to capture the enclosing group. A **false eye** is one that looks like an eye but can be filled.

**False eye detection rule:**
- **Corner position**: false if 1 diagonal neighbor is an enemy stone
- **Edge position**: false if any of its 2 real diagonal neighbors is an enemy stone  
- **Interior position**: false if 2 or more of its 4 diagonal neighbors are enemy stones

A group needs **2 true eyes** to be permanently alive.

### Nakade (killing large eye spaces)
When an enemy group has 1 incomplete eye space of 3–6 points, there is often a single "vital point" that kills the group by preventing it from splitting into 2 true eyes.

**Vital point algorithm** (`findVitalPoint(eyeSpace)`):
- For each cell in the eye space, count how many other eye-space cells are orthogonally adjacent
- The cell with the **most internal neighbors** is the vital point
- This works for all standard nakade shapes (straight 3, bent 3, square 4, straight 4, pyramid 4, cross 5, etc.)

### Application to bot
1. Implement `isTrueEye(board, x, y, color)` using the diagonal test above.
2. Upgrade `countEyes` to count **true** eyes only (not just any enclosed empty region).
3. Add nakade detection: when opponent has exactly 1 incomplete eye region of 3–6 cells, find and play the vital point.
4. Group crisis detection: groups with 0 true eyes and < 5 liberties are in crisis → prioritize above territory plays.
5. Addresses: **wipeouts** (we're building false eyes), **close losses** (missing nakade kills).

---

## §8 — Sente / Gote (Initiative)

### What it is
- **Sente**: a move that *forces* the opponent to respond locally. After making it, you keep the initiative.
- **Gote**: a move the opponent doesn't need to respond to immediately. After making it, the opponent plays elsewhere.

A sente move is worth roughly **double** its face value because you get the move and also get to play next.

### Endgame move ordering
1. Play all **sente** moves first (regardless of size)
2. Then play **gote** moves in descending size order

Misordering costs 3–8 points per game.

### Detection in the bot
Current bot approximates this: `+0.5` for sente (opponent didn't reply adjacent). Better approach:
- After simulating our move + opponent best reply, check if opponent's reply was *forced* (they had no better alternative elsewhere). If so, classify as sente and add a larger bonus (+1.5).
- If opponent's reply gains them significantly more territory elsewhere than staying local, classify our move as gote.

---

## §9 — Weak Group Management

### What it is
The most common way to lose in Go: getting two or more weak groups attacked simultaneously. The opponent plays "splitting moves" that threaten both at once, and you can only save one.

### Group danger classification
| Status | Condition | Priority |
|---|---|---|
| Atari | 1 liberty | Immediate (already in bot) |
| Pre-atari | 2 liberties | High (already in bot) |
| Vulnerable | ≤3 liberties, 0 true eyes | Medium-high |
| Weak | ≤5 liberties, <2 true eyes | Medium |
| Safe | 2+ true eyes OR >5 liberties | Low |

### The key rule
**If you have more than 1 group in "vulnerable" or worse status, do not play territory.** Find the move that consolidates the most weak groups. GNUGo assigns CRITICAL group rescue a floor value of 40 (overrides territory plays at floor 20 and joseki at floor 27).

### Application to bot
- Before entering the scorer, count groups with 0 true eyes and ≤4 liberties.
- If count ≥ 2: find the move that connects the most vulnerable groups OR gives the most combined liberty gain.
- This directly addresses **wipeouts** (multiple groups dying at once).

---

## Implementation Priority for Current Bot

Given current failure modes (wipeouts dominant at ~32% win rate):

| Priority | Strategy | Expected Impact | Difficulty |
|---|---|---|---|
| 1 | True eye detection (§7) | High — fixes false safety assessment | Medium |
| 2 | Weak group gate (§9) | High — prevents multi-group wipeouts | Medium |
| 3 | Nakade vital points (§7) | Medium — kills trapped groups sooner | Low |
| 4 | Ladder reading (§1) | Medium — validates smothers | Medium |
| 5 | Influence map (§4) | High — better encirclement detection | High |
| 6 | Sente bonus upgrade (§8) | Medium — improves close games | Low |
| 7 | Shape bonuses (§6) | Low-Medium — marginal per-move improvement | Low |
| 8 | Direction of play (§3) | Medium — prevent walking into opponent strength | Medium |

---

## Key Differences from Our Current Bot

1. **We count any enclosed empty region as an "eye"** — we need true/false eye detection to know which groups are actually safe.
2. **We have no group danger tier** — just atari (1 lib) and pre-atari (2 lib). No concept of "0 true eyes = crisis regardless of liberties."
3. **We have no ladder reading** — smothers may not actually work.
4. **Our encirclement gate (55% space ratio) fires too late** — an influence map would catch encirclement earlier with better directional guidance.
5. **No nakade** — we play anti-eye (play inside opponent's eye) but don't specifically target the vital point of large eye spaces.
