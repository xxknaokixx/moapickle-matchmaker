/*
 * 練習会の状態を扱う部分（画面に依存しない）。
 *
 * - 参加者は「内部ID(uid)」で管理する。番号(no)は表示用なので、番号を変えたり、削除した番号を別の人が使っても、
 *   過去のラウンドの記録（試合数・休憩・ペア）が混ざらない
 * - 保存データは読み込むたびに検査して整える（壊れた項目は捨てる）
 * - 「名前のまとめ」は、差分（追加・解除）を溜めて送る
 */
(function (root) {
  'use strict';

  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const isStr = (x) => typeof x === 'string';
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const DATE_RE = /^\d{4}-\d{2}-\d{2}/;

  /* ---------- 名前のまとめ（別名） ---------- */
  // 'constructor' や '__proto__' という名前でも壊れないように、プロトタイプのない入れ物にする
  function mkAliases(obj) {
    const o = Object.create(null);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      for (const k of Object.keys(obj)) {
        if (isStr(obj[k]) && k && k !== obj[k]) o[k] = obj[k];
      }
    }
    return o;
  }
  function resolveName(aliases, n) {
    let k = 0;
    while (hasOwn(aliases, n) && k++ < 10) n = aliases[n];
    return n;
  }
  const emptyPending = () => ({ set: mkAliases(), del: [] });
  function aliasSet(st, from, to) {
    if (!from || !to || from === to || resolveName(st.aliases, to) === from) return false;
    st.aliases[from] = to;
    st.aliasPending.set[from] = to;
    st.aliasPending.del = st.aliasPending.del.filter((x) => x !== from);
    return true;
  }
  function aliasDel(st, from) {
    if (!hasOwn(st.aliases, from) && !hasOwn(st.aliasPending.set, from)) return;
    delete st.aliases[from];
    delete st.aliasPending.set[from];
    if (!st.aliasPending.del.includes(from)) st.aliasPending.del.push(from);
  }
  const aliasPendingCount = (st) => Object.keys(st.aliasPending.set).length + st.aliasPending.del.length;
  // 手元の未送信の変更を、受け取った名前のまとめの上に重ねる
  function aliasApplyPending(aliases, pending) {
    for (const k of Object.keys(pending.set)) aliases[k] = pending.set[k];
    for (const k of pending.del) delete aliases[k];
    return aliases;
  }

  /* ---------- 保存データの検査 ---------- */
  function defaults() {
    return {
      v: 2,
      cfg: { sheetUrl: '', motion: true, courts: 3, timerOn: false, mins: 8, sound: true, pinFirst: true, dir: 'v' },
      session: null, // 今日の練習会
      history: [], // 終了した練習会 {id,date,courts,rounds,attendees:[{no,name}],synced}
      aliases: mkAliases(), // まとめた名前 {元の名前: まとめ先}
      aliasPending: emptyPending(), // まだ送っていない、まとめた名前の変更
    };
  }

  function cleanRecord(h) {
    if (!h || typeof h !== 'object' || !isStr(h.id) || !h.id || !isStr(h.date) || !DATE_RE.test(h.date) || !Array.isArray(h.attendees)) return null;
    const attendees = h.attendees
      .filter((a) => a && isStr(a.name) && a.name.trim())
      .map((a) => ({ no: Math.max(0, parseInt(a.no, 10) || 0), name: a.name.trim().slice(0, 60) }));
    return { id: h.id.slice(0, 80), date: h.date.slice(0, 10), courts: Math.max(0, parseInt(h.courts, 10) || 0), rounds: Math.max(0, parseInt(h.rounds, 10) || 0), attendees, synced: !!h.synced };
  }
  function cleanHistory(arr) {
    const out = [];
    const seen = new Set();
    for (const h of Array.isArray(arr) ? arr : []) {
      const c = cleanRecord(h);
      if (c && !seen.has(c.id)) { seen.add(c.id); out.push(c); }
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  }

  const isNum = (x) => Number.isInteger(x);
  function cleanRound(r) {
    if (!r || typeof r !== 'object' || !Array.isArray(r.games) || !Array.isArray(r.resting)) return null;
    const games = [];
    for (const g of r.games) {
      if (!Array.isArray(g) || g.length !== 2) return null;
      for (const t of g) if (!Array.isArray(t) || t.length !== 2 || !t.every(isNum)) return null;
      games.push([g[0].slice(), g[1].slice()]);
    }
    if (!r.resting.every(isNum)) return null;
    return { n: 0, games, resting: r.resting.slice(), skipped: Array.isArray(r.skipped) ? r.skipped.filter(isNum) : [], ts: Number(r.ts) || 0 };
  }

  // 練習会を検査して整える。使えないときは null
  function normSession(x) {
    if (!x || typeof x !== 'object' || !isStr(x.id) || !isStr(x.date) || !Array.isArray(x.players) || !Array.isArray(x.rounds)) return null;
    const players = [];
    const nos = new Set();
    const uids = new Set();
    const noUid = [];
    for (const p of x.players) {
      if (!p || typeof p !== 'object') continue;
      const no = parseInt(p.no, 10);
      if (!(no >= 1 && no <= 999) || nos.has(no)) continue;
      nos.add(no);
      const q = { uid: 0, no, name: isStr(p.name) ? p.name.slice(0, 60) : '', status: ['in', 'rest', 'out'].includes(p.status) ? p.status : 'in' };
      // 古い形式（uid がない）は、番号をそのまま uid にする。過去のラウンドが番号で記録されているため
      if (isNum(p.uid) && p.uid > 0 && !uids.has(p.uid)) { q.uid = p.uid; uids.add(q.uid); } else noUid.push(q);
      players.push(q);
    }
    for (const q of noUid) if (!uids.has(q.no)) { q.uid = q.no; uids.add(q.no); }
    let next = Math.max(0, ...uids) + 1;
    for (const q of noUid) if (!q.uid) { q.uid = next++; uids.add(q.uid); }

    const removed = [];
    for (const r of Array.isArray(x.removed) ? x.removed : []) {
      if (r && isNum(r.uid) && !uids.has(r.uid)) { removed.push({ uid: r.uid, no: parseInt(r.no, 10) || 0, name: isStr(r.name) ? r.name : '' }); uids.add(r.uid); }
    }
    const pairs = [];
    const paired = new Set();
    const live = new Set(players.map((p) => p.uid));
    for (const pr of Array.isArray(x.pairs) ? x.pairs : []) {
      if (Array.isArray(pr) && pr.length === 2 && pr[0] !== pr[1] && live.has(pr[0]) && live.has(pr[1]) && !paired.has(pr[0]) && !paired.has(pr[1])) {
        pairs.push([pr[0], pr[1]]);
        paired.add(pr[0]); paired.add(pr[1]);
      }
    }
    const rounds = [];
    for (const r of x.rounds) {
      const c = cleanRound(r);
      if (c) { c.n = rounds.length + 1; rounds.push(c); }
    }
    return {
      id: x.id.slice(0, 80),
      date: x.date.slice(0, 10),
      courts: clamp(parseInt(x.courts, 10) || 3, 1, 12),
      players, pairs, rounds, removed,
      nextUid: Math.max(0, ...uids) + 1,
      warned: !!x.warned,
    };
  }

  function normalizeState(s) {
    const d = defaults();
    if (!s || typeof s !== 'object') return d;
    const c = s.cfg && typeof s.cfg === 'object' ? s.cfg : {};
    const cfg = {
      sheetUrl: isStr(c.sheetUrl) ? c.sheetUrl : '',
      motion: c.motion !== false,
      courts: clamp(parseInt(c.courts, 10) || 3, 1, 12),
      timerOn: !!c.timerOn,
      mins: [5, 7, 8, 10].includes(+c.mins) ? +c.mins : 8,
      sound: c.sound !== false,
      pinFirst: c.pinFirst !== false,
      dir: c.dir === 'h' ? 'h' : 'v',
    };
    const aliases = mkAliases(s.aliases);
    const ap = s.aliasPending && typeof s.aliasPending === 'object' ? s.aliasPending : {};
    const aliasPending = { set: mkAliases(ap.set), del: Array.isArray(ap.del) ? ap.del.filter(isStr) : [] };
    // 古い形式（まとめた名前をまるごと送る方式）からの引き継ぎ
    if (s.aliasesDirty) for (const k of Object.keys(aliases)) aliasPending.set[k] = aliases[k];
    return { v: 2, cfg, session: normSession(s.session), history: cleanHistory(s.history), aliases, aliasPending };
  }

  /* ---------- 練習会の操作 ---------- */
  function newSession(date, courts) {
    return { id: `${date}-${Math.random().toString(36).slice(2, 6)}`, date, courts: clamp(courts, 1, 12), players: [], pairs: [], rounds: [], removed: [], nextUid: 1, warned: false };
  }
  const byUid = (s, uid) => s.players.find((p) => p.uid === uid);
  const byNo = (s, no) => s.players.find((p) => p.no === no);
  const sortPlayers = (s) => s.players.sort((a, b) => a.no - b.no);
  const nextFreeNo = (s) => s.players.reduce((m, p) => Math.max(m, p.no), 0) + 1;
  const pairOf = (s, uid) => s.pairs.find((p) => p.includes(uid));

  // 画面に出す番号と名前（削除した人も、過去のラウンドの表示のために残してある）
  function info(s, uid) {
    const p = byUid(s, uid);
    if (p) return { no: p.no, name: p.name };
    const r = s.removed.find((x) => x.uid === uid);
    return r ? { no: r.no, name: r.name } : { no: 0, name: '' };
  }

  function addPlayer(s, no, name) {
    no = parseInt(no, 10);
    if (!(no >= 1 && no <= 999)) return { ok: false, error: '番号は1〜999で入れてください' };
    if (byNo(s, no)) return { ok: false, error: `${no}番はもう使われています` };
    const uid = s.nextUid++;
    s.players.push({ uid, no, name: String(name || '').trim().slice(0, 60), status: 'in' });
    sortPlayers(s);
    return { ok: true, uid };
  }

  function setStatus(s, uid, st) {
    const p = byUid(s, uid);
    if (!p || p.status === st || !['in', 'rest', 'out'].includes(st)) return false;
    p.status = st;
    if (st === 'out') s.pairs = s.pairs.filter((pr) => !pr.includes(uid)); // 帰宅した人の固定ペアは解除
    return true;
  }

  // 番号を変える。すでに使われているときは、swap が true なら入れ替える
  function renumber(s, uid, newNo, swap) {
    const p = byUid(s, uid);
    newNo = parseInt(newNo, 10);
    if (!p) return { ok: false, error: '参加者が見つかりません' };
    if (!(newNo >= 1 && newNo <= 999)) return { ok: false, error: '番号は1〜999で入れてください' };
    if (newNo === p.no) return { ok: true };
    const other = byNo(s, newNo);
    if (other) {
      if (!swap) return { ok: false, error: `${newNo}番はもう使われています`, conflict: other.uid };
      other.no = p.no;
    }
    p.no = newNo;
    sortPlayers(s);
    return { ok: true, swapped: !!other };
  }

  // forget が true なら、記録を残さずに消す（追加の取り消し用）
  function removePlayer(s, uid, forget) {
    const p = byUid(s, uid);
    if (!p) return;
    if (!forget) s.removed.push({ uid, no: p.no, name: p.name });
    s.players = s.players.filter((x) => x.uid !== uid);
    s.pairs = s.pairs.filter((pr) => !pr.includes(uid));
  }

  function makePair(s, a, b) {
    if (a === b || !byUid(s, a) || !byUid(s, b) || pairOf(s, a) || pairOf(s, b)) return false;
    if (byUid(s, a).status === 'out' || byUid(s, b).status === 'out') return false;
    s.pairs.push([a, b].sort((x, y) => byUid(s, x).no - byUid(s, y).no));
    return true;
  }
  function unpair(s, uid) {
    s.pairs = s.pairs.filter((pr) => !pr.includes(uid));
  }

  /* ---------- ラウンドを作る ---------- */
  // 前のラウンドで「1回休み」だった人は、次のラウンドから自動で参加に戻る
  function returningUids(s) {
    const last = s.rounds[s.rounds.length - 1];
    return last ? s.players.filter((p) => p.status === 'rest' && last.skipped.includes(p.uid)).map((p) => p.uid) : [];
  }

  // 次のラウンドの見込み（参加者の画面に出す）
  function previewNext(s) {
    const returning = returningUids(s);
    const active = s.players.filter((p) => p.status === 'in' || returning.includes(p.uid)).length;
    const onBreak = s.players.filter((p) => p.status === 'rest' && !returning.includes(p.uid)).length; // 1回休みで休憩に入る人
    const courts = Math.min(s.courts, Math.floor(active / 4));
    return { active, courts, playing: courts * 4, resting: active - courts * 4 + onBreak, onBreak };
  }

  // 休憩の回数に差が出ているときの注意文（なければ null）
  function spreadWarning(s) {
    if (s.rounds.length < 3) return null;
    const t = root.Matcher.tally(s.rounds);
    const act = s.players.filter((p) => p.status === 'in');
    if (act.length < 2) return null;
    const rows = act.map((p) => ({ no: p.no, n: t.rests.get(p.uid) || 0 }));
    const hi = rows.reduce((a, b) => (b.n > a.n ? b : a));
    const lo = rows.reduce((a, b) => (b.n < a.n ? b : a));
    if (hi.n - lo.n < 3) return null;
    return `休憩の回数に差が出ています（${hi.no}番が${hi.n}回、${lo.no}番が${lo.n}回）。固定ペアの組み合わせによっては、均等にできないことがあります。`;
  }

  // 指定した人の試合を、1コート目・チームAに置く（誰と組むか・誰と対戦するか・誰が休むかは変えない。位置だけを動かす）
  function pinToFirst(games, uid) {
    const gi = games.findIndex((g) => g[0].includes(uid) || g[1].includes(uid));
    if (gi < 0) return;
    if (games[gi][1].includes(uid)) games[gi] = [games[gi][1], games[gi][0]];
    if (gi > 0) games.unshift(games.splice(gi, 1)[0]);
  }

  // redo が true なら、いまのラウンドを作り直す
  // opts.pinNo: この番号の人を、1コート目のチームAに固定する（0なら固定しない）
  function generate(s, redo, rnd, opts) {
    if (redo && !s.rounds.length) return { ok: false, error: '作り直すラウンドがありません' };
    const returning = redo ? [] : returningUids(s);
    const act = s.players.filter((p) => p.status === 'in' || returning.includes(p.uid)).map((p) => p.uid);
    const pairs = s.pairs.filter((pr) => act.includes(pr[0]) && act.includes(pr[1]));
    const history = redo ? s.rounds.slice(0, -1) : s.rounds;
    const res = root.Matcher.buildRound({ players: act, pairs, courts: s.courts, history, rnd });
    if (!res) return { ok: false, error: '参加中の人が4人以上いないと、組み合わせを作れません' };
    returning.forEach((uid) => { byUid(s, uid).status = 'in'; });
    const pinned = opts && opts.pinNo ? byNo(s, opts.pinNo) : null;
    if (pinned) pinToFirst(res.games, pinned.uid);
    // 1回休みの人は、そのラウンドは休憩に入る（休憩欄に出て、休憩の回数にも数える）
    const sitting = s.players.filter((p) => p.status === 'rest').map((p) => p.uid);
    const round = {
      n: history.length + 1,
      games: res.games,
      resting: res.resting.concat(sitting).sort((a, b) => a - b),
      skipped: sitting,
      ts: Date.now(),
    };
    if (redo) s.rounds[s.rounds.length - 1] = round;
    else s.rounds.push(round);
    return { ok: true, round, warn: spreadWarning(s) };
  }

  /* ---------- 統計 ---------- */
  function statsRows(history, aliases) {
    const map = new Map();
    for (const h of history) {
      const seen = new Set();
      for (const a of h.attendees || []) {
        const n = resolveName(aliases, String((a && a.name) || ''));
        if (!n || seen.has(n)) continue;
        seen.add(n);
        const r = map.get(n) || { name: n, count: 0, last: '' };
        r.count++;
        if ((h.date || '') > r.last) r.last = h.date || '';
        map.set(n, r);
      }
    }
    return Array.from(map.values());
  }

  const api = {
    hasOwn, mkAliases, resolveName, aliasSet, aliasDel, aliasPendingCount, aliasApplyPending, emptyPending,
    defaults, cleanRecord, cleanHistory, normSession, normalizeState,
    newSession, byUid, byNo, nextFreeNo, pairOf, info,
    addPlayer, setStatus, renumber, removePlayer, makePair, unpair,
    returningUids, previewNext, spreadWarning, pinToFirst, generate, statsRows,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Core = api;
})(typeof window !== 'undefined' ? window : globalThis);
