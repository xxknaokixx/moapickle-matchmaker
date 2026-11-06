/*
 * 組み合わせを決める部分（画面に依存しない）。
 *
 * - 休憩は「ここまでに出た試合数が多い人」から順に回す（人数が変わらない日は、休憩回数が全員±1に収まる）
 * - 固定ペアは試合も休憩も2人セット
 * - 同じペア・同じ対戦相手の重複が少なくなる組み合わせを、乱数で探して選ぶ
 */
(function (root) {
  'use strict';

  const key = (a, b) => (a < b ? a + '-' + b : b + '-' + a);
  const inc = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;

  function shuffle(arr, rnd) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // 過去のラウンドから、ペア・対戦・試合数・休憩数を数える
  function tally(rounds) {
    const partner = new Map();
    const opp = new Map();
    const games = new Map();
    const rests = new Map();
    for (const r of rounds) {
      for (const g of r.games) {
        const t1 = g[0];
        const t2 = g[1];
        inc(partner, key(t1[0], t1[1]));
        inc(partner, key(t2[0], t2[1]));
        for (const a of t1) for (const b of t2) inc(opp, key(a, b));
        for (const n of t1) inc(games, n);
        for (const n of t2) inc(games, n);
      }
      for (const n of r.resting) inc(rests, n);
    }
    return { partner, opp, games, rests };
  }

  const W_PARTNER = 3; // 同じ相手と組む重さ
  const W_OPP = 1; // 同じ相手と対戦する重さ

  function makeCost(t) {
    const pen = (c) => c * c;
    return function cost(teams) {
      let c = 0;
      for (const team of teams) c += W_PARTNER * pen(t.partner.get(key(team[0], team[1])) || 0);
      for (let i = 0; i + 1 < teams.length; i += 2) {
        for (const a of teams[i]) for (const b of teams[i + 1]) c += W_OPP * pen(t.opp.get(key(a, b)) || 0);
      }
      return c;
    };
  }

  /**
   * ラウンドを1つ作る。
   * @param {object} o
   * @param {number[]} o.players  参加中の番号
   * @param {number[][]} o.pairs  固定ペア（両方が players にいるものだけ有効）
   * @param {number} o.courts     使えるコート数
   * @param {object[]} o.history  これまでのラウンド（{games, resting}）
   * @param {function} [o.rnd]    乱数（テスト用）
   * @returns {{games:number[][][][], resting:number[], cost:number}|null}
   */
  function buildRound(o) {
    const rnd = o.rnd || Math.random;
    const history = o.history || [];
    const players = o.players.slice();
    const N = players.length;
    const usable = Math.min(o.courts, Math.floor(N / 4));
    if (usable < 1) return null;
    const restCount = N - usable * 4;

    const t = tally(history);
    const cost = makeCost(t);
    const lastRest = new Set(history.length ? history[history.length - 1].resting : []);

    // 固定ペアを1つの単位にする
    const partnerOf = new Map();
    for (const p of o.pairs || []) {
      if (players.includes(p[0]) && players.includes(p[1]) && !partnerOf.has(p[0]) && !partnerOf.has(p[1])) {
        partnerOf.set(p[0], p[1]);
        partnerOf.set(p[1], p[0]);
      }
    }
    const seen = new Set();
    const units = [];
    for (const n of players) {
      if (seen.has(n)) continue;
      const q = partnerOf.get(n);
      seen.add(n);
      if (q !== undefined) {
        seen.add(q);
        units.push({ members: [n, q], fixed: true });
      } else {
        units.push({ members: [n], fixed: false });
      }
    }

    // 休憩に回す優先順: 試合数が多い → 休憩回数が少ない → 前回休憩していない → 乱数
    for (const u of units) {
      u.g = mean(u.members.map((n) => t.games.get(n) || 0));
      u.r = mean(u.members.map((n) => t.rests.get(n) || 0));
      u.l = u.members.some((n) => lastRest.has(n)) ? 1 : 0;
      u.x = rnd();
    }
    units.sort((a, b) => b.g - a.g || a.r - b.r || a.l - b.l || a.x - b.x);

    // 休憩人数ぴったりになるように選ぶ（固定ペアは2人分）
    let need = restCount;
    const resting = [];
    let playUnits = [];
    for (const u of units) {
      if (need >= u.members.length) {
        resting.push(...u.members);
        need -= u.members.length;
      } else {
        playUnits.push(u);
      }
    }
    // 念のため: ぴったりにならなかったときは、固定ペアを解いて調整する
    while (need > 0 && playUnits.length) {
      const u = playUnits.shift();
      if (u.members.length <= need) {
        resting.push(...u.members);
        need -= u.members.length;
      } else {
        resting.push(u.members[0]);
        need -= 1;
        playUnits.unshift({ members: [u.members[1]], fixed: false });
      }
    }

    const fixedTeams = playUnits.filter((u) => u.fixed).map((u) => u.members.slice());
    const singles = playUnits.filter((u) => !u.fixed).map((u) => u.members[0]);
    const nFixed = fixedTeams.length;

    let best = null;
    let bestCost = Infinity;
    const attempts = o.attempts || 40;
    const climbSteps = o.climbSteps || 250;

    for (let k = 0; k < attempts && bestCost > 0; k++) {
      shuffle(singles, rnd);
      const teams = fixedTeams.map((x) => x.slice());
      for (let i = 0; i + 1 < singles.length; i += 2) teams.push([singles[i], singles[i + 1]]);
      // 固定ペアかどうかは、配列の位置ではなくオブジェクトで追う
      const fixedSet = new Set(teams.slice(0, nFixed));
      shuffle(teams, rnd);

      let cur = cost(teams);
      for (let s = 0; s < climbSteps && cur > 0; s++) {
        if (rnd() < 0.5) {
          // 2チームの位置（対戦の組み合わせ）を入れ替える
          const i = Math.floor(rnd() * teams.length);
          const j = Math.floor(rnd() * teams.length);
          if (i === j) continue;
          [teams[i], teams[j]] = [teams[j], teams[i]];
          const c = cost(teams);
          if (c <= cur) cur = c;
          else [teams[i], teams[j]] = [teams[j], teams[i]];
        } else {
          // 固定ペアでない2人を入れ替える（ペアの組み替え）
          const i = Math.floor(rnd() * teams.length);
          const j = Math.floor(rnd() * teams.length);
          if (i === j || fixedSet.has(teams[i]) || fixedSet.has(teams[j])) continue;
          const a = Math.floor(rnd() * 2);
          const b = Math.floor(rnd() * 2);
          const tmp = teams[i][a];
          teams[i][a] = teams[j][b];
          teams[j][b] = tmp;
          const c = cost(teams);
          if (c <= cur) cur = c;
          else {
            const tmp2 = teams[i][a];
            teams[i][a] = teams[j][b];
            teams[j][b] = tmp2;
          }
        }
      }
      if (cur < bestCost) {
        bestCost = cur;
        best = teams.map((x) => x.slice());
      }
    }

    const games = [];
    for (let i = 0; i + 1 < best.length; i += 2) {
      games.push([best[i].slice().sort((a, b) => a - b), best[i + 1].slice().sort((a, b) => a - b)]);
    }
    resting.sort((a, b) => a - b);
    return { games, resting, cost: bestCost };
  }

  const api = { buildRound, tally, shuffle };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Matcher = api;
})(typeof window !== 'undefined' ? window : globalThis);
