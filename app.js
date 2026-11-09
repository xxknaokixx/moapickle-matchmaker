/* もあピ乱数表 — アプリ本体（画面と通信）。状態の操作は core.js、組み合わせの計算は matcher.js */
(() => {
  'use strict';

  /* ================================================================
   * 小さな道具
   * ================================================================ */
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad2 = (n) => String(n).padStart(2, '0');
  const todayStr = () => {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  };
  const shortDate = (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || '');
    return m ? `${+m[2]}/${+m[3]}` : s || '';
  };
  // 検索用: カタカナ→ひらがな、全角→半角、小文字
  const norm = (s) =>
    String(s)
      .normalize('NFKC')
      .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
      .toLowerCase()
      .trim();

  /* ================================================================
   * 保存データ
   * ================================================================ */
  const LS_KEY = 'mm.state.v1';

  // 読めないデータや、使えない部分を捨てるときは、元のデータを別のキーに残してから進む
  function backupRaw(raw) {
    try { localStorage.setItem(`${LS_KEY}.broken.${Date.now()}`, raw); } catch (e) { /* 容量がなければあきらめる */ }
  }
  function load() {
    let raw = null;
    try { raw = localStorage.getItem(LS_KEY); } catch (e) { /* 使えない環境 */ }
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        const st = Core.normalizeState(parsed);
        const lost = (parsed && parsed.session && !st.session) || (parsed && Array.isArray(parsed.history) && parsed.history.length !== st.history.length);
        if (lost) backupRaw(raw);
        return st;
      } catch (e) {
        backupRaw(raw);
      }
    }
    return Core.defaults();
  }
  let state = load();
  let saveFailed = false;
  function save() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(state));
      if (saveFailed) { saveFailed = false; renderSync(); }
      return true;
    } catch (e) {
      if (!saveFailed) { saveFailed = true; renderSync(); }
      return false;
    }
  }

  // 画面だけの状態（保存しない）
  const ui = {
    view: 'display',
    sel: new Set(), // 固定ペア用のチェック（uid）
    statSel: new Set(), // 名前まとめ用のチェック
    sort: { key: 'count', dir: -1 },
    animate: false,
    startCourts: state.cfg.courts || 3,
    dateTouched: false,
    lastEnd: '',
    sheetMsg: '',
    sugAll: false,
    pullOk: null, // 名簿の読み込みが最後にうまくいったか（null=まだ試していない）
  };

  const S = () => state.session;
  const P = (uid) => Core.byUid(S(), uid);
  const resolve = (n) => Core.resolveName(state.aliases, n);
  const statsRows = () => Core.statsRows(state.history, state.aliases);

  /* ================================================================
   * ラウンド
   * ================================================================ */
  function runRound(redo) {
    const s = S();
    const r = Core.generate(s, redo, undefined, { pinNo: state.cfg.pinFirst ? 1 : 0 });
    if (!r.ok) { toast(r.error, true); return false; }
    ui.animate = true;
    timerReset();
    if (r.warn && !s.warned) { s.warned = true; toast(r.warn, false, 10000); }
    save();
    return true;
  }

  /* ================================================================
   * 練習会の終了と記録
   * ================================================================ */
  function finishSession(record) {
    const s = S();
    let msg;
    if (record) {
      const attendees = s.players.filter((p) => p.name.trim()).map((p) => ({ no: p.no, name: p.name.trim() }));
      if (attendees.length) {
        state.history.push({ id: s.id, date: s.date, courts: s.courts, rounds: s.rounds.length, attendees, synced: false });
        msg = `${shortDate(s.date)} の練習会を記録しました（${attendees.length}人・${s.rounds.length}ラウンド）。`;
      } else {
        msg = '名前が入っている参加者がいなかったので、記録はしませんでした。';
      }
    } else {
      msg = '記録せずに終了しました。';
    }
    state.session = null;
    ui.sel.clear();
    ui.lastEnd = msg;
    ui.dateTouched = false;
    save();
  }

  /* ================================================================
   * Googleスプレッドシートとの同期（Google Apps Script のウェブアプリ経由）
   * ================================================================ */
  const sheetUrl = () => (state.cfg.sheetUrl || '').trim();
  const unsynced = () => state.history.filter((h) => !h.synced);
  const pendingCount = () => unsynced().length + Core.aliasPendingCount(state);
  let syncBusy = false;

  async function api(method, body, timeout = 15000) {
    const url = sheetUrl();
    if (!url) throw new Error('URLが未設定です');
    let u;
    try { u = new URL(url); } catch (e) { throw new Error('URLの形が正しくありません'); }
    if (u.protocol !== 'https:' || u.hostname !== 'script.google.com') throw new Error('URLは「https://script.google.com/」で始まるものを入れてください');

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      let res;
      try {
        if (method === 'GET') {
          res = await fetch(url + (url.includes('?') ? '&' : '?') + 'action=pull', { signal: ctl.signal });
        } else {
          // text/plain にして、ブラウザの事前確認（preflight）を避ける
          res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), signal: ctl.signal });
        }
      } catch (e) {
        throw new Error(e.name === 'AbortError' ? '時間内に応答がありませんでした' : 'ネットにつながっていないようです');
      }
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch (e) {
        if (/^\s*</.test(text)) throw new Error('スプレッドシート側の公開設定を確認してください（「アクセスできるユーザー」を「全員」にして、デプロイし直します）');
        throw new Error('応答を読み取れませんでした');
      }
      if (!data || !data.ok) throw new Error((data && data.error) || `通信エラー（${res.status}）`);
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  function mergeRemote(d) {
    const byId = new Map(state.history.map((h) => [h.id, h]));
    for (const r of Core.cleanHistory(d.sessions)) byId.set(r.id, { ...r, synced: true });
    state.history = Array.from(byId.values()).sort((a, b) => a.date.localeCompare(b.date));
    // 他の端末でのまとめ・解除を取り込み、まだ送っていない自分の変更を重ねる
    state.aliases = Core.aliasApplyPending(Core.mkAliases(d.aliases), state.aliasPending);
    save();
  }

  async function pull(timeout = 15000) {
    if (!sheetUrl()) return { ok: false, msg: 'URLが未設定です' };
    try {
      const d = await api('GET', null, timeout);
      mergeRemote(d);
      ui.pullOk = true;
      return { ok: true, sessions: Core.cleanHistory(d.sessions).length };
    } catch (e) {
      ui.pullOk = false;
      return { ok: false, msg: e.message || String(e) };
    }
  }

  async function flushSync() {
    if (!sheetUrl()) return { ok: false, msg: 'URLが未設定です' };
    if (syncBusy) return { ok: false, msg: '送信中です。少し待ってからもう一度お試しください', busy: true };
    if (!pendingCount()) return { ok: true, sent: 0 };
    syncBusy = true;
    let sent = 0;
    try {
      for (const h of unsynced()) {
        await api('POST', { action: 'push', session: { id: h.id, date: h.date, courts: h.courts, rounds: h.rounds, attendees: h.attendees } });
        h.synced = true;
        sent++;
        save();
      }
      if (Core.aliasPendingCount(state)) {
        const snap = { set: { ...state.aliasPending.set }, del: state.aliasPending.del.slice() };
        const d = await api('POST', { action: 'aliasOps', set: snap.set, del: snap.del });
        // 送っている間に増えた変更は残す
        for (const k of Object.keys(snap.set)) if (state.aliasPending.set[k] === snap.set[k]) delete state.aliasPending.set[k];
        state.aliasPending.del = state.aliasPending.del.filter((k) => !snap.del.includes(k));
        state.aliases = Core.aliasApplyPending(Core.mkAliases(d.aliases), state.aliasPending);
        sent++;
        save();
      }
      return { ok: true, sent };
    } catch (e) {
      return { ok: false, msg: e.message || String(e), sent };
    } finally {
      syncBusy = false;
      renderSync();
    }
  }

  function renderSync() {
    const el = $('#syncBadge');
    if (!el) return;
    const n = pendingCount();
    el.className = 'sync mono';
    if (saveFailed) { el.textContent = '⚠ この端末に保存できません'; el.classList.add('warn'); }
    else if (!sheetUrl()) el.textContent = 'この端末だけに保存';
    else if (n) { el.textContent = `未送信 ${n}件`; el.classList.add('warn'); }
    else if (ui.pullOk === false) { el.textContent = '名簿を更新できていません'; el.classList.add('warn'); }
    else { el.textContent = '✓ 同期済み'; el.classList.add('ok'); }
  }

  /* ================================================================
   * ダイアログ・通知
   * ================================================================ */
  // focus: 最初に選ばれるボタンの番号（押し間違いを防ぎたいときは、安全なほうを選ぶ）
  function dialog({ title, text, html, input, buttons, read, focus }) {
    return new Promise((resolveDialog) => {
      const m = $('#modal');
      const prev = document.activeElement;
      m.innerHTML = `<div class="mbox" role="dialog" aria-modal="true">
        ${title ? `<h3>${esc(title)}</h3>` : ''}
        ${text ? `<p>${esc(text)}</p>` : ''}
        ${html || ''}
        ${input ? `<input class="inp" id="dlgInput" value="${esc(input.value || '')}" placeholder="${esc(input.placeholder || '')}" ${input.numeric ? 'inputmode="numeric"' : ''} autocomplete="off">` : ''}
        <div class="mbtns">${buttons.map((b, i) => `<button class="btn ${b.kind || ''}" data-i="${i}">${esc(b.label)}</button>`).join('')}</div>
      </div>`;
      m.hidden = false;
      const box = $('.mbox', m);
      const done = (val) => {
        const out = { btn: val, input: $('#dlgInput', m) ? $('#dlgInput', m).value : null, data: val !== null && read ? read(box) : null };
        m.hidden = true;
        m.innerHTML = '';
        document.removeEventListener('keydown', onKey, true);
        m.removeEventListener('click', onClick);
        if (prev && prev.focus && document.contains(prev)) prev.focus();
        resolveDialog(out);
      };
      const primary = buttons.findIndex((b) => b.kind === 'primary');
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); done(null); }
        else if (e.key === 'Enter' && e.target && e.target.id === 'dlgInput' && primary >= 0) { e.preventDefault(); done(buttons[primary].value); }
        else if (e.key === 'Tab') {
          // フォーカスをダイアログの中に閉じ込める
          const f = $$('input, button', box);
          if (!f.length) return;
          const first = f[0], last = f[f.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      };
      const onClick = (e) => {
        const b = e.target.closest('button[data-i]');
        if (b) done(buttons[+b.dataset.i].value);
        else if (e.target === m) done(null);
      };
      document.addEventListener('keydown', onKey, true);
      m.addEventListener('click', onClick);
      const btns = $$('.mbtns .btn', m);
      const focusEl = $('#dlgInput', m) || (focus !== undefined ? btns[focus] : null) || $('.btn.primary', m) || btns[0];
      if (focusEl) { focusEl.focus(); if (focusEl.select) focusEl.select(); }
    });
  }

  let toastTimer = 0;
  let toastAction = null;
  function toast(msg, bad = false, ms = 3200, action = null) {
    const t = $('#toast');
    toastAction = action && action.fn;
    t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button" data-toast-act>${esc(action.label)}</button>` : ''}`;
    t.className = 'toast' + (bad ? ' bad' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; toastAction = null; }, ms);
  }

  /* ================================================================
   * 画面の描画
   * ================================================================ */
  const VIEWS = ['start', 'display', 'players', 'settings'];
  const effectiveView = () => (!state.session && (ui.view === 'display' || ui.view === 'players') ? 'start' : ui.view);

  function setView(v) {
    ui.view = v;
    render();
    if (v === 'settings') renderSettings(true);
    const sc = $('#v-' + effectiveView());
    if (sc) sc.scrollTop = 0;
  }

  function render() {
    renderHeader();
    renderSync();
    const v = effectiveView();
    for (const name of VIEWS) $('#v-' + name).hidden = name !== v;
    $$('#tabs button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === ui.view)));
    $('#endBtn').hidden = !state.session; // 練習会が始まっている間は、どの画面でも「練習会を終了」を出す
    if (v === 'start') renderStart();
    else if (v === 'display') renderDisplay();
    else if (v === 'players') renderPlayers();
    else if (v === 'settings') renderSettings(false);
    if (state.session) requestWake();
  }

  function renderHeader() {
    const n = state.session ? state.session.rounds.length : 0;
    $('#roundNo').textContent = pad2(n);
    $('#timer').hidden = !state.cfg.timerOn;
    paintTimer();
  }

  /* ---------- 練習会を始める ---------- */
  function renderStart() {
    if (!ui.dateTouched) $('#startDate').value = todayStr();
    $('#startCourts').textContent = ui.startCourts + '面';
    const un = pendingCount();
    $('#startNote').textContent = sheetUrl()
      ? `始めるときに、スプレッドシートから最新の名簿を読み込みます。${un ? `（未送信の記録が${un}件あります）` : ''}`
      : 'スプレッドシートは未設定です。名簿はこの端末の中だけに保存されます（設定画面で登録できます）。';
    const r = $('#startResult');
    r.hidden = !ui.lastEnd;
    r.innerHTML = ui.lastEnd ? `<h2 class="mono">Last session</h2><p class="note" style="font-size:14px;color:var(--name)">${esc(ui.lastEnd)}</p>` : '';
  }

  /* ---------- 発表画面 ---------- */
  const restSize = (n) => (n <= 6 ? 'l' : n <= 12 ? 'm' : n <= 24 ? 's' : 'xs');

  function renderDisplay() {
    const s = S();
    const r = s.rounds[s.rounds.length - 1];
    $('#nextBtn').textContent = r ? '次のラウンド' : 'ラウンド1を作る';
    $('#redoBtn').disabled = !r;
    $('#courtOut').textContent = s.courts + '面';
    $('#timerCtl').hidden = !state.cfg.timerOn;
    const courtsEl = $('#courts');
    const rest = $('#rest');
    $('#emptyDisp').hidden = !!r;
    courtsEl.hidden = !r;
    if (!r) {
      rest.hidden = true;
      const act = s.players.filter((p) => p.status === 'in').length;
      $('#emptyBig').textContent = 'ROUND 00';
      $('#emptyMsg').textContent = act < 4 ? `参加者を4人以上登録してください（いま${act}人）。` : `${act}人が参加中です。「ラウンド1を作る」を押してください。`;
      return;
    }
    const person = (uid) => {
      const i = Core.info(s, uid);
      return `<div class="p"><span class="num">${i.no || '?'}</span><span class="name">${esc(i.name) || '&nbsp;'}</span></div>`;
    };
    const team = (uids) => uids.slice().sort((a, b) => Core.info(s, a).no - Core.info(s, b).no).map(person).join('');
    const n = r.games.length;
    const cols = n >= 5 ? 2 : 1;
    courtsEl.style.setProperty('--cols', cols);
    courtsEl.style.setProperty('--rows', Math.ceil(n / cols));
    courtsEl.style.setProperty('--n', n);
    const hz = state.cfg.dir === 'h';
    courtsEl.dataset.dir = hz ? 'h' : 'v';
    const hcols = n >= 7 ? Math.ceil(n / 2) : n;
    courtsEl.style.setProperty('--hcols', hcols);
    courtsEl.style.setProperty('--hrows', Math.ceil(n / hcols));
    $('#dirBtn').textContent = hz ? '向き：横（左から）' : '向き：縦（上から）';
    courtsEl.toggleAttribute('data-dense', n >= 5 && !hz); // 面が多いスマホ表示では、枠が低いので小さなラベルを省く
    const enter = ui.animate ? ' enter' : '';
    courtsEl.innerHTML = r.games.map((g, i) => `
      <section class="court${enter}" style="--i:${i}" aria-label="コート${i + 1}"><div class="ci">
        <div class="label"><span class="lt mono">Court</span><span class="ln">${pad2(i + 1)}</span></div>
        <div class="pair a"><span class="tm mono">Team A</span>${team(g[0])}</div>
        <div class="vs mono">vs</div>
        <div class="pair b"><span class="tm mono">Team B</span>${team(g[1])}</div>
      </div></section>`).join('');
    ui.animate = false;
    rest.hidden = r.resting.length === 0;
    rest.dataset.sz = restSize(r.resting.length);
    $('#chips').innerHTML = r.resting.slice().sort((a, b) => Core.info(s, a).no - Core.info(s, b).no).map((uid) => {
      const i = Core.info(s, uid);
      return `<div class="chip"><span class="num">${i.no || '?'}</span><span class="name">${esc(i.name) || '&nbsp;'}</span></div>`;
    }).join('');
  }

  /* ---------- 参加者 ---------- */
  function renderSug() {
    if (!state.session) return;
    const q = norm($('#addName').value);
    const inUse = new Set(S().players.map((p) => norm(resolve(p.name))));
    let rows = statsRows().filter((r) => !inUse.has(norm(r.name)));
    rows.sort((a, b) => b.count - a.count || (b.last || '').localeCompare(a.last || ''));
    if (q) {
      const starts = rows.filter((r) => norm(r.name).startsWith(q));
      const incl = rows.filter((r) => !norm(r.name).startsWith(q) && norm(r.name).includes(q));
      rows = starts.concat(incl);
    }
    const limit = ui.sugAll ? 40 : q ? 12 : 8;
    const more = rows.length > limit;
    const chips = rows.slice(0, limit).map((r) => `<button type="button" data-act="sug" data-name="${esc(r.name)}">${esc(r.name)}<small>${r.count}回</small></button>`).join('');
    $('#sug').innerHTML = rows.length
      ? chips + (more ? '<button type="button" class="more" data-act="sugmore">さらに表示</button>' : '')
      : `<span class="note">${state.history.length ? '当てはまる名前がありません。そのまま「追加」を押すと新しい名前になります。' : 'まだ過去の参加者がいません。名前を入れて「追加」を押してください。'}</span>`;
  }

  function renderPlayers() {
    const s = S();
    const t = Matcher.tally(s.rounds);
    const cnt = { in: 0, rest: 0, out: 0 };
    s.players.forEach((p) => cnt[p.status]++);
    $('#psummary').innerHTML = `<span><b>${cnt.in}</b>参加中</span><span><b>${cnt.rest}</b>1回休み</span><span><b>${cnt.out}</b>帰宅</span><span><b>${s.rounds.length}</b>ラウンド</span>`;
    const pv = Core.previewNext(s);
    $('#pnext').textContent = pv.active >= 4
      ? `次のラウンド：参加${pv.active}人 → ${pv.courts}面（${pv.playing}人）で試合、休憩${pv.resting}人${pv.onBreak ? `（1回休み${pv.onBreak}人を含む）` : ''}`
      : `次のラウンド：参加${pv.active}人。4人以上になると組み合わせを作れます`;
    const go = $('#goBtn');
    go.textContent = s.rounds.length ? '発表画面へ' : 'ラウンド1を作る（発表画面へ）';
    go.disabled = !s.rounds.length && pv.active < 4;
    if (document.activeElement !== $('#addNo')) $('#addNo').value = Core.nextFreeNo(s);
    renderSug();

    // 固定ペア
    const nameOf = (uid) => esc(P(uid).name) || '（名前なし）';
    $('#pairs').innerHTML = s.pairs.length
      ? s.pairs.map((pr) => {
          const dormant = pr.some((u) => P(u).status !== 'in');
          return `<span class="pairchip${dormant ? ' dormant' : ''}"><b>${P(pr[0]).no}</b><small>${nameOf(pr[0])}</small> ⇄ <b>${P(pr[1]).no}</b><small>${nameOf(pr[1])}</small>${dormant ? '<small>（1回休み中）</small>' : ''}<button class="btn sm" data-act="unpair" data-uid="${pr[0]}">解除</button></span>`;
        }).join('')
      : '<span class="note">固定ペアはありません。ペアにしたい2人にチェックを入れて、「固定ペアにする」を押してください。</span>';
    const sel = Array.from(ui.sel);
    const canPair = sel.length === 2 && sel.every((u) => !Core.pairOf(s, u));
    $('#pairbar').innerHTML = `<span>選択中 ${sel.length}人</span><button class="btn sm" data-act="mkpair" ${canPair ? '' : 'disabled'}>固定ペアにする</button><button class="btn sm" data-act="clearsel" ${sel.length ? '' : 'disabled'}>選択を解除</button>${sel.length === 2 && !canPair ? '<span>すでにペアの人が含まれています</span>' : ''}`;

    // 一覧
    const badge = { in: '', rest: '1回休み（次のラウンドだけ休憩）', out: '帰宅' };
    $('#plist').innerHTML = s.players.length
      ? s.players.map((p) => {
          const pr = Core.pairOf(s, p.uid);
          const partner = pr ? P(pr.find((x) => x !== p.uid)).no : null;
          const seg = (v, label) => `<button data-act="status" data-uid="${p.uid}" data-v="${v}" aria-pressed="${p.status === v}">${label}</button>`;
          return `<div class="prow st-${p.status}">
            <label class="chk"><input type="checkbox" data-act="sel" data-uid="${p.uid}" ${ui.sel.has(p.uid) ? 'checked' : ''} ${p.status === 'out' ? 'disabled' : ''} aria-label="${p.no}番を選ぶ"></label>
            <button class="pno" data-act="editno" data-uid="${p.uid}" title="番号を変える">${p.no}</button>
            <button class="pname" data-act="editname" data-uid="${p.uid}" title="名前を変える">${esc(p.name)}</button>
            <span class="seg st">${seg('in', '参加')}${seg('rest', '1回休み')}${seg('out', '帰宅')}</span>
            <button class="del" data-act="del" data-uid="${p.uid}" aria-label="${p.no}番を削除" title="削除（入力ミスのとき）">✕</button>
            <span class="pr"><span>試合 ${t.games.get(p.uid) || 0}</span><span>休憩 ${t.rests.get(p.uid) || 0}</span>${partner ? `<span class="tagp">固定ペア：${partner}番</span>` : ''}${badge[p.status] ? `<span class="stb">${badge[p.status]}</span>` : ''}</span>
          </div>`;
        }).join('')
      : '<div class="empty" style="min-height:120px">上のフォームから、参加者を追加してください。</div>';
  }

  /* ---------- 統計 ---------- */
  function renderStats() {
    const rows = statsRows();
    const { key, dir } = ui.sort;
    rows.sort((a, b) => {
      let c;
      if (key === 'name') c = a.name.localeCompare(b.name, 'ja');
      else if (key === 'last') c = (a.last || '').localeCompare(b.last || '');
      else c = a.count - b.count;
      return c * dir || b.count - a.count || a.name.localeCompare(b.name, 'ja');
    });
    for (const n of Array.from(ui.statSel)) if (!rows.some((r) => r.name === n)) ui.statSel.delete(n);
    const arrow = (k) => (ui.sort.key === k ? (ui.sort.dir > 0 ? ' ▲' : ' ▼') : '');
    $('#statsTable').innerHTML = `<thead><tr><th></th><th data-sort="name">名前${arrow('name')}</th><th class="r" data-sort="count">参加回数${arrow('count')}</th><th data-sort="last">最後に来た日${arrow('last')}</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td><input type="checkbox" data-act="statsel" data-name="${esc(r.name)}" ${ui.statSel.has(r.name) ? 'checked' : ''} aria-label="${esc(r.name)}を選ぶ"></td><td>${esc(r.name)}</td><td class="r">${r.count}</td><td>${esc(r.last)}</td></tr>`).join('') || '<tr><td colspan="4" style="color:var(--muted);white-space:normal">まだ記録がありません。練習会を終了すると、ここに参加回数がたまっていきます。</td></tr>'}</tbody>`;
    $('#statsNote').textContent = `練習会 ${state.history.length}回 ・ ${rows.length}人`;
    $('#mergeBtn').disabled = ui.statSel.size < 2;
    const al = Object.entries(state.aliases);
    $('#aliasPanel').hidden = !al.length;
    $('#aliasList').innerHTML = al.map(([from, to]) => `<span class="pairchip"><small>${esc(from)}</small> → <b style="font-family:var(--font-body);font-size:14px">${esc(to)}</b><button class="btn sm" data-act="unalias" data-from="${esc(from)}">解除</button></span>`).join('');
  }

  /* ---------- 設定 ---------- */
  function renderSettings(full) {
    const c = state.cfg;
    const pressed = (id, val) => $$('#' + id + ' button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === String(val))));
    pressed('motionSeg', c.motion ? 1 : 0);
    pressed('timerSeg', c.timerOn ? 1 : 0);
    pressed('minsSeg', c.mins);
    pressed('soundSeg', c.sound ? 1 : 0);
    pressed('pinSeg', c.pinFirst ? 1 : 0);
    if (full || document.activeElement !== $('#sheetUrl')) $('#sheetUrl').value = c.sheetUrl;
    const un = pendingCount();
    $('#sheetNote').textContent = ui.sheetMsg || (c.sheetUrl ? `記録 ${state.history.length}回分を持っています。未送信は${un}件です。` : 'URLを入れると、練習会の記録を共有のスプレッドシートに保存・読み込みできます。URLは主催メンバー以外に教えないでください。');
    renderStats(); // 名簿と参加回数（設定画面の中の折りたたみ）
    const s = S();
    $('#sessionPanel').hidden = !s;
    if (s) {
      $('#sessionInfo').textContent = `${shortDate(s.date)} ・ 参加者${s.players.length}人 ・ ${s.rounds.length}ラウンド`;
      $('#setCourtOut').textContent = s.courts + '面';
    }
  }

  /* ================================================================
   * タイマー
   * ================================================================ */
  const timer = { left: 480, running: false, endAt: 0, warned: false, iv: 0 };
  const timerFull = () => state.cfg.mins * 60;
  const fmt = (s) => `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;
  let actx = null;
  function ensureAudio() {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
    } catch (e) { /* 音が出せなくても動く */ }
  }
  function beep(freq, dur) {
    if (!state.cfg.sound || !actx) return;
    try {
      const t = actx.currentTime;
      const o = actx.createOscillator();
      const g = actx.createGain();
      o.type = 'sine';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.4, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g);
      g.connect(actx.destination);
      o.start(t);
      o.stop(t + dur + 0.05);
    } catch (e) { /* ignore */ }
  }
  function paintTimer() {
    const el = $('#timer');
    $('#timerVal').textContent = fmt(timer.left);
    $('#timer .k').textContent = timer.left === 0 ? 'Time up' : 'Time';
    el.classList.toggle('paused', !timer.running && timer.left > 0 && timer.left < timerFull());
    el.classList.toggle('low', timer.left <= 60 && timer.left > 0);
    el.classList.toggle('done', timer.left === 0);
    $('#timerGo').textContent = timer.running ? '⏸ 一時停止' : timer.left === 0 ? '↺ もう一度' : timer.left < timerFull() ? '▶ 再開' : '▶ スタート';
  }
  function timerStop() {
    clearInterval(timer.iv);
    timer.iv = 0;
    timer.running = false;
  }
  function timerReset() {
    timerStop();
    timer.left = timerFull();
    timer.warned = false;
    paintTimer();
  }
  function timerToggle() {
    if (timer.running) { timerStop(); paintTimer(); return; }
    ensureAudio();
    if (timer.left <= 0) { timer.left = timerFull(); timer.warned = false; }
    timer.endAt = Date.now() + timer.left * 1000;
    timer.running = true;
    timer.iv = setInterval(tick, 250);
    paintTimer();
  }
  function tick() {
    const left = Math.max(0, Math.ceil((timer.endAt - Date.now()) / 1000));
    if (left === timer.left) return;
    timer.left = left;
    if (left <= 60 && left > 0 && !timer.warned && timerFull() > 60) { timer.warned = true; beep(880, 0.18); }
    if (left === 0) { timerStop(); beep(523, 1.3); }
    paintTimer();
  }

  /* ================================================================
   * 背景の動き（浮遊パーティクル）
   * ================================================================ */
  const root = document.documentElement;
  const canvas = $('#fxCanvas');
  const ctx = canvas.getContext('2d');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let W = 0, H = 0, dpr = 1, items = [], raf = 0;
  function size() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = innerWidth; H = innerHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function seed() {
    const css = (v) => getComputedStyle(root).getPropertyValue(v).trim();
    const cols = [css('--pair-a'), css('--pair-b'), '#ffffff'];
    items = [];
    const n = Math.round(Math.min(90, (W * H) / 16000));
    for (let i = 0; i < n; i++) items.push({ x: Math.random() * W, y: Math.random() * H, vx: (Math.random() - 0.5) * 0.25, vy: -(0.1 + Math.random() * 0.35), r: 0.8 + Math.random() * 1.8, c: cols[i % 3], sq: Math.random() < 0.3 });
  }
  function draw() {
    ctx.clearRect(0, 0, W, H);
    for (const p of items) {
      p.x += p.vx; p.y += p.vy;
      if (p.y < -10) { p.y = H + 10; p.x = Math.random() * W; }
      if (p.x < -10) p.x = W + 10;
      if (p.x > W + 10) p.x = -10;
    }
    ctx.lineWidth = 1;
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i], b = items[j], d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d < 130) { ctx.globalAlpha = (1 - d / 130) * 0.18; ctx.strokeStyle = a.c; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
      }
    }
    for (const p of items) {
      ctx.globalAlpha = 0.55; ctx.fillStyle = p.c; ctx.shadowColor = p.c; ctx.shadowBlur = 8;
      if (p.sq) ctx.fillRect(p.x - p.r, p.y - p.r, p.r * 2.2, p.r * 2.2);
      else { ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill(); }
    }
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
  }
  function loop() { draw(); raf = requestAnimationFrame(loop); }
  function applyMotion() {
    const on = state.cfg.motion;
    if (on) root.removeAttribute('data-motion'); else root.setAttribute('data-motion', 'off');
    cancelAnimationFrame(raf);
    if (on) { size(); seed(); if (reduce) draw(); else loop(); }
  }
  addEventListener('resize', () => { if (state.cfg.motion) { size(); seed(); } });
  document.addEventListener('visibilitychange', () => {
    cancelAnimationFrame(raf);
    if (!document.hidden) {
      if (state.cfg.motion && !reduce) loop();
      if (state.session) requestWake();
    }
  });

  /* 画面を消さない（会場で表示し続けるため） */
  let wakeLock = null;
  async function requestWake() {
    try {
      if (!('wakeLock' in navigator) || wakeLock || document.hidden) return;
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (e) { /* 使えない環境では何もしない */ }
  }

  /* ================================================================
   * 書き出し・読み込み
   * ================================================================ */
  function download(name, text, mime) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: mime }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  // 表計算ソフトで開いたときに、名前が式として動かないようにする
  const csvCell = (v) => {
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  };

  /* ================================================================
   * 操作（クリックなどのイベント）
   * ================================================================ */
  async function onNext() {
    const s = S();
    const last = s.rounds[s.rounds.length - 1];
    // 試合中の押し間違いを防ぐ（前のラウンドを発表して1分以内、またはタイマーが動いているとき）
    if (last && (timer.running || Date.now() - last.ts < 60000)) {
      const r = await dialog({
        title: '次のラウンドを作りますか？',
        text: timer.running ? 'タイマーが動いています。前のラウンドは、まだ終わっていないかもしれません。' : 'まだ発表から1分たっていません。前のラウンドは終わりましたか？',
        buttons: [{ label: 'やめる', value: 'no' }, { label: '次のラウンドを作る', value: 'ok', kind: 'primary' }],
        focus: 0,
      });
      if (r.btn !== 'ok') return;
    }
    if (runRound(false)) { renderDisplay(); renderHeader(); }
  }

  async function onRedo() {
    const r = await dialog({
      title: 'このラウンドを作り直しますか？',
      text: 'いま出ている表は消えて、新しい組み合わせになります。参加者が動き出したあとだと、混乱のもとになります。',
      buttons: [{ label: 'やめる', value: 'no' }, { label: '作り直す', value: 'ok', kind: 'primary' }],
      focus: 0,
    });
    if (r.btn !== 'ok') return;
    if (runRound(true)) { renderDisplay(); renderHeader(); }
  }

  async function onEndSession() {
    const s = S();
    const noRounds = s.rounds.length === 0;
    // 試しに使っただけのときは、「記録せずに終了」で、名簿にも参加回数にも残さずに終われる
    const buttons = [
      { label: 'キャンセル', value: 'cancel' },
      { label: '記録せずに終了（試しのとき）', value: 'discard', kind: 'danger' },
      { label: noRounds ? 'それでも記録して終了' : '終了して記録する', value: 'save', kind: 'primary' },
    ];
    const r = await dialog({
      title: '練習会を終了しますか？',
      text: (noRounds ? 'まだラウンドを1回も作っていません。' : `${s.players.length}人の参加と、${s.rounds.length}ラウンド分を記録します。${sheetUrl() ? 'スプレッドシートにも送ります。' : ''}`) + '終了すると、今日の組み合わせは元に戻せません。試しに使っただけなら、「記録せずに終了」を選んでください。',
      buttons,
      focus: 0,
    });
    if (r.btn !== 'save' && r.btn !== 'discard') return;
    timerReset();
    finishSession(r.btn === 'save');
    ui.view = 'display';
    render();
    if (r.btn === 'save' && sheetUrl()) {
      const res = await flushSync();
      ui.lastEnd += res.ok ? ' スプレッドシートに送りました。' : ` スプレッドシートには送れませんでした（${res.msg}）。あとで「設定」から送り直せます。`;
      renderStart();
    }
    renderSync();
  }

  async function onStart() {
    const btn = $('#startBtn');
    const date = $('#startDate').value || todayStr();
    btn.disabled = true;
    if (sheetUrl()) {
      btn.textContent = '名簿を読み込み中…';
      const res = await pull(6000);
      if (!res.ok) toast(`名簿を読み込めませんでした（${res.msg}）。この端末の名簿で始めます`, true, 7000);
    }
    btn.disabled = false;
    btn.textContent = '練習会を始める';
    state.session = Core.newSession(date, ui.startCourts);
    state.cfg.courts = ui.startCourts;
    ui.sel.clear();
    ui.lastEnd = '';
    ui.view = 'players';
    save();
    render();
    setTimeout(() => $('#addName').focus(), 50);
  }

  // fromChip: 候補のボタンから追加したとき
  async function onAdd(name, fromChip) {
    const s = S();
    name = resolve(String(name !== undefined ? name : $('#addName').value).trim());
    const no = $('#addNo').value;
    if (name && !fromChip && s.players.some((p) => norm(resolve(p.name)) === norm(name))) {
      const r = await dialog({ title: '同じ名前の人がいます', text: `「${name}」さんはもう登録されています。別の人として追加しますか？`, buttons: [{ label: 'やめる', value: 'no' }, { label: '追加する', value: 'ok', kind: 'primary' }], focus: 0 });
      if (r.btn !== 'ok') return;
    }
    const res = Core.addPlayer(s, no, name);
    if (!res.ok) { toast(res.error, true); return; }
    save();
    $('#addName').value = '';
    $('#addNo').value = '';
    renderPlayers();
    $('#addName').focus();
    // 押し間違いのときは、その場で取り消せる
    toast(`${no}番 ${name || '（名前なし）'} を追加しました`, false, 5000, {
      label: '取り消す',
      fn: () => {
        if (!Core.byUid(S(), res.uid)) return;
        const used = S().rounds.some((r) => r.resting.includes(res.uid) || r.games.flat(2).includes(res.uid));
        Core.removePlayer(S(), res.uid, !used);
        ui.sel.delete(res.uid);
        save();
        renderPlayers();
      },
    });
  }

  async function onClick(e) {
    const ta = e.target.closest('[data-toast-act]');
    if (ta) { const fn = toastAction; $('#toast').hidden = true; toastAction = null; if (fn) fn(); return; }

    const t = e.target.closest('[data-act],[data-view],[data-sort]');
    if (!t) return;
    const act = t.dataset.act;

    if (t.dataset.view && !act) { setView(t.dataset.view); return; }
    if (t.dataset.sort) {
      ui.sort = { key: t.dataset.sort, dir: ui.sort.key === t.dataset.sort ? -ui.sort.dir : t.dataset.sort === 'name' ? 1 : -1 };
      renderStats();
      return;
    }
    const uid = t.dataset.uid ? +t.dataset.uid : null;
    const s = S();

    switch (act) {
      case 'start-courts':
        ui.startCourts = Math.min(12, Math.max(1, ui.startCourts + +t.dataset.d));
        renderStart();
        break;
      case 'courts':
        s.courts = Math.min(12, Math.max(1, s.courts + +t.dataset.d));
        state.cfg.courts = s.courts;
        save();
        if (effectiveView() === 'settings') renderSettings(false); else renderDisplay();
        break;
      case 'sug':
        onAdd(t.dataset.name, true);
        break;
      case 'sugmore':
        ui.sugAll = true;
        renderSug();
        break;
      case 'status': {
        const p = P(uid);
        if (t.dataset.v === 'out' && p.status !== 'out' && Core.pairOf(s, uid)) {
          const partner = P(Core.pairOf(s, uid).find((x) => x !== uid));
          const r = await dialog({ title: `${p.no}番を帰宅にしますか？`, text: `${p.no}番は${partner.no}番と固定ペアです。帰宅にすると、固定ペアは解除されます。`, buttons: [{ label: 'やめる', value: 'no' }, { label: '帰宅にする', value: 'ok', kind: 'primary' }], focus: 0 });
          if (r.btn !== 'ok') break;
        }
        if (Core.setStatus(s, uid, t.dataset.v)) ui.sel.delete(t.dataset.v === 'out' ? uid : -1);
        save();
        renderPlayers();
        break;
      }
      case 'del': {
        const p = P(uid);
        const r = await dialog({ title: `${p.no}番を削除しますか？`, text: `${p.name || '（名前なし）'}さんを、この練習会の参加者から消します。入力ミスのときに使ってください。早退した人は「帰宅」にします。`, buttons: [{ label: 'キャンセル', value: 'no' }, { label: '削除する', value: 'yes', kind: 'danger' }], focus: 0 });
        if (r.btn === 'yes') { Core.removePlayer(s, uid); ui.sel.delete(uid); save(); renderPlayers(); }
        break;
      }
      case 'editno': {
        const p = P(uid);
        const r = await dialog({ title: '番号を変える', text: `${p.no}番を何番にしますか？`, input: { value: String(p.no), numeric: true }, buttons: [{ label: 'キャンセル', value: 'no' }, { label: '変更', value: 'ok', kind: 'primary' }] });
        if (r.btn !== 'ok') break;
        let res = Core.renumber(s, uid, r.input, false);
        if (!res.ok && res.conflict) {
          const other = P(res.conflict);
          const r2 = await dialog({ title: `${r.input}番は使われています`, text: `${r.input}番は${other.name || '（名前なし）'}さんです。2人の番号を入れ替えますか？`, buttons: [{ label: 'やめる', value: 'no' }, { label: '入れ替える', value: 'ok', kind: 'primary' }], focus: 0 });
          if (r2.btn !== 'ok') break;
          res = Core.renumber(s, uid, r.input, true);
        }
        if (!res.ok) { toast(res.error, true); break; }
        save();
        renderPlayers();
        break;
      }
      case 'editname': {
        const p = P(uid);
        const r = await dialog({ title: `${p.no}番の名前`, input: { value: p.name, placeholder: '名前' }, buttons: [{ label: 'キャンセル', value: 'no' }, { label: '変更', value: 'ok', kind: 'primary' }] });
        if (r.btn !== 'ok') break;
        p.name = resolve(r.input.trim()).slice(0, 60);
        save();
        renderPlayers();
        break;
      }
      case 'mkpair': {
        const sel = Array.from(ui.sel);
        if (sel.length === 2 && Core.makePair(s, sel[0], sel[1])) {
          ui.sel.clear();
          save();
          renderPlayers();
          toast('固定ペアにしました（次のラウンドから）');
        }
        break;
      }
      case 'clearsel':
        ui.sel.clear();
        renderPlayers();
        break;
      case 'unpair':
        Core.unpair(s, uid);
        save();
        renderPlayers();
        break;
      case 'unalias':
        Core.aliasDel(state, t.dataset.from);
        save();
        renderStats();
        renderSync();
        flushSync();
        break;
      default:
    }
  }

  function onChange(e) {
    const t = e.target;
    if (t.dataset.act === 'sel') {
      const uid = +t.dataset.uid;
      if (t.checked) ui.sel.add(uid); else ui.sel.delete(uid);
      renderPlayers();
    } else if (t.dataset.act === 'statsel') {
      if (t.checked) ui.statSel.add(t.dataset.name); else ui.statSel.delete(t.dataset.name);
      $('#mergeBtn').disabled = ui.statSel.size < 2;
    }
  }

  async function importBackup(file) {
    const d = JSON.parse(await file.text());
    if (!d || typeof d !== 'object' || !Array.isArray(d.history)) throw new Error('バックアップの形式ではありません');
    const incoming = Core.cleanHistory(d.history);
    const ids = new Set(state.history.map((h) => h.id));
    let added = 0;
    for (const h of incoming) {
      if (!ids.has(h.id)) { state.history.push({ ...h, synced: false }); added++; }
    }
    state.history.sort((a, b) => a.date.localeCompare(b.date));
    const al = Core.mkAliases(d.aliases);
    for (const k of Object.keys(al)) if (!Core.hasOwn(state.aliases, k)) Core.aliasSet(state, k, al[k]);
    // 進行中だった練習会も、いま練習会がなければ戻す
    let restored = false;
    if (!state.session && d.session) {
      const s = Core.normSession(d.session);
      if (s) { state.session = s; restored = true; }
    }
    save();
    return { added, skipped: d.history.length - incoming.length, restored };
  }

  function bind() {
    document.addEventListener('click', onClick);
    document.addEventListener('change', onChange);

    $('#startBtn').addEventListener('click', onStart);
    $('#startDate').addEventListener('input', () => { ui.dateTouched = true; });
    $('#endBtn').addEventListener('click', onEndSession);
    $('#nextBtn').addEventListener('click', onNext);
    $('#redoBtn').addEventListener('click', onRedo);
    $('#goBtn').addEventListener('click', () => {
      if (!S().rounds.length && !runRound(false)) return;
      ui.view = 'display';
      render();
    });

    $('#addForm').addEventListener('submit', (e) => { e.preventDefault(); onAdd(); });
    $('#addName').addEventListener('input', () => { ui.sugAll = false; renderSug(); });

    // タイマー
    $('#timer').addEventListener('click', timerToggle);
    $('#dirBtn').addEventListener('click', () => { state.cfg.dir = state.cfg.dir === 'h' ? 'v' : 'h'; save(); renderDisplay(); });
    $('#timerGo').addEventListener('click', timerToggle);
    $('#timerReset').addEventListener('click', timerReset);

    // 操作ボタンを隠す（できる環境では全画面にもする）
    // 同じ場所のボタンが「操作を隠す」⇄「操作を表示」に切り替わる（ほかのボタンだけが隠れる）
    const setClean = (on) => {
      document.body.classList.toggle('clean', on);
      $('#cleanBtn').textContent = on ? '操作を表示' : '操作を隠す';
    };
    $('#cleanBtn').addEventListener('click', () => {
      const on = !document.body.classList.contains('clean');
      setClean(on);
      try {
        if (on && document.documentElement.requestFullscreen && !document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
        if (!on && document.fullscreenElement) document.exitFullscreen();
      } catch (e) { /* ignore */ }
    });
    document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) setClean(false); });

    // 統計
    $('#csvBtn').addEventListener('click', () => {
      const rows = statsRows().sort((a, b) => b.count - a.count);
      download(`参加回数_${todayStr()}.csv`, '﻿' + ['名前,参加回数,最後に来た日'].concat(rows.map((r) => [csvCell(r.name), r.count, r.last].join(','))).join('\r\n'), 'text/csv');
    });
    $('#mergeBtn').addEventListener('click', async () => {
      const rows = statsRows().filter((r) => ui.statSel.has(r.name)).sort((a, b) => b.count - a.count);
      if (rows.length < 2) return;
      const html = `<div>${rows.map((r, i) => `<label class="radio"><input type="radio" name="canon" value="${esc(r.name)}" ${i === 0 ? 'checked' : ''}> ${esc(r.name)} <small style="color:var(--muted)">${r.count}回</small></label>`).join('')}</div>`;
      const r = await dialog({ title: '同じ人としてまとめる', text: 'どの名前にまとめますか？ ほかの名前の記録は、選んだ名前の回数に足されます。', html, read: (box) => box.querySelector('input[name=canon]:checked').value, buttons: [{ label: 'キャンセル', value: 'no' }, { label: 'まとめる', value: 'ok', kind: 'primary' }] });
      if (r.btn !== 'ok') return;
      for (const row of rows) if (row.name !== r.data) Core.aliasSet(state, row.name, r.data);
      ui.statSel.clear();
      save();
      renderStats();
      renderSync();
      flushSync();
    });

    // 設定
    const segHandler = (id, fn) => $('#' + id).addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      fn(b.dataset.v);
      save();
      renderSettings(false);
    });
    segHandler('motionSeg', (v) => { state.cfg.motion = v === '1'; applyMotion(); });
    segHandler('timerSeg', (v) => { state.cfg.timerOn = v === '1'; if (!state.cfg.timerOn) timerStop(); renderHeader(); $('#timerCtl').hidden = !state.cfg.timerOn; });
    segHandler('minsSeg', (v) => { state.cfg.mins = +v; timerReset(); });
    segHandler('pinSeg', (v) => { state.cfg.pinFirst = v === '1'; });
    segHandler('soundSeg', (v) => { state.cfg.sound = v === '1'; if (v === '1') { ensureAudio(); beep(880, 0.12); } });

    $('#sheetUrl').addEventListener('input', (e) => { state.cfg.sheetUrl = e.target.value.trim(); ui.sheetMsg = ''; ui.pullOk = null; save(); renderSync(); });
    $('#testBtn').addEventListener('click', async () => {
      ui.sheetMsg = '接続しています…';
      renderSettings(false);
      const r = await pull();
      ui.sheetMsg = r.ok ? `接続できました。スプレッドシートの記録 ${r.sessions}回分を読み込みました。` : `接続できませんでした：${r.msg}`;
      renderSettings(false);
      renderSync();
    });
    $('#pushBtn').addEventListener('click', async () => {
      ui.sheetMsg = '送っています…';
      renderSettings(false);
      const r = await flushSync();
      ui.sheetMsg = r.ok ? (r.sent ? `${r.sent}件を送りました。` : '未送信のものはありません。') : `送れませんでした：${r.msg}`;
      renderSettings(false);
    });
    $('#exportBtn').addEventListener('click', () => {
      download(`pickle-backup-${todayStr()}.json`, JSON.stringify({ app: 'mm', version: 2, history: state.history, aliases: state.aliases, session: state.session }, null, 1), 'application/json');
    });
    $('#importFile').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      try {
        const r = await importBackup(f);
        ui.sheetMsg = `バックアップから ${r.added}回分を読み込みました。${r.skipped ? `（形式が合わない${r.skipped}件は読み飛ばしました）` : ''}${r.restored ? ' 進行中の練習会も戻しました。' : ''}`;
        render();
        renderSettings(false);
        toast(`${r.added}回分を読み込みました`);
      } catch (err) {
        toast('読み込めませんでした：' + err.message, true, 6000);
      }
    });

    addEventListener('online', () => { flushSync(); });
    // 別のタブ・ウィンドウで変更されたら、そちらを正とする（古い画面が上書きしないように）
    addEventListener('storage', (e) => {
      if (e.key !== LS_KEY || !e.newValue) return;
      try { state = Core.normalizeState(JSON.parse(e.newValue)); } catch (err) { return; }
      render();
    });
  }

  /* ================================================================
   * 起動
   * ================================================================ */
  function showFatal(err) {
    const m = $('#modal');
    m.hidden = false;
    m.innerHTML = `<div class="mbox" role="alertdialog"><h3>データを読み込めませんでした</h3>
      <p>保存されているデータの形がおかしいようです。「退避して初期化」を押すと、元のデータは別の場所に残したまま、新しい状態で始められます。</p>
      <p style="color:var(--muted);font-size:12px">${esc(err && err.message ? err.message : String(err))}</p>
      <div class="mbtns"><button class="btn" id="fatalReload">そのまま再読み込み</button><button class="btn primary" id="fatalReset">退避して初期化</button></div></div>`;
    $('#fatalReload').onclick = () => location.reload();
    $('#fatalReset').onclick = () => {
      try {
        const raw = localStorage.getItem(LS_KEY);
        if (raw) backupRaw(raw);
        localStorage.removeItem(LS_KEY);
      } catch (e) { /* ignore */ }
      location.reload();
    };
  }

  function boot() {
    bind();
    applyMotion();
    timer.left = timerFull();
    if (state.session && state.session.courts) ui.startCourts = state.session.courts;
    try {
      render();
    } catch (e) {
      showFatal(e);
      return;
    }
    if (sheetUrl() && navigator.onLine) {
      pull(8000).then(() => flushSync()).then(() => render());
    }
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  window.mm = { get state() { return state; }, get ui() { return ui; }, runRound, render, save, flushSync, pull }; // 動作確認用
  boot();
})();
