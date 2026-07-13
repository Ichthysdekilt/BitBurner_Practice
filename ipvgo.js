/** @param {NS} ns */
export async function main(ns) {
    ns.disableLog("ALL");

    const DEBUG_ONE_GAME = false; // set true for per-turn board logging (exits after 1 game)
    const SELF_TEST = false;      // set true to run the capture-reader self-test and exit (no game played)
    const LOG_LOSS_TRACE = true;  // dump per-move trace + lead trajectory + pre-collapse board on losses only

    const flags  = ns.flags([["silent", false]]);
    const SILENT = flags.silent; // true: suppress ns.tprint (terminal) but keep ns.print (log window)

    const tprint = (...args) => { ns.print(...args); if (!SILENT) ns.tprint(...args); };

    // ── Self-test: prove the capture reader on known positions, then exit ────────
    // Deterministic, ~instant. Run with SELF_TEST=true before trusting reader changes
    // instead of measuring a 100-game batch. Boards are column-string arrays: board[x][y].
    // Reader fns below are hoisted function declarations, so they're callable here.
    if (SELF_TEST) {
        let pass = 0, fail = 0;
        const check = (name, got, want) => {
            const ok = got === want;
            ok ? pass++ : fail++;
            tprint(`[self-test] ${ok ? 'PASS' : 'FAIL'} ${name} (got ${got}, want ${want})`);
        };

        // A: O in atari with its single liberty at (2,3) — capturable; proven move = (2,3).
        const A = [".....", "..X..", ".XO..", "..X..", "....."];
        const mvA = findCapturingMove(A, [{x:2, y:2}], 'X', 'O', 10);
        check("A capturable",          readCapture(A, [{x:2, y:2}], 'X', 10), true);
        check("A move is the liberty", !!(mvA && mvA.x === 2 && mvA.y === 3),  true);

        // B: lone O with 4 liberties in open space — must NOT be claimed capturable
        // (the direction we must never get wrong: never report a healthy group as dead).
        const B = [".....", ".....", "..O..", ".....", "....."];
        check("B not capturable",      readCapture(B, [{x:2, y:2}], 'X', 10), false);

        // C: enclosed dead straight-2 O group (one 2-space eye, not two) — reader must read
        // the kill through the recursion: X fills one eye point (NOT self-atari, since the
        // wall has outside liberties on the open column x=4), O's only reply is self-atari
        // suicide, X captures. NOTE the open column is REQUIRED: without it the enclosing X
        // wall has no outside liberties and the position is a capturing race O wins — the
        // reader correctly reports that as not-capturable (this is the self-atari check that
        // prevents wipeout-causing "kills"). Keep the board ≥5 wide.
        const C = ["XXXX.", "X..X.", "XOOX.", "XXXX.", "....."];
        check("C dead 2-space killed",  readCapture(C, [{x:2, y:1}, {x:2, y:2}], 'X', 10), true);

        // D: OUR X stone in atari — symmetric use (attacker = O). Must be capturable.
        const D = [".....", "..O..", ".OX..", "..O..", "....."];
        check("D our stone capturable", readCapture(D, [{x:2, y:2}], 'O', 10), true);

        // E: fully-enclosed X group with TWO genuine eyes at (1,1) and (3,1); its only two
        // liberties ARE those eyes. Every O fill is self-atari suicide → must be ALIVE.
        const E = ["XXXOO", "X.XOO", "XXXOO", "X.XOO", "XXXOO"];
        check("E two-eye group alive",  readCapture(E, [{x:0, y:0}], 'O', 8), false);

        // ── Influence-map tests ──────────────────────────────────────────────
        // F: point-symmetric board (X mirror of O) → influence must be exactly equal.
        const F = [".....", ".X...", ".....", "...O.", "....."];
        const infF = influenceScore(F);
        check("F symmetric equal infl", infF.black === infF.white, true);

        // G: single X stone, no O anywhere → X owns the whole board, O owns nothing.
        const G = [".....", ".....", "..X..", ".....", "....."];
        const infG = influenceScore(G);
        check("G lone stone: O has 0",  infG.white === 0,              true);
        check("G lone stone: X = area", infG.black === 25,             true);

        // H: central X vs corner O (NOT symmetric) — the central stone reaches more empty
        // cells first, so X must control strictly more than O.
        const H = ["O....", ".....", "..X..", ".....", "....."];
        const infH = influenceScore(H);
        check("H center beats corner",  infH.black > infH.white,       true);

        tprint(`[self-test] ${pass} passed, ${fail} failed`);
        return;
    }

    const OPPONENTS = ["Netburners", "Slum Snakes", "The Black Hand", "Tetrads", "Daedalus", "Illuminati"];
    const SIZES     = ["5", "7", "9", "13"];

    const OPPONENT   = flags._[0]
        ? String(flags._[0])
        : await ns.prompt("Choose opponent:", { type: "select", choices: OPPONENTS });
    const BOARD_SIZE = flags._[1]
        ? Number(flags._[1])
        : Number(await ns.prompt("Choose board size:", { type: "select", choices: SIZES }));

    const KOMI_MAP = {
        "Netburners":     1.5,
        "Slum Snakes":    3.5,
        "The Black Hand": 3.5,
        "Tetrads":        5.5,
        "Daedalus":       5.5,
        "Illuminati":     7.5,
    };
    const komi = KOMI_MAP[OPPONENT] ?? 5.5;
    const PASS_MARGIN = 1; // pass when lead > komi + this

    const OPENINGS = {
        5:  [[2,2],[3,3],[3,1],[1,3],[1,1]],
        7:  [[2,2],[2,4],[4,4],[4,2],[3,3],[1,1],[5,1],[5,5],[1,5]],
        9:  [[2,2],[2,6],[6,6],[6,2],[3,3],[3,5],[5,5],[5,3]],
        13: [[2,2],[2,10],[10,10],[10,2],[3,3],[3,9],[9,9],[9,3],[4,4],[4,8],[8,8],[8,4]],
    };

    // ── Utilities ──────────────────────────────────────────────────────────────

    function nbrs(x, y, size) {
        const r = [];
        if (x > 0)        r.push([x - 1, y]);
        if (x < size - 1) r.push([x + 1, y]);
        if (y > 0)        r.push([x, y - 1]);
        if (y < size - 1) r.push([x, y + 1]);
        return r;
    }

    // Flood-fill group analysis. Returns [{color, cells, libertySet}].
    function findGroups(board) {
        const size = board.length;
        const vis  = Array.from({length: size}, () => new Array(size).fill(false));
        const out  = [];

        for (let x = 0; x < size; x++) {
            for (let y = 0; y < size; y++) {
                if (vis[x][y]) continue;
                const c = board[x][y];
                if (c !== 'X' && c !== 'O') continue;

                const group = { color: c, cells: [], libertySet: new Set() };
                const q = [{x, y}];
                vis[x][y] = true;

                while (q.length) {
                    const { x: cx, y: cy } = q.shift();
                    group.cells.push({x: cx, y: cy});
                    for (const [nx, ny] of nbrs(cx, cy, size)) {
                        const nc = board[nx][ny];
                        if      (nc === '.') group.libertySet.add(`${nx},${ny}`);
                        else if (nc === c && !vis[nx][ny]) {
                            vis[nx][ny] = true;
                            q.push({x: nx, y: ny});
                        }
                    }
                }

                out.push(group);
            }
        }
        return out;
    }

    // Area scoring: stones + enclosed empty nodes. Returns {black, white}.
    // '#' cells (dead nodes) are treated as neutral walls.
    function calcScore(board) {
        const size = board.length;
        let black = 0, white = 0;

        for (let x = 0; x < size; x++)
            for (let y = 0; y < size; y++) {
                if      (board[x][y] === 'X') black++;
                else if (board[x][y] === 'O') white++;
            }

        const vis = Array.from({length: size}, () => new Array(size).fill(false));
        for (let x = 0; x < size; x++) {
            for (let y = 0; y < size; y++) {
                if (vis[x][y] || board[x][y] !== '.') continue;

                const region = [];
                let hB = false, hW = false;
                const q = [{x, y}];
                vis[x][y] = true;

                while (q.length) {
                    const { x: cx, y: cy } = q.shift();
                    region.push(1);
                    for (const [nx, ny] of nbrs(cx, cy, size)) {
                        const nc = board[nx][ny];
                        if      (nc === 'X') hB = true;
                        else if (nc === 'O') hW = true;
                        else if (nc === '.' && !vis[nx][ny]) {
                            vis[nx][ny] = true;
                            q.push({x: nx, y: ny});
                        }
                    }
                }

                const n = region.length;
                if      (hB && !hW) black += n;
                else if (hW && !hB) white += n;
            }
        }

        return { black, white };
    }

    // Influence-based territory estimate (distance-Voronoi). Multi-source BFS from ALL
    // stones simultaneously through empty cells; each empty cell is awarded to the color
    // whose nearest stone reaches it first. Stones and '#' block paths. Cells reached by
    // both colors at the same distance (dame / contested boundary) are neutral.
    //
    // Why this instead of calcScore for move scoring: calcScore only counts FULLY sealed
    // regions, so in the midgame its (black-white) delta is ~0 for almost every candidate
    // move — the scorer was effectively flying blind on territory. Influence gives partial
    // credit for "leaning" territory turn by turn, a smooth gradient the scorer can climb.
    // It also folds capture in for free: a captured group's cells become empty and their
    // surrounding influence flips. Returns {black, white} (stones + owned empty cells).
    function influenceScore(board) {
        const size = board.length;
        const owner = Array.from({length: size}, () => new Array(size).fill(null));
        let black = 0, white = 0;
        let frontier = [];
        for (let x = 0; x < size; x++)
            for (let y = 0; y < size; y++) {
                const c = board[x][y];
                if      (c === 'X') { black++; owner[x][y] = 'X'; frontier.push([x, y, 'X']); }
                else if (c === 'O') { white++; owner[x][y] = 'O'; frontier.push([x, y, 'O']); }
            }

        // Level-synchronized BFS: each wave claims all cells at the next distance. A cell
        // claimed by two colors in the same wave is contested ('?') and stops propagating.
        while (frontier.length) {
            const claims = new Map();
            for (const [cx, cy] of frontier) {
                const col = owner[cx][cy];
                for (const [nx, ny] of nbrs(cx, cy, size)) {
                    if (board[nx][ny] !== '.' || owner[nx][ny] !== null) continue;
                    const key = `${nx},${ny}`;
                    const prev = claims.get(key);
                    if      (prev === undefined) claims.set(key, col);
                    else if (prev !== col)       claims.set(key, '?');
                }
            }
            const next = [];
            for (const [key, col] of claims) {
                const [nx, ny] = key.split(',').map(Number);
                owner[nx][ny] = col;
                if (col === 'X') { black++; next.push([nx, ny, 'X']); }
                else if (col === 'O') { white++; next.push([nx, ny, 'O']); }
                // '?' cells are recorded (owner set) but neither scored nor propagated.
            }
            frontier = next;
        }
        return { black, white };
    }

    // Simulate placing a stone at (x,y), capturing any opponent groups left
    // with 0 liberties. Returns a new board (array of strings).
    function simulateMove(board, x, y, color) {
        const size = board.length;
        const b    = board.map(col => col.split(''));
        const opp  = color === 'X' ? 'O' : 'X';
        b[x][y] = color;

        const checked = new Set();
        for (const [nx, ny] of nbrs(x, y, size)) {
            if (b[nx][ny] !== opp) continue;
            const key = `${nx},${ny}`;
            if (checked.has(key)) continue;

            const cells = [];
            let free = false;
            const vis = Array.from({length: size}, () => new Array(size).fill(false));
            const q = [{x: nx, y: ny}];
            vis[nx][ny] = true;

            while (q.length) {
                const { x: cx, y: cy } = q.shift();
                cells.push({x: cx, y: cy});
                checked.add(`${cx},${cy}`);
                for (const [ax, ay] of nbrs(cx, cy, size)) {
                    if      (b[ax][ay] === '.') free = true;
                    else if (b[ax][ay] === opp && !vis[ax][ay]) {
                        vis[ax][ay] = true;
                        q.push({x: ax, y: ay});
                    }
                }
            }

            if (!free) for (const {x: rx, y: ry} of cells) b[rx][ry] = '.';
        }

        return b.map(col => col.join(''));
    }

    // 2-ply lookahead: returns {score, board} after the opponent's best single reply.
    // "Best" = minimises (black - white). If passing is best for them, returns current state.
    function opponentBestResponse(b) {
        const sz = b.length;
        let bestScore = calcScore(b);
        let bestBoard = b;
        for (let x = 0; x < sz; x++) {
            for (let y = 0; y < sz; y++) {
                if (b[x][y] !== '.') continue;
                const sim = simulateMove(b, x, y, 'O');
                const s   = calcScore(sim);
                if ((s.black - s.white) < (bestScore.black - bestScore.white)) {
                    bestScore = s;
                    bestBoard = sim;
                }
            }
        }
        return { score: bestScore, board: bestBoard };
    }

    // Like opponentBestResponse but excludes cells adjacent to (mx, my) from consideration.
    // Used to test whether the opponent's actual local reply to our move was truly forced
    // (i.e. no better move existed elsewhere) — a real sente move.
    function opponentBestNonLocalResponse(b, mx, my, size) {
        const localSet = new Set(nbrs(mx, my, size).map(([nx, ny]) => `${nx},${ny}`));
        let bestScore = calcScore(b);
        for (let x = 0; x < size; x++) {
            for (let y = 0; y < size; y++) {
                if (b[x][y] !== '.' || localSet.has(`${x},${y}`)) continue;
                const sim = simulateMove(b, x, y, 'O');
                const s   = calcScore(sim);
                if ((s.black - s.white) < (bestScore.black - bestScore.white)) bestScore = s;
            }
        }
        return bestScore;
    }

    // Simulates the forced ladder-capture sequence starting once 'group' (opponent color)
    // is reduced to 1 liberty by us. Branching ~1: at each step the fleeing group has only
    // one useful liberty to run to. Returns true if the group is eventually captured
    // (ladder works), false if it escapes to >=2 liberties or the depth limit is hit.
    function ladderWorks(board, group, chaserColor, size) {
        const fleeColor = group.color;
        let b = board;
        const maxSteps = size * 2;
        for (let step = 0; step < maxSteps; step++) {
            const curGroups = findGroups(b);
            const cur = curGroups.find(g => g.color === fleeColor &&
                g.cells.some(c => group.cells.some(gc => gc.x === c.x && gc.y === c.y)));
            if (!cur || cur.libertySet.size === 0) return true;
            if (cur.libertySet.size >= 2) return false;

            const lib = [...cur.libertySet][0];
            const [fx, fy] = lib.split(',').map(Number);
            b = simulateMove(b, fx, fy, fleeColor);

            const postGroups = findGroups(b);
            const postCur = postGroups.find(g => g.color === fleeColor &&
                g.cells.some(c => group.cells.some(gc => gc.x === c.x && gc.y === c.y)));
            if (!postCur || postCur.libertySet.size === 0) return true;
            if (postCur.libertySet.size >= 2) return false;

            const chaseLib = [...postCur.libertySet][0];
            const [cx, cy] = chaseLib.split(',').map(Number);
            b = simulateMove(b, cx, cy, chaserColor);
        }
        return false;
    }

    // ── Capture-race reader (bounded AND-OR / tsumego search) ───────────────────
    // Generalizes ladderWorks. Answers: "can `attacker` force the capture of the chain
    // occupying `targetCells` (a `defender`-colored group), reading best mutual play to
    // `depth` plies?"  Branching is small — only liberty-filling and atari-capture moves
    // are considered — so depth 6–10 is cheap in pure JS on ≤13 boards.
    //
    // Soundness (matters more than completeness here):
    //  • The defender (AND node) tries EVERY escape it has — extend on its own liberties,
    //    or capture an adjacent attacker chain that is itself in atari. So a CAPTURED
    //    verdict is conservative: we only claim capture when the group cannot wriggle free
    //    within the read. This is the direction we must not get wrong (a false "capturable"
    //    would make us play a losing attack).
    //  • The attacker (OR node) only fills the target's liberties, so we may MISS captures
    //    that require approach/sacrifice moves (false negatives). That is the safe error:
    //    we simply decline to claim a capture we can't prove.

    // Single-chain flood-fill from (sx,sy). Lighter than findGroups for per-node use.
    function floodGroup(board, sx, sy) {
        const size = board.length;
        const color = board[sx][sy];
        const cells = [];
        const libertySet = new Set();
        const vis = new Set([`${sx},${sy}`]);
        const q = [[sx, sy]];
        while (q.length) {
            const [cx, cy] = q.shift();
            cells.push({x: cx, y: cy});
            for (const [nx, ny] of nbrs(cx, cy, size)) {
                const nc = board[nx][ny];
                if (nc === '.') libertySet.add(`${nx},${ny}`);
                else if (nc === color && !vis.has(`${nx},${ny}`)) {
                    vis.add(`${nx},${ny}`);
                    q.push([nx, ny]);
                }
            }
        }
        return { color, cells, libertySet };
    }

    // Re-locate the target group by any surviving original cell. null ⇒ captured.
    function readTargetGroup(board, targetCells, defender) {
        for (const { x, y } of targetCells)
            if (board[x][y] === defender) return floodGroup(board, x, y);
        return null;
    }

    // OR node: attacker to move, wants capture. Returns the first proven capturing move
    // {x,y}, or null if capture can't be forced within `depth`.
    function findCapturingMove(board, targetCells, attacker, defender, depth) {
        if (depth <= 0) return null;
        const g = readTargetGroup(board, targetCells, defender);
        if (!g || g.libertySet.size === 0) return null; // already resolved elsewhere
        if (g.libertySet.size >= 3) return null;         // too wide to force cheaply
        for (const lib of g.libertySet) {
            const [lx, ly] = lib.split(',').map(Number);
            const b2 = simulateMove(board, lx, ly, attacker);
            const still = readTargetGroup(b2, targetCells, defender);
            if (still) {
                // target survived this fill — reject if the attacker's own stone is now
                // self-atari suicide (illegal), otherwise recurse into defender's reply.
                const atk = floodGroup(b2, lx, ly);
                if (atk.libertySet.size === 0) continue;
            }
            if (!defenderCanEscape(b2, targetCells, attacker, defender, depth - 1))
                return { x: lx, y: ly };
        }
        return null;
    }

    function attackerCanCapture(board, targetCells, attacker, defender, depth) {
        const g = readTargetGroup(board, targetCells, defender);
        if (!g || g.libertySet.size === 0) return true;
        return findCapturingMove(board, targetCells, attacker, defender, depth) !== null;
    }

    // AND node (from attacker's view): defender to move, wants to survive.
    // Returns true if the defender can escape, false if the attacker still captures.
    function defenderCanEscape(board, targetCells, attacker, defender, depth) {
        const g = readTargetGroup(board, targetCells, defender);
        if (!g) return false;                     // already captured
        if (depth <= 0) return true;              // out of read → assume escape (safe for us)
        if (g.libertySet.size >= 3) return true;  // enough liberties → alive enough

        const size = board.length;
        const moves = new Set(g.libertySet);      // extend on own liberties
        const seenAtk = new Set();
        for (const { x, y } of g.cells) {
            for (const [nx, ny] of nbrs(x, y, size)) {
                if (board[nx][ny] !== attacker || seenAtk.has(`${nx},${ny}`)) continue;
                const ag = floodGroup(board, nx, ny);
                for (const c of ag.cells) seenAtk.add(`${c.x},${c.y}`);
                if (ag.libertySet.size === 1) moves.add([...ag.libertySet][0]); // capture it
            }
        }

        for (const mv of moves) {
            const [mx, my] = mv.split(',').map(Number);
            const b2 = simulateMove(board, mx, my, defender);
            const dGrp = readTargetGroup(b2, targetCells, defender);
            if (!dGrp || dGrp.libertySet.size === 0) continue; // move was suicide / self-capture
            if (!attackerCanCapture(b2, targetCells, attacker, defender, depth - 1))
                return true; // found a reply the attacker cannot refute
        }
        return false; // every defender reply still loses
    }

    // Convenience boolean: can `attacker` capture the chain at targetCells?
    function readCapture(board, targetCells, attacker, depth) {
        const defender = attacker === 'X' ? 'O' : 'X';
        const g = readTargetGroup(board, targetCells, defender);
        if (!g) return true;
        if (g.libertySet.size === 0) return true;
        return findCapturingMove(board, targetCells, attacker, defender, depth) !== null;
    }

    // ── Move selection ─────────────────────────────────────────────────────────

    // Total reachable empty space for a color: union flood-fill from all groups' liberties.
    // A shrinking reachable space means the position is being encircled globally.
    function reachableSpace(b, color) {
        const sz = b.length;
        const vis = Array.from({length: sz}, () => new Array(sz).fill(false));
        let count = 0;
        const q = [];
        for (let x = 0; x < sz; x++) {
            for (let y = 0; y < sz; y++) {
                if (b[x][y] !== color) continue;
                for (let dx = -1; dx <= 1; dx++) {
                    for (let dy = -1; dy <= 1; dy++) {
                        if (dx !== 0 && dy !== 0) continue;
                        const nx = x + dx, ny = y + dy;
                        if (nx < 0 || nx >= sz || ny < 0 || ny >= sz) continue;
                        if (b[nx][ny] === '.' && !vis[nx][ny]) {
                            vis[nx][ny] = true;
                            q.push([nx, ny]);
                        }
                    }
                }
            }
        }
        while (q.length) {
            const [cx, cy] = q.shift();
            count++;
            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    if (dx !== 0 && dy !== 0) continue;
                    const nx = cx + dx, ny = cy + dy;
                    if (nx < 0 || nx >= sz || ny < 0 || ny >= sz) continue;
                    if (b[nx][ny] === '.' && !vis[nx][ny]) {
                        vis[nx][ny] = true;
                        q.push([nx, ny]);
                    }
                }
            }
        }
        return count;
    }

    // Count empty regions fully enclosed by 'color' stones (neither wall nor opponent touches them).
    // Each such region is a candidate "eye" — two of them makes a group immortal.
    function countEyes(b, color) {
        const sz  = b.length;
        const opp = color === 'X' ? 'O' : 'X';
        const vis = Array.from({length: sz}, () => new Array(sz).fill(false));
        let count = 0;
        for (let x = 0; x < sz; x++) {
            for (let y = 0; y < sz; y++) {
                if (vis[x][y] || b[x][y] !== '.') continue;
                let touchesOpp = false;
                const q = [{x, y}];
                vis[x][y] = true;
                while (q.length) {
                    const {x: cx, y: cy} = q.shift();
                    for (const [nx, ny] of nbrs(cx, cy, sz)) {
                        const nc = b[nx][ny];
                        if (nc === opp) touchesOpp = true;
                        else if (nc === '.' && !vis[nx][ny]) {
                            vis[nx][ny] = true;
                            q.push({x: nx, y: ny});
                        }
                    }
                }
                if (!touchesOpp) count++;
            }
        }
        return count;
    }

    // Like countEyes but returns the actual cell arrays for each eye region.
    function findEyeCells(b, color) {
        const sz  = b.length;
        const opp = color === 'X' ? 'O' : 'X';
        const vis = Array.from({length: sz}, () => new Array(sz).fill(false));
        const eyes = [];
        for (let x = 0; x < sz; x++) {
            for (let y = 0; y < sz; y++) {
                if (vis[x][y] || b[x][y] !== '.') continue;
                let touchesOpp = false;
                const cells = [];
                const q = [{x, y}];
                vis[x][y] = true;
                while (q.length) {
                    const {x: cx, y: cy} = q.shift();
                    cells.push({x: cx, y: cy});
                    for (const [nx, ny] of nbrs(cx, cy, sz)) {
                        const nc = b[nx][ny];
                        if (nc === opp) touchesOpp = true;
                        else if (nc === '.' && !vis[nx][ny]) {
                            vis[nx][ny] = true;
                            q.push({x: nx, y: ny});
                        }
                    }
                }
                if (!touchesOpp) eyes.push(cells);
            }
        }
        return eyes;
    }

    // Vital point: the eye-region cell with the most orthogonal neighbors also inside the
    // same eye region. Kills standard nakade shapes (straight/bent 3, square/pyramid 4,
    // cross 5, etc.) in one move rather than any arbitrary cell in the region.
    function findVitalPoint(cells, size) {
        const cellSet = new Set(cells.map(c => `${c.x},${c.y}`));
        let best = null, bestCount = -1;
        for (const {x, y} of cells) {
            const internalNbrs = nbrs(x, y, size).filter(([nx, ny]) => cellSet.has(`${nx},${ny}`)).length;
            if (internalNbrs > bestCount) { bestCount = internalNbrs; best = {x, y}; }
        }
        return best;
    }

    // Returns true if (x,y) is a false eye for 'color': opponent has enough diagonal
    // control to eventually fill this point.
    // Corner/edge (0–2 real diagonals on board): false if ≥1 diagonal is enemy.
    // Interior (4 real diagonals): false if ≥2 diagonals are enemy.
    function isFalseEyePoint(b, x, y, color) {
        const sz = b.length;
        const opp = color === 'X' ? 'O' : 'X';
        let real = 0, enemy = 0;
        for (const [dx, dy] of [[-1,-1],[-1,1],[1,-1],[1,1]]) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || nx >= sz || ny < 0 || ny >= sz) continue;
            real++;
            if (b[nx][ny] === opp) enemy++;
        }
        return enemy >= (real >= 4 ? 2 : 1);
    }

    // Like countEyes but only counts genuine (non-false) eyes.
    // A region is a true eye only if every cell in it passes the diagonal test.
    function countTrueEyes(b, color) {
        const sz  = b.length;
        const opp = color === 'X' ? 'O' : 'X';
        const vis = Array.from({length: sz}, () => new Array(sz).fill(false));
        let count = 0;
        for (let x = 0; x < sz; x++) {
            for (let y = 0; y < sz; y++) {
                if (vis[x][y] || b[x][y] !== '.') continue;
                let touchesOpp = false;
                const cells = [];
                const q = [{x, y}];
                vis[x][y] = true;
                while (q.length) {
                    const {x: cx, y: cy} = q.shift();
                    cells.push({x: cx, y: cy});
                    for (const [nx, ny] of nbrs(cx, cy, sz)) {
                        const nc = b[nx][ny];
                        if (nc === opp) touchesOpp = true;
                        else if (nc === '.' && !vis[nx][ny]) {
                            vis[nx][ny] = true;
                            q.push({x: nx, y: ny});
                        }
                    }
                }
                if (touchesOpp) continue;
                if (cells.every(({x: cx, y: cy}) => !isFalseEyePoint(b, cx, cy, color)))
                    count++;
            }
        }
        return count;
    }

    // Returns true if 'group' has at least one genuine (non-false) eye adjacent to it.
    function groupHasTrueEye(b, group) {
        const sz = b.length;
        const color = group.color;
        const opp = color === 'X' ? 'O' : 'X';
        const groupSet = new Set(group.cells.map(c => `${c.x},${c.y}`));
        const vis = Array.from({length: sz}, () => new Array(sz).fill(false));
        for (let x = 0; x < sz; x++) {
            for (let y = 0; y < sz; y++) {
                if (vis[x][y] || b[x][y] !== '.') continue;
                let touchesOpp = false, touchesThisGroup = false;
                const cells = [];
                const q = [{x, y}];
                vis[x][y] = true;
                while (q.length) {
                    const {x: cx, y: cy} = q.shift();
                    cells.push({x: cx, y: cy});
                    for (const [nx, ny] of nbrs(cx, cy, sz)) {
                        const nc = b[nx][ny];
                        if      (nc === opp)    touchesOpp = true;
                        else if (nc === color && groupSet.has(`${nx},${ny}`)) touchesThisGroup = true;
                        else if (nc === '.' && !vis[nx][ny]) { vis[nx][ny] = true; q.push({x: nx, y: ny}); }
                    }
                }
                if (!touchesOpp && touchesThisGroup &&
                    cells.every(({x: cx, y: cy}) => !isFalseEyePoint(b, cx, cy, color)))
                    return true;
            }
        }
        return false;
    }

    // Count the genuine (non-false) eyes bordering exactly this group. A group with ≥2 is
    // unconditionally alive. Same flood as groupHasTrueEye but returns the tally rather than
    // short-circuiting — used by the life classifier to tell "one eye, needs a second"
    // (the dominant loss shape: a big one-eyed group killed from 3–4 libs down) apart from
    // "already alive". A shared eye region touching two of our groups counts for each.
    function countGroupTrueEyes(b, group) {
        const sz = b.length;
        const color = group.color;
        const opp = color === 'X' ? 'O' : 'X';
        const groupSet = new Set(group.cells.map(c => `${c.x},${c.y}`));
        const vis = Array.from({length: sz}, () => new Array(sz).fill(false));
        let count = 0;
        for (let x = 0; x < sz; x++) {
            for (let y = 0; y < sz; y++) {
                if (vis[x][y] || b[x][y] !== '.') continue;
                let touchesOpp = false, touchesThisGroup = false;
                const cells = [];
                const q = [{x, y}];
                vis[x][y] = true;
                while (q.length) {
                    const {x: cx, y: cy} = q.shift();
                    cells.push({x: cx, y: cy});
                    for (const [nx, ny] of nbrs(cx, cy, sz)) {
                        const nc = b[nx][ny];
                        if      (nc === opp)    touchesOpp = true;
                        else if (nc === color && groupSet.has(`${nx},${ny}`)) touchesThisGroup = true;
                        else if (nc === '.' && !vis[nx][ny]) { vis[nx][ny] = true; q.push({x: nx, y: ny}); }
                    }
                }
                if (!touchesOpp && touchesThisGroup &&
                    cells.every(({x: cx, y: cy}) => !isFalseEyePoint(b, cx, cy, color)))
                    count++;
            }
        }
        return count;
    }

    // Returns {x, y, reason} or null (caller should pass).
    function pickMove(board, validMoves, groups, baseScore, moveNum) {
        const size = board.length;

        const allMoves = [];
        const valid    = new Set();
        for (let x = 0; x < size; x++)
            for (let y = 0; y < size; y++)
                if (validMoves[x][y]) {
                    allMoves.push({x, y});
                    valid.add(`${x},${y}`);
                }

        if (!allMoves.length) return null;

        // O(1) cell→group lookup
        const cellGroup = new Map();
        for (const g of groups)
            for (const {x, y} of g.cells)
                cellGroup.set(`${x},${y}`, g);

        const adjEmpty = (x, y) =>
            nbrs(x, y, size).filter(([nx, ny]) => board[nx][ny] === '.').length;

        const adjFriendly = (x, y) =>
            nbrs(x, y, size).some(([nx, ny]) => board[nx][ny] === 'X');

        // Safe: won't be immediately recaptured
        const isSafe = (x, y) => {
            if (adjEmpty(x, y) >= 2) return true;
            for (const [nx, ny] of nbrs(x, y, size)) {
                if (board[nx][ny] !== 'X') continue;
                const g = cellGroup.get(`${nx},${ny}`);
                // After connecting: group loses (x,y) as liberty, gains adjEmpty(x,y) new ones
                if (g && g.libertySet.size - 1 + adjEmpty(x, y) >= 2) return true;
            }
            return false;
        };

        // True if playing (x,y) merges two or more distinct friendly chains
        const connectsChains = (x, y) => {
            const seen = new Set();
            for (const [nx, ny] of nbrs(x, y, size)) {
                if (board[nx][ny] !== 'X') continue;
                const g = cellGroup.get(`${nx},${ny}`);
                if (!g) continue;
                const id = `${g.cells[0].x},${g.cells[0].y}`;
                if (seen.size > 0 && !seen.has(id)) return true;
                seen.add(id);
            }
            return false;
        };

        // True if playing (x,y) would reduce a neighbor's liberty count below 2,
        // putting our own adjacent chain into atari.
        const endangersOwn = (x, y) => {
            for (const [nx, ny] of nbrs(x, y, size)) {
                if (board[nx][ny] !== 'X') continue;
                const g = cellGroup.get(`${nx},${ny}`);
                // Net liberty change: -1 for filling (x,y), +adjEmpty(x,y) for new liberties gained.
                // Only dangerous if net result leaves group at 1 liberty (atari).
                if (g && g.libertySet.size - 1 + adjEmpty(x, y) === 1) return true;
            }
            return false;
        };

        // True if a move is inside already-controlled friendly territory (scoring it gains nothing)
        const alreadyOurs = (x, y) => {
            const sim = calcScore(board);
            // A cell is "already ours" if the region it belongs to is fully enclosed by X.
            // Shortcut: check whether the base score without this move already counts this
            // empty cell as ours by comparing to a simulated board where we fill it.
            // Cheaper: flood-fill the empty region touching (x,y) — if only X borders it, skip.
            const sz = board.length;
            const vis = Array.from({length: sz}, () => new Array(sz).fill(false));
            let touchesOpp = false, touchesFriend = false;
            const q = [{x, y}];
            vis[x][y] = true;
            while (q.length) {
                const {x: cx, y: cy} = q.shift();
                for (const [nx, ny] of nbrs(cx, cy, sz)) {
                    const nc = board[nx][ny];
                    if (nc === 'O') touchesOpp = true;
                    else if (nc === 'X') touchesFriend = true;
                    else if (nc === '.' && !vis[nx][ny]) {
                        vis[nx][ny] = true;
                        q.push({x: nx, y: ny});
                    }
                }
            }
            return touchesFriend && !touchesOpp;
        };

        // True if (x,y) is inside an empty region that touches only opponent stones (no
        // friendly adjacency anywhere in the region) — a purely enemy-controlled void.
        // Exception: if a bordering opponent chain is weak (<=4 libs, all its liberties
        // confined to this region, and touched by us somewhere outside the region), the
        // region is still probeable — don't prune.
        const isDisputedTerritory = (x, y) => {
            const sz = size;
            const vis = Array.from({length: sz}, () => new Array(sz).fill(false));
            const regionCells = [];
            let touchesOwn = false;
            const borderChainKeys = new Set();
            const q = [{x, y}];
            vis[x][y] = true;
            while (q.length) {
                const {x: cx, y: cy} = q.shift();
                regionCells.push({x: cx, y: cy});
                for (const [nx, ny] of nbrs(cx, cy, sz)) {
                    const nc = board[nx][ny];
                    if (nc === 'X') touchesOwn = true;
                    else if (nc === 'O') {
                        const g = cellGroup.get(`${nx},${ny}`);
                        if (g) borderChainKeys.add(`${g.cells[0].x},${g.cells[0].y}`);
                    } else if (nc === '.' && !vis[nx][ny]) {
                        vis[nx][ny] = true;
                        q.push({x: nx, y: ny});
                    }
                }
            }
            if (touchesOwn || borderChainKeys.size === 0) return false;

            const regionSet = new Set(regionCells.map(c => `${c.x},${c.y}`));
            for (const g of groups) {
                if (g.color !== 'O') continue;
                const key = `${g.cells[0].x},${g.cells[0].y}`;
                if (!borderChainKeys.has(key)) continue;
                if (g.libertySet.size > 4) continue;
                const allLibsInside = [...g.libertySet].every(k => regionSet.has(k));
                if (!allLibsInside) continue;
                const touchedOutside = g.cells.some(({x: cx, y: cy}) =>
                    nbrs(cx, cy, sz).some(([nx, ny]) => board[nx][ny] === 'X' && !regionSet.has(`${nx},${ny}`)));
                if (touchedOutside) return false;
            }
            return true;
        };

        const oppAtari = groups.filter(g => g.color === 'O' && g.libertySet.size === 1);
        const ourAtari = groups.filter(g => g.color === 'X' && g.libertySet.size === 1);

        // Opening book: first few moves go to known strong star-point positions
        // Skip if we're in atari or can capture — tactics take priority over opening theory
        if (moveNum <= 4 && !ourAtari.length && !oppAtari.length) {
            const book = OPENINGS[size] ?? [];
            for (const [bx, by] of book) {
                if (!valid.has(`${bx},${by}`) || adjEmpty(bx, by) !== 4) continue;
                // Skip if adjacent to an opponent stone that could threaten immediately
                const adjOpp = nbrs(bx, by, size).some(([nx, ny]) => board[nx][ny] === 'O');
                if (!adjOpp)
                    return { x: bx, y: by, reason: 'opening' };
            }
        }

        // Priority 1: capture — fill the only liberty of the largest capturable group
        {
            let best = null, bestSize = 0;
            for (const g of oppAtari) {
                const lib = [...g.libertySet][0];
                if (valid.has(lib) && g.cells.length > bestSize) {
                    bestSize = g.cells.length;
                    best = lib;
                }
            }
            if (best) {
                const [x, y] = best.split(',').map(Number);
                return { x, y, reason: 'capture' };
            }
        }

        // Priority 1.5: counter-lib — one of our chains is in atari AND an opponent chain
        // adjacent to our network also has 1 liberty; capture them instead of just escaping.
        // Capturing their chain removes the threat and gains stones simultaneously.
        if (ourAtari.length) {
            const ourAtariCells = new Set(ourAtari.flatMap(g => g.cells.map(c => `${c.x},${c.y}`)));
            for (const g of oppAtari) {
                const lib = [...g.libertySet][0];
                if (!valid.has(lib)) continue;
                const [lx, ly] = lib.split(',').map(Number);
                // Check that this opponent group is actually threatening one of our atari groups
                // (i.e., adjacent to a cell in one of our at-risk chains)
                let threatsUs = false;
                for (const {x: cx, y: cy} of g.cells) {
                    for (const [nx, ny] of nbrs(cx, cy, size)) {
                        if (ourAtariCells.has(`${nx},${ny}`)) { threatsUs = true; break; }
                    }
                    if (threatsUs) break;
                }
                if (threatsUs) return { x: lx, y: ly, reason: 'counter-lib' };
            }
        }

        // ── Group life analysis (read-based defense) ─────────────────────────────
        // The dominant loss mode is mid-game group death: we lead on influence, then a
        // group with 1–2 liberties gets force-killed and 4–9 stones vanish in a couple
        // of opponent moves (the {collapse}/{wipeout} taxonomy). The 2-ply scorer can't
        // see a 3–5 move kill; the opponent AI can. So run the SAME capture reader we use
        // to attack, but symmetrically (attacker = O, defender = X): for each of our
        // not-clearly-alive groups, ask whether O can force its death.
        //  • If a move exists that makes the group un-killable (reader-verified, ≥2 libs),
        //    remember it → DEFEND (played below, before the heuristic escapes).
        //  • If NOTHING saves it, mark it dead so bridge/pre-atari/escape/save don't throw
        //    more stones after a corpse (abandon / tenuki — kills the wipeout/thrash tail).
        // Only groups with ≤2 liberties are examined: the reader can only prove captures on
        // ≤2-lib chains, and this is also the pre-collapse window the heuristics miss.
        const groupKey  = g => `${g.cells[0].x},${g.cells[0].y}`;
        const lifeDepth = Math.min(size, 10);
        const deadKeys  = new Set();
        let   defendMove = null; // {x,y} best reader-verified save (largest group first)
        {
            const atRisk = groups
                .filter(g => g.color === 'X' && g.libertySet.size <= 2)
                .sort((a, b) => b.cells.length - a.cells.length);
            for (const g of atRisk) {
                if (!readCapture(board, g.cells, 'O', lifeDepth)) continue; // safe already

                // Candidate saves: extend on our own liberties, play an adjacent empty, or
                // capture an adjacent O chain that is itself in atari (removes the attacker).
                const cand = new Set(g.libertySet);
                for (const {x: cx, y: cy} of g.cells)
                    for (const [nx, ny] of nbrs(cx, cy, size)) {
                        if (board[nx][ny] === '.') cand.add(`${nx},${ny}`);
                        else if (board[nx][ny] === 'O') {
                            const og = cellGroup.get(`${nx},${ny}`);
                            if (og && og.libertySet.size === 1) cand.add([...og.libertySet][0]);
                        }
                    }

                let bestSave = null, bestLibs = 0;
                for (const key of cand) {
                    if (!valid.has(key)) continue;
                    const [mx, my] = key.split(',').map(Number);
                    const sim = simulateMove(board, mx, my, 'X');
                    const merged = findGroups(sim).find(sg => sg.color === 'X' &&
                        sg.cells.some(c => g.cells.some(gc => gc.x === c.x && gc.y === c.y)));
                    if (!merged || merged.libertySet.size < 2) continue;          // suicide / still dying
                    if (readCapture(sim, merged.cells, 'O', lifeDepth)) continue; // O still force-kills it
                    if (merged.libertySet.size > bestLibs) { bestLibs = merged.libertySet.size; bestSave = {x: mx, y: my}; }
                }

                if (bestSave) { if (!defendMove) defendMove = bestSave; }
                else          deadKeys.add(groupKey(g)); // unsavable — abandon it
            }
        }

        // Priority 1.55: defend — reader-verified save of a group O can otherwise force-kill.
        if (defendMove) return { x: defendMove.x, y: defendMove.y, reason: 'defend' };

        // Priority 1.56: secure life — the dominant loss shape (confirmed over 3 batches by
        // the LOSS-trace diagnostics): a BIG group (≥4 stones) with <2 true eyes gets slowly
        // killed from 3–4 liberties down. That window is invisible to the ≤2-lib capture
        // reader (`defend` above fires too late) AND to `eye-build` (which refuses to run
        // unless every group is ≥3 libs and our space is ≥80% of theirs — i.e. it quits
        // exactly when we're being enclosed). The influence eval even scores the doomed
        // group as +territory until the capture lands, so the scorer wanders off. Fix: when
        // a substantial group is under contact and not yet alive, spend the move to make its
        // SECOND eye (immortalizing it) or connect it into an already-alive group — before
        // playing territory. Largest pressed group first. Conservative gates (size ≥4, libs
        // ≤4, under O contact, requires provable eye/connection progress) to avoid firing in
        // open positions and regressing the blew-lead bucket.
        {
            const aliveCells = new Set();
            for (const g of groups)
                if (g.color === 'X' && countGroupTrueEyes(board, g) >= 2)
                    for (const c of g.cells) aliveCells.add(`${c.x},${c.y}`);

            const pressed = groups.filter(g => {
                if (g.color !== 'X' || deadKeys.has(groupKey(g))) return false;
                if (g.cells.length < 4 || g.libertySet.size > 4) return false;
                if (countGroupTrueEyes(board, g) >= 2) return false;
                return [...g.libertySet].some(k => {
                    const [lx, ly] = k.split(',').map(Number);
                    return nbrs(lx, ly, size).some(([nx, ny]) => board[nx][ny] === 'O');
                });
            }).sort((a, b) => b.cells.length - a.cells.length);

            for (const g of pressed) {
                const curEyes = countGroupTrueEyes(board, g);
                const cand = new Set();
                for (const {x: cx, y: cy} of g.cells)
                    for (const [nx, ny] of nbrs(cx, cy, size))
                        if (valid.has(`${nx},${ny}`)) cand.add(`${nx},${ny}`);
                for (const lib of g.libertySet) {
                    const [lx, ly] = lib.split(',').map(Number);
                    for (const [nx, ny] of nbrs(lx, ly, size))
                        if (valid.has(`${nx},${ny}`)) cand.add(`${nx},${ny}`);
                }

                let best = null, bestScore = -1;
                for (const key of cand) {
                    const [mx, my] = key.split(',').map(Number);
                    const sim = simulateMove(board, mx, my, 'X');
                    const merged = findGroups(sim).find(sg => sg.color === 'X' &&
                        sg.cells.some(c => g.cells.some(gc => gc.x === c.x && gc.y === c.y)));
                    if (!merged || merged.libertySet.size < 2) continue;
                    // Don't play a "life" move that leaves the group still force-killable.
                    if (merged.libertySet.size <= 2 && readCapture(sim, merged.cells, 'O', lifeDepth)) continue;
                    const eyes      = countGroupTrueEyes(sim, merged);
                    const connected = merged.cells.some(c => aliveCells.has(`${c.x},${c.y}`));
                    if (!connected && eyes <= curEyes) continue; // no real life progress
                    const score = (connected ? 100 : 0) + eyes * 10 + merged.libertySet.size * 0.1;
                    if (score > bestScore) { bestScore = score; best = {x: mx, y: my}; }
                }
                if (best) return { x: best.x, y: best.y, reason: 'life' };
            }
        }

        // Priority 1.6: bridge-before-atari — a 2-lib group has a friendly chain reachable
        // within 1 move. Connect now before being forced to act under atari pressure.
        // "Urgent before big": connecting to strength is urgent, not just escaping.
        {
            const twoLib = groups.filter(g => g.color === 'X' && g.libertySet.size === 2 && !deadKeys.has(groupKey(g)));
            for (const g of twoLib) {
                for (const {x: cx, y: cy} of g.cells) {
                    for (const [nx, ny] of nbrs(cx, cy, size)) {
                        const key = `${nx},${ny}`;
                        if (!valid.has(key)) continue;
                        // Check if this move connects to a different, stable friendly chain
                        for (const [ax, ay] of nbrs(nx, ny, size)) {
                            if (board[ax][ay] !== 'X') continue;
                            const ag = cellGroup.get(`${ax},${ay}`);
                            if (!ag || ag === g) continue;
                            if (ag.libertySet.size < 3) continue;
                            // Simulate to confirm merged group survives with ≥3 libs
                            const sim = simulateMove(board, nx, ny, 'X');
                            const simGroups = findGroups(sim);
                            const merged = simGroups.find(sg => sg.color === 'X' &&
                                sg.cells.some(c => g.cells.some(gc => gc.x === c.x && gc.y === c.y)));
                            if (merged && merged.libertySet.size >= 3)
                                return { x: nx, y: ny, reason: 'bridge' };
                        }
                    }
                }
            }
        }

        // Priority 1.7: pre-atari escape — our group is about to be trapped.
        // Triggers on 2-liberty groups where any liberty is adjacent to an opponent stone.
        // Only fires if the escape survives opponent's best reply with ≥2 libs.
        {
            const threatened = groups.filter(g => {
                if (g.color !== 'X' || g.libertySet.size !== 2 || deadKeys.has(groupKey(g))) return false;
                const libs = [...g.libertySet].map(k => k.split(',').map(Number));
                return libs.some(([lx, ly]) => nbrs(lx, ly, size).some(([nx, ny]) => board[nx][ny] === 'O'));
            });
            for (const g of threatened) {
                let bestEscape = null, bestLibs = 0;
                for (const {x: cx, y: cy} of g.cells) {
                    for (const [nx, ny] of nbrs(cx, cy, size)) {
                        const key = `${nx},${ny}`;
                        if (!valid.has(key)) continue;
                        const sim = simulateMove(board, nx, ny, 'X');
                        const simGroups = findGroups(sim);
                        const merged = simGroups.find(sg => sg.color === 'X' &&
                            sg.cells.some(c => g.cells.some(gc => gc.x === c.x && gc.y === c.y)));
                        const newLibs = merged ? merged.libertySet.size : 0;
                        if (newLibs > bestLibs) { bestLibs = newLibs; bestEscape = {x: nx, y: ny}; }
                    }
                }
                // Require escape survives opponent's best reply with ≥2 libs to avoid herd-loop
                if (bestEscape && bestLibs >= 2) {
                    const escSim = simulateMove(board, bestEscape.x, bestEscape.y, 'X');
                    const { board: oppReply } = opponentBestResponse(escSim);
                    const postGroups = findGroups(oppReply);
                    const postMerged = postGroups.find(sg => sg.color === 'X' &&
                        sg.cells.some(c => g.cells.some(gc => gc.x === c.x && gc.y === c.y)));
                    if (postMerged && postMerged.libertySet.size >= 2)
                        return { x: bestEscape.x, y: bestEscape.y, reason: 'pre-atari' };
                }
            }
        }

        // Priority 1.8: encirclement escape — group has 3-4 liberties but they're in a small
        // enclosed pocket (≤6 reachable empty cells). Find a move that expands the pocket.
        {
            const pocketSize = (b, g) => {
                const sz = b.length;
                const vis = Array.from({length: sz}, () => new Array(sz).fill(false));
                let count = 0;
                const q = [];
                for (const lib of g.libertySet) {
                    const [lx, ly] = lib.split(',').map(Number);
                    if (!vis[lx][ly]) { vis[lx][ly] = true; q.push([lx, ly]); }
                }
                while (q.length) {
                    const [cx, cy] = q.shift();
                    count++;
                    for (const [nx, ny] of nbrs(cx, cy, sz)) {
                        if (!vis[nx][ny] && b[nx][ny] === '.') {
                            vis[nx][ny] = true;
                            q.push([nx, ny]);
                        }
                    }
                }
                return count;
            };

            for (const g of groups) {
                if (g.color !== 'X' || deadKeys.has(groupKey(g))) continue;
                if (g.libertySet.size < 3 || g.libertySet.size > 4) continue;
                if (pocketSize(board, g) > 8) continue;

                let bestEscape = null, bestPocket = pocketSize(board, g);
                // Candidates: moves adjacent to group cells OR adjacent to liberties
                const escapeCandidates = new Set();
                for (const {x: cx, y: cy} of g.cells)
                    for (const [nx, ny] of nbrs(cx, cy, size))
                        if (valid.has(`${nx},${ny}`)) escapeCandidates.add(`${nx},${ny}`);
                for (const lib of g.libertySet) {
                    const [lx, ly] = lib.split(',').map(Number);
                    for (const [nx, ny] of nbrs(lx, ly, size))
                        if (valid.has(`${nx},${ny}`)) escapeCandidates.add(`${nx},${ny}`);
                }
                for (const key of escapeCandidates) {
                    const [nx, ny] = key.split(',').map(Number);
                    const sim = simulateMove(board, nx, ny, 'X');
                    const simGroups = findGroups(sim);
                    const merged = simGroups.find(sg => sg.color === 'X' &&
                        sg.cells.some(c => g.cells.some(gc => gc.x === c.x && gc.y === c.y)));
                    if (!merged || merged.libertySet.size < 2) continue;
                    const pocket = pocketSize(sim, merged);
                    if (pocket > bestPocket) { bestPocket = pocket; bestEscape = {x: nx, y: ny}; }
                }
                if (bestEscape) return { x: bestEscape.x, y: bestEscape.y, reason: 'escape' };
            }
        }

        // Priority 2: save — fill last liberty if safe; otherwise bridge to a stable chain
        {
            let best = null, bestSize = 0;
            for (const g of ourAtari) {
                if (g.cells.length <= bestSize || deadKeys.has(groupKey(g))) continue;

                const lib = [...g.libertySet][0];
                const [lx, ly] = lib.split(',').map(Number);
                if (valid.has(lib) && isSafe(lx, ly)) {
                    bestSize = g.cells.length;
                    best = `${lx},${ly}`;
                    continue;
                }

                outer: for (const {x: cx, y: cy} of g.cells) {
                    for (const [nx, ny] of nbrs(cx, cy, size)) {
                        if (board[nx][ny] !== '.') continue;
                        const key = `${nx},${ny}`;
                        if (!valid.has(key)) continue;
                        for (const [ax, ay] of nbrs(nx, ny, size)) {
                            if (board[ax][ay] !== 'X') continue;
                            const ag = cellGroup.get(`${ax},${ay}`);
                            if (!ag || ag === g) continue;
                            if (ag.libertySet.size >= 2) {
                                bestSize = g.cells.length;
                                best = key;
                                break outer;
                            }
                        }
                    }
                }
            }
            if (best) {
                const [x, y] = best.split(',').map(Number);
                return { x, y, reason: 'save' };
            }

            // Unsafe save: only worthwhile if the merged group survives with ≥2 libs
            for (const g of ourAtari) {
                if (deadKeys.has(groupKey(g))) continue;
                const lib = [...g.libertySet][0];
                if (!valid.has(lib)) continue;
                const [x, y] = lib.split(',').map(Number);
                const sim = simulateMove(board, x, y, 'X');
                const simGroups = findGroups(sim);
                const merged = simGroups.find(sg => sg.color === 'X' &&
                    sg.cells.some(c => g.cells.some(gc => gc.x === c.x && gc.y === c.y)));
                if (merged && merged.libertySet.size >= 2)
                    return { x, y, reason: 'save-risky' };
            }
        }

        // Baseline reachable space — computed once, used by eye-build gate, expand gate, and scorer
        const baseReachUs  = reachableSpace(board, 'X');
        const baseReachOpp = reachableSpace(board, 'O');

        // Priority 3: eye-building — only when all groups stable (≥3 libs), we have enough
        // global space, AND at least one of our groups still lacks a true eye (don't waste
        // moves building a 3rd eye for an already-alive group).
        {
            const ourGroups = groups.filter(g => g.color === 'X');
            const allStable = ourGroups.every(g => g.libertySet.size >= 3);
            const spaceOk   = baseReachOpp === 0 || baseReachUs >= baseReachOpp * 0.80;
            const needsEye  = ourGroups.some(g => !groupHasTrueEye(board, g));
            if (allStable && spaceOk && needsEye) {
                const baseEyes = countTrueEyes(board, 'X');
                for (const {x, y} of allMoves) {
                    if (nbrs(x, y, size).some(([nx, ny]) => board[nx][ny] === 'O')) continue;
                    const sim = simulateMove(board, x, y, 'X');
                    if (countTrueEyes(sim, 'X') > baseEyes)
                        return { x, y, reason: 'eye-build' };
                }
            }
        }

        // Priority 3.5: anti-eye — if opponent has exactly 1 enclosed eye region of ≤4 cells, play into it
        // Size gate prevents wasting multiple turns repeatedly shrinking a large eye while groups die
        // Atari gate: don't play anti-eye while any of our groups is in atari
        // (Nakade vital-point retarget + gate widen 4->6 disabled for bisection — see project memory.
        // Reverted to Session-2 behavior: any cell in a <=4-cell eye region.)
        {
            const oppEyes = findEyeCells(board, 'O');
            if (!ourAtari.length && oppEyes.length === 1 && oppEyes[0].length <= 4) {
                for (const {x, y} of oppEyes[0]) {
                    if (valid.has(`${x},${y}`) && isSafe(x, y))
                        return { x, y, reason: 'anti-eye' };
                }
            }
        }

        // Priority 4a: read-kill — proven forced capture via the capture-race reader.
        // Generalizes ladder/nakade/smother into one sound primitive: for each opponent
        // group with ≤3 liberties (largest first), ask the reader whether we can force its
        // capture under best mutual play. If so, play the proven first move of that kill.
        // This is the correct version of the Session-3 "ladder-read smother" experiment —
        // full AND-OR search instead of branching-1 ladderWorks. Because it only ACTS on a
        // proven capture and otherwise falls through to the unchanged smother below, it is a
        // strict superset of Session-2 behavior (low regression risk).
        {
            const readDepth = Math.min(size, 10);
            const targets = groups
                .filter(g => g.color === 'O' && g.libertySet.size <= 3 && g.libertySet.size >= 1)
                .sort((a, b) => b.cells.length - a.cells.length);
            for (const g of targets) {
                const mv = findCapturingMove(board, g.cells, 'X', 'O', readDepth);
                if (mv && valid.has(`${mv.x},${mv.y}`) && isSafe(mv.x, mv.y))
                    return { x: mv.x, y: mv.y, reason: 'read-kill' };
            }
        }

        // Priority 4: smother — reduce the largest opponent group from 2 liberties to 1.
        // Reverted to Session-2 behavior: any safe reduction is accepted. (Kept as the
        // fallback below read-kill: applies pressure even when a kill can't be proven.)
        {
            const targets = groups.filter(g => g.color === 'O' && g.libertySet.size === 2);
            let best = null, bestSize = 0;
            for (const g of targets) {
                for (const lib of g.libertySet) {
                    if (!valid.has(lib)) continue;
                    const [lx, ly] = lib.split(',').map(Number);
                    if (!isSafe(lx, ly)) continue;
                    if (g.cells.length > bestSize) {
                        bestSize = g.cells.length;
                        best = `${lx},${ly}`;
                    }
                }
            }
            if (best) {
                const [x, y] = best.split(',').map(Number);
                return { x, y, reason: 'smother' };
            }
        }

        // Priority 4.5: weak group gate — if ≥2 of our groups have 0 true eyes and ≤4 liberties, the position
        // is structurally endangered. Skip territory scoring entirely — consolidate first.
        // The best consolidation move is whichever reduces the weak-group count the most
        // (by connecting groups or expanding their pockets).
        {
            const weakGroups = groups.filter(g =>
                g.color === 'X' && g.libertySet.size <= 4 && !groupHasTrueEye(board, g)
            );
            if (weakGroups.length >= 2) {
                let bestMove = null, bestResult = weakGroups.length;
                for (const {x, y} of allMoves) {
                    const sim = simulateMove(board, x, y, 'X');
                    const simGroups = findGroups(sim);
                    // Reject if any of our groups would be captured
                    if (simGroups.filter(g => g.color === 'X').some(g => g.libertySet.size === 0)) continue;
                    const stillWeak = simGroups.filter(g =>
                        g.color === 'X' && g.libertySet.size <= 4 && !groupHasTrueEye(sim, g)
                    ).length;
                    if (stillWeak < bestResult) {
                        bestResult = stillWeak;
                        bestMove = {x, y};
                    }
                }
                if (bestMove) return { x: bestMove.x, y: bestMove.y, reason: 'consolidate' };
            }
        }

        // Pre-filter alreadyOurs once here — reused by fallback below
        const currentAtariPenalty = groups.filter(g => g.color === 'X' && g.libertySet.size === 1).length * 15.0;
        const scorerMoves = allMoves.filter(({x, y}) => !alreadyOurs(x, y)); // isDisputedTerritory disabled for bisection — see project memory

        // Space ratio gate: if we're being encircled (our space < 70% of opponent's)
        // and past the opening, bypass the scorer and find the move that most expands
        // our reachable space — confirmed to still be good after opponent replies.
        if (moveNum > 6 && baseReachUs < baseReachOpp * 0.70 && baseReachOpp > 0) {
            let bestExpand = null, bestSpace = baseReachUs;
            for (const {x, y} of scorerMoves) {
                const sim = simulateMove(board, x, y, 'X');
                const simGroups = findGroups(sim);
                if (simGroups.filter(g => g.color === 'X').some(g => g.libertySet.size === 0)) continue;
                const { board: replied } = opponentBestResponse(sim);
                const space = reachableSpace(replied, 'X');
                if (space > bestSpace) { bestSpace = space; bestExpand = {x, y}; }
            }
            if (bestExpand) return { x: bestExpand.x, y: bestExpand.y, reason: 'expand' };
        }

        {
            let bestMove  = null;
            let bestScore = -Infinity;

            // Base territorial term uses the influence estimate, not calcScore: calcScore's
            // (black-white) delta is ~0 for almost every midgame move (nothing sealed yet),
            // leaving the scorer blind on territory. Influence gives a smooth per-move
            // gradient. Computed once for the current board; each candidate is compared to it.
            const baseInf = influenceScore(board);

            for (const {x, y} of scorerMoves) {
                const sim                  = simulateMove(board, x, y, 'X');
                const { board: respBoard } = opponentBestResponse(sim);
                const respInf              = influenceScore(respBoard);
                let score   = (respInf.black - respInf.white) - (baseInf.black - baseInf.white);

                if (connectsChains(x, y))  score += 3.0;
                if (adjFriendly(x, y))     score += 0.5;
                if (endangersOwn(x, y))    score -= 2.0;

                // Cut bonus: move separates two distinct opponent chains (vital point)
                {
                    const oppNeighbors = new Set();
                    for (const [nx, ny] of nbrs(x, y, size)) {
                        if (board[nx][ny] !== 'O') continue;
                        const og = cellGroup.get(`${nx},${ny}`);
                        if (og) oppNeighbors.add(`${og.cells[0].x},${og.cells[0].y}`);
                    }
                    if (oppNeighbors.size >= 2) score += 2.0;
                }

                // Corner/edge efficiency: stones in corners and on edges secure more territory
                // per stone than center stones (validated by primer and AI play)
                const onEdge = x === 0 || x === size - 1 || y === 0 || y === size - 1;
                const inCorner = (x <= 1 || x >= size - 2) && (y <= 1 || y >= size - 2);
                if (inCorner) score += 1.0;
                else if (onEdge) score += 0.5;

                // Sente preference: if opponent's best reply is adjacent to our move,
                // they were forced to respond locally — we kept the initiative.
                // (Forced-sente upgrade via opponentBestNonLocalResponse disabled for
                // bisection — see project memory. Flat bonus restored to isolate effect.)
                {
                    let opponentRepliedLocally = false;
                    for (const [nx, ny] of nbrs(x, y, size)) {
                        if (respBoard[nx]?.[ny] === 'O' && board[nx][ny] === '.') {
                            opponentRepliedLocally = true;
                            break;
                        }
                    }
                    if (!opponentRepliedLocally) score += 0.5;
                }

                // Penalise moves that leave our groups in danger after opponent replies
                const respGroups = findGroups(respBoard);
                const atariCount = respGroups.filter(g => g.color === 'X' && g.libertySet.size === 1).length;
                score -= atariCount * 15.0;
                const nearAtariCount = respGroups.filter(g => g.color === 'X' && g.libertySet.size === 2).length;
                score -= nearAtariCount * 6.0;
                // Also penalise any groups already in atari before we even move
                score -= currentAtariPenalty;
                // Penalise fragmentation: many small isolated groups are easy prey
                const ourGroups = respGroups.filter(g => g.color === 'X');
                const smallIsolated = ourGroups.filter(g => g.cells.length <= 2 && g.libertySet.size <= 2).length;
                score -= smallIsolated * 1.5;

                // Whole-board encirclement penalty: if after our move + opponent reply our
                // reachable space shrinks while theirs grows, we're being enclosed globally.
                const respReachUs  = reachableSpace(respBoard, 'X');
                const respReachOpp = reachableSpace(respBoard, 'O');
                const spaceDelta = (respReachUs - baseReachUs) - (respReachOpp - baseReachOpp);
                if (spaceDelta < -2) score -= (Math.abs(spaceDelta) - 2) * 1.0;

                for (const [nx, ny] of nbrs(x, y, size)) {
                    if (board[nx][ny] !== 'X') continue;
                    const g = cellGroup.get(`${nx},${ny}`);
                    if (g && g.libertySet.size <= 3) { score += 1.0; break; }
                }

                if (score > bestScore) {
                    bestScore = score;
                    bestMove  = { x, y, reason: 'scored' };
                }
            }

            if (bestMove) return bestMove;
        }

        // Fallback: never fill own enclosed territory or endanger own groups — pass instead
        const contestedMoves = scorerMoves.filter(({x, y}) => !endangersOwn(x, y));
        if (!contestedMoves.length) return null;
        const safeMove = contestedMoves.find(({x, y}) => isSafe(x, y));
        return { ...(safeMove ?? contestedMoves[0]), reason: 'fallback' };
    }

    // ── Game loop ──────────────────────────────────────────────────────────────

    ns.print(`[ipvgo] start — ${OPPONENT} ${BOARD_SIZE}×${BOARD_SIZE} komi=${komi}`);

    let gameNum = 0, wins = 0, losses = 0, streak = 0;
    const REPORT_EVERY = 5;
    const gameLog = [];

    while (true) {
        gameNum++;
        ns.print(`[ipvgo] === game ${gameNum} (W:${wins} L:${losses}) ===`);

        try {
            ns.go.resetBoardState(OPPONENT, BOARD_SIZE);
            await ns.sleep(200);

            let moveNum = 0;
            const reasonCounts = {};
            let prevBlackCount = 0;
            let loggedFirstAtari = false;
            let loggedFirstCapture = false;

            // ── Loss diagnostics (buffered; only emitted if the game is lost) ──
            const moveTrace   = [];      // [{m, reason, x, y, infLead}] one entry per move we make
            let   peakLead    = -Infinity, peakLeadMove = 0; // best influence-lead & when it occurred
            let   lastAheadMove = 0;     // last move number at which our influence-lead was > 0
            const boardRing   = [];      // rolling window of recent boards for pre-collapse snapshot
            const RING_SIZE   = 4;
            let   collapseSnapshot = null; // board ~RING_SIZE moves before black-count first crashed
            let   maxBlackCount = 0;       // peak stone count, to detect a "crash" (mass capture)

            while (true) {
                const state = ns.go.getGameState();
                if (state.currentPlayer === 'None') break;

                const board      = ns.go.getBoardState();
                const validMoves = await ns.go.analysis.getValidMoves();
                const groups     = findGroups(board);
                const score      = calcScore(board);
                const lead       = score.black - score.white;

                const ourAtari = groups.filter(g => g.color === 'X' && g.libertySet.size === 1);
                const oppAtari = groups.filter(g => g.color === 'O' && g.libertySet.size === 1);

                // Log board the first time we go into atari
                if (!loggedFirstAtari && ourAtari.length) {
                    loggedFirstAtari = true;
                    tprint(`[ipvgo] ATARI G${gameNum} m${moveNum}: ${board.join('|')}`);
                }
                // Log board the first time we lose stones (black count drops)
                const blackCount = groups.filter(g => g.color === 'X').reduce((n, g) => n + g.cells.length, 0);
                if (!loggedFirstCapture && moveNum > 0 && blackCount < prevBlackCount) {
                    loggedFirstCapture = true;
                    tprint(`[ipvgo] CAPTURE G${gameNum} m${moveNum}: ${board.join('|')}`);
                }
                prevBlackCount = blackCount;

                // Influence-lead — computed unconditionally (gameplay depends on it now, not
                // just LOG_LOSS_TRACE diagnostics). calcScore's `lead` reads ~0 until territory
                // is fully sealed (nothing sealed yet in midgame), so anything gated on it either
                // fires far too late or — worse — once close-to-sealed, makes "is there still a
                // gain available" comparisons of near-zero calcScore deltas falsely read "no",
                // passing away an open position. influenceScore gives an honest running estimate
                // throughout, matching what the move-scorer itself already optimizes.
                const inf     = influenceScore(board);
                const infLead = inf.black - inf.white;

                // ── Loss diagnostics: influence-lead trajectory + pre-collapse snapshot ──
                // Buffered here; only printed later if the game is lost.
                if (LOG_LOSS_TRACE) {
                    if (infLead > peakLead) { peakLead = infLead; peakLeadMove = moveNum; }
                    if (infLead > 0) lastAheadMove = moveNum;

                    boardRing.push(board.join('|'));
                    if (boardRing.length > RING_SIZE) boardRing.shift();
                    // Detect a stone-count crash (mass capture) — snapshot the board from
                    // ~RING_SIZE moves earlier, i.e. where the losing decision was made.
                    if (blackCount > maxBlackCount) maxBlackCount = blackCount;
                    if (!collapseSnapshot && maxBlackCount >= 4 && blackCount <= maxBlackCount - 4)
                        collapseSnapshot = { m: moveNum, prevM: moveNum - boardRing.length + 1,
                                             board: boardRing[0], lost: maxBlackCount - blackCount };
                }

                // Pass when comfortably ahead with no threats — gated on infLead (see above),
                // not calcScore's lead.
                if (infLead > komi + PASS_MARGIN && !ourAtari.length && !oppAtari.length) {
                    // Any lead > komi+5: pass unconditionally — scanning every move for +2
                    // gains is slow and causes pass-loops when lead hovers near the threshold
                    const bigLead = infLead > komi + 5;
                    const hasGain = !bigLead && board.some((col, x) =>
                        col.split('').some((_, y) => {
                            if (!validMoves[x][y]) return false;
                            const { board: replied } = opponentBestResponse(simulateMove(board, x, y, 'X'));
                            const infS = influenceScore(replied);
                            return (infS.black - infS.white) > infLead + 2;
                        })
                    );
                    if (!hasGain) {
                        ns.print(`[ipvgo] pass — infLead ${infLead.toFixed(1)} > ${komi + PASS_MARGIN}${bigLead ? ' (big lead)' : ''}`);
                        const res = await ns.go.passTurn();
                        if (res.type === 'gameOver') break;
                        continue;
                    }
                }

                moveNum++;
                const move = pickMove(board, validMoves, groups, score, moveNum);

                if (DEBUG_ONE_GAME) {
                    const boardStr = board.map((col, x) => col.split('').map((c, y) =>
                        (move && x === move.x && y === move.y) ? '*' : c
                    ).join('')).join('|');
                    tprint(`[ipvgo] m${moveNum} lead=${lead.toFixed(1)} [${move ? move.reason : 'pass'}]: ${boardStr}`);
                }

                if (!move) {
                    ns.print(`[ipvgo] pass (no valid moves)`);
                    const res = await ns.go.passTurn();
                    if (res.type === 'gameOver') break;
                    continue;
                }

                reasonCounts[move.reason] = (reasonCounts[move.reason] ?? 0) + 1;
                if (LOG_LOSS_TRACE)
                    moveTrace.push({ m: moveNum, reason: move.reason, x: move.x, y: move.y, infLead });
                ns.print(`[ipvgo] ${move.x},${move.y} [${move.reason}] lead=${lead.toFixed(1)}`);
                const res = await ns.go.makeMove(move.x, move.y);
                if (res.type === 'gameOver') break;

                await ns.sleep(200);
            }

            const fs     = ns.go.getGameState();
            const ours   = fs.blackScore ?? 0;
            const theirs = fs.whiteScore ?? 0;
            const summ   = `us:${ours.toFixed(1)} them:${theirs.toFixed(1)} (W:${wins} L:${losses})`;

            if (ours > theirs) {
                wins++;
                streak = streak > 0 ? streak + 1 : 1;
                ns.print(`[ipvgo] WIN  ${summ}`);
                if (streak % 5 === 0) tprint(`[ipvgo] ${streak}-win streak — ${summ}`);
            } else if (theirs > ours) {
                losses++;
                streak = streak < 0 ? streak - 1 : -1;
                ns.print(`[ipvgo] LOSS ${summ}`);
                if (Math.abs(streak) % 5 === 0) tprint(`[ipvgo] ${Math.abs(streak)}-loss streak — ${summ}`);
                const board = ns.go.getBoardState();
                tprint(`[ipvgo] LOSS board G${gameNum}: ${board.join('|')}`);

                // ── Loss diagnostics dump (only on losses; keeps wins silent) ──
                if (LOG_LOSS_TRACE) {
                    // Trajectory classifies the loss: "never ahead" = strategic/opening
                    // problem; "led then lost it" = blown position (endgame/pass/collapse).
                    const peakStr = peakLead > -Infinity ? peakLead.toFixed(1) : 'n/a';
                    const traj = peakLead <= 0
                        ? `NEVER AHEAD (peak infLead ${peakStr})`
                        : `led +${peakStr}@m${peakLeadMove}, last ahead @m${lastAheadMove}/${moveNum}`;
                    tprint(`[ipvgo] LOSS-traj G${gameNum}: ${traj}`);

                    if (collapseSnapshot)
                        tprint(`[ipvgo] LOSS-collapse G${gameNum}: lost ${collapseSnapshot.lost} stones by m${collapseSnapshot.m}, board ~m${collapseSnapshot.prevM}: ${collapseSnapshot.board}`);

                    const traceStr = moveTrace
                        .map(t => `${t.m}:${t.reason}(${t.x},${t.y})${t.infLead >= 0 ? '+' : ''}${t.infLead.toFixed(0)}`)
                        .join(' ');
                    tprint(`[ipvgo] LOSS-trace G${gameNum}: ${traceStr}`);
                }
            } else {
                streak = 0;
                ns.print(`[ipvgo] TIE  ${summ}`);
            }

            // Classify losses for the taxonomy tally (uses the buffered diagnostics).
            // Priority order matters: wipeout > collapse > thrash > coinflip > blew-lead > never-ahead.
            let lossType = null;
            if (theirs > ours) {
                const m = ours - theirs;
                if      (ours === 0)             lossType = 'wipeout';
                else if (collapseSnapshot)       lossType = 'collapse';
                else if (moveNum > 40)           lossType = 'thrash';
                else if (m >= -3.5)              lossType = 'coinflip';
                else if (peakLead > 0)           lossType = 'blew-lead';
                else                             lossType = 'never-ahead';
            }

            gameLog.push({
                game: gameNum,
                result: ours > theirs ? 'W' : theirs > ours ? 'L' : 'T',
                ours: ours.toFixed(1),
                theirs: theirs.toFixed(1),
                margin: (ours - theirs).toFixed(1),
                moves: moveNum,
                reasons: {...reasonCounts},
                lossType,
            });

            if (gameNum % REPORT_EVERY === 0) {
                const slice = gameLog.slice(-REPORT_EVERY);
                const wc = slice.filter(g => g.result === 'W').length;
                tprint(`\n[ipvgo] ── Report: games ${gameNum - REPORT_EVERY + 1}–${gameNum} (${wc}/${REPORT_EVERY} wins) ──`);
                for (const g of slice) {
                    const rc = Object.entries(g.reasons).map(([k, v]) => `${k}:${v}`).join(' ');
                    const lt = g.lossType ? ` {${g.lossType}}` : '';
                    tprint(`  G${g.game} ${g.result} us:${g.ours} them:${g.theirs} (+${g.margin}) moves:${g.moves}${lt} [${rc}]`);
                }
                // Cumulative loss taxonomy across all games so far — the decisive readout.
                const tally = {};
                for (const g of gameLog) if (g.lossType) tally[g.lossType] = (tally[g.lossType] ?? 0) + 1;
                const totW = gameLog.filter(g => g.result === 'W').length;
                const taxStr = Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' ');
                tprint(`  [cum] ${totW}/${gameLog.length} wins | losses: ${taxStr || 'none'}`);
            }

            if (DEBUG_ONE_GAME) {
                tprint(`[ipvgo] DEBUG_ONE_GAME: exiting after game ${gameNum}`);
                break;
            }

        } catch (err) {
            tprint(`[ipvgo] ERROR game ${gameNum}: ${err}`);
            await ns.sleep(2000);
        }

        await ns.sleep(1000);
    }
}
