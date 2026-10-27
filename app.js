(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var fmt = function (n) { return (Math.round(n * 10) / 10).toString().replace('.', ','); };
  var ls = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }
  };

  var cfg = window.POSEIDON_CONFIG || {};
  var sb = null, uid = null, ready = false;
  var me = { name: ls.get('pp-name') || '', role: ls.get('pp-role') === 'observer' ? 'observer' : 'participant' };
  var S = { code: null, room: null, roomLoaded: false, members: [], membersLoaded: false, votes: [], channel: null, poll: null, autoFor: null, q: Promise.resolve(), panelRound: null, finalRound: null, finalTouched: false, editing: null, timer: null };

  /* ---------- helpers ---------- */
  function slug(s) {
    return String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  }
  function parseHours(v) {
    var n = Number(String(v).trim().replace(',', '.'));
    if (!isFinite(n) || n < 0.5 || n > 999) return null;
    return Math.round(n * 2) / 2;
  }
  function dbMsg(e) {
    var m = String((e && (e.message || e.details)) || '').toLowerCase();
    if ((e && e.code === '42501') || m.indexOf('row-level security') >= 0) return 'Ação não permitida. Se a votação já foi revelada, aguarde a próxima rodada.';
    return 'Falha de conexão. Tente novamente.';
  }
  var toastT = null;
  function toast(msg, isErr) {
    var t = $('toast'); t.textContent = msg; t.className = 'toast' + (isErr ? ' err' : ''); t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(function () { t.hidden = true; }, 3200);
  }
  function hue(id) { var h = 0; for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360; return h; }
  function isHost() { return !!(S.room && S.room.hostId === uid); }
  function story() { var r = S.room; return r && (r.backlog || []).find(function (s) { return s.id === r.activeId; }) || null; }
  function voters() { return S.members.filter(function (m) { return m.role !== 'observer'; }); }
  function myVote() { return S.votes.find(function (v) { return v.id === uid; }) || null; }
  function currentVotes() {
    var r = S.room;
    return S.votes.filter(function (v) { return v.round === r.round && voters().some(function (m) { return m.id === v.id; }); })
      .map(function (v) { return { id: v.id, value: Number(v.value) }; }).filter(function (v) { return isFinite(v.value); });
  }
  function stats(vs) {
    if (!vs.length) return null;
    var vals = vs.map(function (v) { return v.value; }).sort(function (a, b) { return a - b; });
    var sum = vals.reduce(function (a, b) { return a + b; }, 0), mean = sum / vals.length;
    var mid = Math.floor(vals.length / 2);
    var median = vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
    var min = vals[0], max = vals[vals.length - 1], range = max - min;
    var cons = range === 0 ? ['Consenso total', 'ok'] : range <= Math.max(1, mean * 0.25) ? ['Quase lá', 'mid'] : ['Divergência alta', 'bad'];
    return { mean: mean, median: median, min: min, max: max, cons: cons, half: Math.round(mean * 2) / 2 };
  }
  function saveFile(name, text) {
    var b = new Blob([text], { type: 'text/csv;charset=utf-8' }), a = document.createElement('a');
    a.href = URL.createObjectURL(b); a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  /* ---------- data mapping and loading ---------- */
  function mapRoom(r) {
    return { code: r.code, name: r.name, hostId: r.host_id, autoReveal: r.auto_reveal, backlog: r.backlog || [], activeId: r.active_id, revealed: r.revealed, round: r.round, roundStartedAt: Number(r.round_started_at), revealedAt: r.revealed_at == null ? null : Number(r.revealed_at) };
  }
  async function loadRoom() {
    var res = await sb.from('rooms').select('*').eq('code', S.code).maybeSingle();
    if (res.error) throw res.error;
    S.room = res.data ? mapRoom(res.data) : null; S.roomLoaded = true;
  }
  async function loadMembers() {
    var res = await sb.from('members').select('*').eq('room_code', S.code);
    if (res.error) throw res.error;
    S.members = res.data.map(function (m) { return { id: m.user_id, name: m.name, role: m.role, joinedAt: Number(m.joined_at), voted: m.voted, round: m.round }; });
    S.membersLoaded = true;
  }
  async function loadVotes() {
    var res = await sb.from('votes').select('*').eq('room_code', S.code);
    if (res.error) throw res.error;
    S.votes = res.data.map(function (v) { return { id: v.user_id, round: v.round, storyId: v.story_id, value: Number(v.value) }; });
  }
  async function refreshAll() { await Promise.all([loadRoom(), loadMembers(), loadVotes()]); onData(); }

  /* ---------- screens ---------- */
  function show(screen) {
    $('home').hidden = screen !== 'home';
    $('room').hidden = screen !== 'room';
    $('roomChips').hidden = screen !== 'room';
    clearInterval(S.timer);
    if (screen === 'room') S.timer = setInterval(tick, 1000);
  }
  function closeLayers() { document.querySelectorAll('.layer').forEach(function (l) { l.hidden = true; }); }
  function openLayer(id) { closeLayers(); $(id).hidden = false; }
  function homeErr(m) { $('homeErr').textContent = m || ''; }

  /* ---------- theme ---------- */
  var savedTheme = ls.get('pp-theme');
  if (savedTheme === 'light' || savedTheme === 'dark') document.documentElement.setAttribute('data-theme', savedTheme);
  $('themeBtn').addEventListener('click', function () {
    var cur = document.documentElement.getAttribute('data-theme') || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    var next = cur === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next); ls.set('pp-theme', next);
  });

  /* ---------- home ---------- */
  $('meName').value = me.name;
  $('roleO').checked = me.role === 'observer'; $('roleP').checked = me.role !== 'observer';
  if (ls.get('pp-room')) $('joinName').value = ls.get('pp-room');
  function setTab(t) {
    var c = t === 'create';
    $('tabCreate').setAttribute('aria-selected', c); $('tabJoin').setAttribute('aria-selected', !c);
    $('createForm').hidden = !c; $('joinForm').hidden = c; homeErr('');
  }
  $('tabCreate').addEventListener('click', function () { setTab('create'); });
  $('tabJoin').addEventListener('click', function () { setTab('join'); });
  function readIdentity() {
    var n = $('meName').value.trim();
    if (n.length < 2) { homeErr('Informe seu nome (mínimo 2 letras).'); $('meName').focus(); return false; }
    me.name = n; me.role = $('roleO').checked ? 'observer' : 'participant';
    ls.set('pp-name', me.name); ls.set('pp-role', me.role); return true;
  }
  $('createForm').addEventListener('submit', async function (ev) {
    ev.preventDefault(); homeErr('');
    if (!ready || !readIdentity()) return;
    var raw = $('roomName').value.trim(), code = slug(raw);
    if (code.length < 3) { homeErr('Dê à sala um nome com pelo menos 3 letras ou números.'); return; }
    $('createBtn').disabled = true;
    try {
      var ex = await sb.from('rooms').select('code,host_id').eq('code', code).maybeSingle();
      if (ex.error) throw ex.error;
      if (ex.data && ex.data.host_id !== uid) { homeErr('Já existe uma sala com esse nome. Escolha outro nome ou entre nela.'); return; }
      if (!ex.data) {
        var ins = await sb.from('rooms').insert({ code: code, name: raw.slice(0, 40), host_id: uid, auto_reveal: $('autoReveal').checked, backlog: [], active_id: null, revealed: false, round: 1, round_started_at: Date.now() });
        if (ins.error) throw ins.error;
      }
      await enterRoom(code);
    } catch (e) { homeErr(dbMsg(e)); }
    finally { $('createBtn').disabled = !ready; }
  });
  $('joinForm').addEventListener('submit', async function (ev) {
    ev.preventDefault(); homeErr('');
    if (!ready || !readIdentity()) return;
    var code = slug($('joinName').value);
    if (code.length < 3) { homeErr('Digite o nome da sala.'); return; }
    $('joinBtn').disabled = true;
    try {
      var ex = await sb.from('rooms').select('code').eq('code', code).maybeSingle();
      if (ex.error) throw ex.error;
      if (!ex.data) { homeErr('Sala não encontrada. Confira o nome com o facilitador.'); return; }
      await enterRoom(code);
    } catch (e) { homeErr(dbMsg(e)); }
    finally { $('joinBtn').disabled = !ready; }
  });
  $('brandBtn').addEventListener('click', function () { if (S.code) return; show('home'); });

  /* ---------- room lifecycle ---------- */
  function teardown() {
    if (S.channel) { try { sb.removeChannel(S.channel); } catch (e) {} S.channel = null; }
    clearInterval(S.poll); S.poll = null;
  }
  function rowOf(p) { return (p && p.new && Object.keys(p.new).length ? p.new : p && p.old) || {}; }
  async function enterRoom(code) {
    teardown();
    S.code = code; S.room = null; S.roomLoaded = false; S.members = []; S.membersLoaded = false; S.votes = []; S.autoFor = null; S.panelRound = null; S.finalRound = null; S.q = Promise.resolve();
    var ex = await sb.from('members').select('user_id').eq('room_code', code).eq('user_id', uid).maybeSingle();
    if (ex.error) throw ex.error;
    if (ex.data) {
      var u = await sb.from('members').update({ name: me.name, role: me.role }).eq('room_code', code).eq('user_id', uid);
      if (u.error) throw u.error;
    } else {
      var i = await sb.from('members').insert({ room_code: code, user_id: uid, name: me.name, role: me.role, joined_at: Date.now(), voted: false, round: 0 });
      if (i.error) throw i.error;
    }
    await Promise.all([loadRoom(), loadMembers(), loadVotes()]);
    S.channel = sb.channel('poseidon-' + code + '-' + Math.random().toString(36).slice(2, 8))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms' }, function (p) {
        if (rowOf(p).code === S.code) loadRoom().then(loadVotes).then(onData).catch(function () {});
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'members' }, function (p) {
        if (rowOf(p).room_code === S.code) loadMembers().then(onData).catch(function () {});
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'votes' }, function (p) {
        if (rowOf(p).room_code === S.code) loadVotes().then(onData).catch(function () {});
      })
      .subscribe();
    S.poll = setInterval(function () { if (S.code) refreshAll().catch(function () {}); }, 8000);
    ls.set('pp-room', code); ls.set('pp-active', '1');
    show('room'); onData();
  }
  function exitLocal(msg) {
    teardown(); S.code = null; S.room = null; ls.del('pp-active'); closeLayers(); show('home');
    if (msg) homeErr(msg);
  }
  async function leave() {
    var code = S.code;
    try {
      await sb.from('votes').delete().eq('room_code', code).eq('user_id', uid);
      await sb.from('members').delete().eq('room_code', code).eq('user_id', uid);
    } catch (e) {}
    exitLocal('');
  }
  $('leaveBtn').addEventListener('click', leave);

  var raf = 0;
  function onData() { if (raf) return; raf = requestAnimationFrame(function () { raf = 0; effects(); render(); }); }
  function effects() {
    var r = S.room;
    if (!r) return;
    if (S.membersLoaded && !S.members.some(function (m) { return m.id === uid; })) { exitLocal('Você foi removido da sala pelo facilitador.'); return; }
    if (isHost() && r.autoReveal && !r.revealed && r.activeId && S.autoFor !== r.round) {
      var vs = voters();
      if (vs.length && vs.every(function (m) { return m.voted && m.round === r.round; })) { S.autoFor = r.round; doReveal(); }
    }
  }

  /* ---------- host writes ---------- */
  var COLS = { revealed: 'revealed', revealedAt: 'revealed_at', round: 'round', roundStartedAt: 'round_started_at', backlog: 'backlog', activeId: 'active_id' };
  function saveRoom(patch) {
    var row = {}; Object.keys(patch).forEach(function (k) { row[COLS[k]] = patch[k]; });
    S.q = S.q.then(async function () {
      var res = await sb.from('rooms').update(row).eq('code', S.code);
      if (res.error) throw res.error;
      await loadRoom(); await loadVotes(); onData();
    }).catch(function (e) { toast(dbMsg(e), true); });
    return S.q;
  }
  function cloneBacklog() { return JSON.parse(JSON.stringify(S.room.backlog || [])); }
  function doReveal() { saveRoom({ revealed: true, revealedAt: Date.now() }); }
  function newRound() {
    var bl = cloneBacklog(), a = bl.find(function (s) { return s.id === S.room.activeId; });
    if (a) a.rounds = (a.rounds || 0) + 1;
    saveRoom({ revealed: false, round: S.room.round + 1, roundStartedAt: Date.now(), revealedAt: null, backlog: bl });
  }
  function activate(id) {
    var r = S.room, bl = cloneBacklog();
    bl.forEach(function (s) {
      if (s.id === r.activeId && s.status === 'voting') s.status = 'pending';
      if (s.id === id) { s.status = 'voting'; s.rounds = (s.rounds || 0) + 1; }
    });
    saveRoom({ activeId: id, revealed: false, round: r.round + 1, roundStartedAt: Date.now(), revealedAt: null, backlog: bl });
  }
  function nextStory() {
    var r = S.room, bl = r.backlog || [], i = bl.findIndex(function (s) { return s.id === r.activeId; });
    var next = bl.slice(i + 1).concat(bl.slice(0, Math.max(i, 0))).find(function (s) { return s.status !== 'estimated' && s.id !== r.activeId; });
    if (!next) { toast('Não há mais histórias para estimar.'); openSummary(); return; }
    activate(next.id);
  }
  function nextId(bl) {
    var n = 0; bl.forEach(function (s) { var m = /^C-(\d+)$/.exec(s.id); if (m) n = Math.max(n, Number(m[1])); });
    return n + 1;
  }
  function addStories(items) {
    var r = S.room, bl = cloneBacklog(), n = nextId(bl), firstNew = null;
    items.forEach(function (it) { var s = { id: 'C-' + n++, title: it.title, url: it.url || '', status: 'pending', estimate: null, rounds: 0 }; if (!firstNew) firstNew = s; bl.push(s); });
    var patch = { backlog: bl };
    if (!r.activeId && firstNew) {
      firstNew.status = 'voting'; firstNew.rounds = 1;
      Object.assign(patch, { activeId: firstNew.id, revealed: false, round: r.round + 1, roundStartedAt: Date.now(), revealedAt: null });
    }
    saveRoom(patch);
  }
  function deleteStory(id) {
    var r = S.room, bl = cloneBacklog().filter(function (s) { return s.id !== id; }), patch = { backlog: bl };
    if (r.activeId === id) {
      var nx = bl.find(function (s) { return s.status !== 'estimated'; });
      if (nx) { nx.status = 'voting'; nx.rounds = (nx.rounds || 0) + 1; }
      Object.assign(patch, { activeId: nx ? nx.id : null, revealed: false, round: r.round + 1, roundStartedAt: Date.now(), revealedAt: null });
    }
    saveRoom(patch);
  }

  /* ---------- participant writes ---------- */
  async function castVote(ev) {
    ev.preventDefault();
    var r = S.room; if (!r || r.revealed || !story() || me.role === 'observer') return;
    var v = parseHours($('voteInput').value);
    if (v === null) { toast('Digite um valor entre 0,5 e 999 horas.', true); return; }
    $('voteBtn').disabled = true;
    try {
      var a = await sb.from('votes').upsert({ room_code: S.code, user_id: uid, round: r.round, story_id: r.activeId, value: v }, { onConflict: 'room_code,user_id' });
      if (a.error) throw a.error;
      var b = await sb.from('members').update({ voted: true, round: r.round }).eq('room_code', S.code).eq('user_id', uid);
      if (b.error) throw b.error;
      $('voteInput').value = fmt(v); toast('Voto registrado');
      await Promise.all([loadVotes(), loadMembers()]);
    } catch (e) { toast(dbMsg(e), true); }
    finally { $('voteBtn').disabled = false; onData(); }
  }
  $('voteForm').addEventListener('submit', castVote);
  $('presets').innerHTML = ['0,5', '1', '2', '3', '4', '6', '8', '12'].map(function (p) { return '<button type="button" data-v="' + p + '">' + p + 'h</button>'; }).join('');
  $('presets').addEventListener('click', function (e) { var b = e.target.closest('button[data-v]'); if (b) $('voteInput').value = b.getAttribute('data-v'); });
  $('finalInput').addEventListener('input', function () { S.finalTouched = true; });
  $('finalForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var v = parseHours($('finalInput').value), a = story();
    if (v === null || !a) { toast('Digite um valor entre 0,5 e 999 horas.', true); return; }
    var bl = cloneBacklog(); bl.forEach(function (s) { if (s.id === a.id) { s.status = 'estimated'; s.estimate = v; } });
    saveRoom({ backlog: bl }).then(function () { toast('Estimativa final: ' + fmt(v) + ' h'); });
  });

  /* ---------- render ---------- */
  function tick() {
    var r = S.room, el = $('timer'); if (!r || !el) return;
    var end = r.revealed && r.revealedAt ? r.revealedAt : Date.now();
    var s = Math.max(0, Math.floor((end - (r.roundStartedAt || end)) / 1000));
    el.textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }
  function render() {
    var r = S.room;
    if (!r) { if (S.code && S.roomLoaded) exitLocal('Sala não encontrada.'); return; }
    $('chipCode').textContent = r.name;
    $('blCount').textContent = (r.backlog || []).length;
    renderStory(); renderSeats(); renderFinal(); renderVote(); tick();
    if (!$('blLayer').hidden) renderBacklog();
    if (!$('sumLayer').hidden) renderSummary();
  }
  function renderStory() {
    var r = S.room, a = story(), host = isHost(), h = '';
    if (!a) {
      h = '<div class="empty"><h2>' + (host ? 'Adicione a primeira história' : 'Aguardando a primeira história') + '</h2><p>' +
        (host ? 'Cole uma lista de cards ou adicione um por vez. O primeiro entra em votação automaticamente.' : 'O facilitador ainda não colocou nenhum card em votação.') + '</p>' +
        (host ? '<div class="grp" style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary" data-a="add">Nova história</button><button class="btn" data-a="bulk">Importar lista</button></div>' : '') + '</div>';
    } else {
      var voted = voters().filter(function (m) { return m.voted && m.round === r.round; }).length;
      h = '<div class="row1"><span class="tag">História atual · rodada ' + (a.rounds || 1) + '</span><span class="timer" id="timer">00:00</span></div>' +
        '<h2>' + esc(a.title) + '</h2><div class="meta"><span class="mono">' + esc(a.id) + '</span>' +
        (a.url ? '<a href="' + esc(a.url) + '" target="_blank" rel="noopener noreferrer">Abrir card ↗</a>' : '') + '</div>';
      if (host) {
        h += '<div class="actions"><div class="grp">' +
          (r.revealed ? '<button class="btn gold" data-a="again">Nova votação</button>' : '<button class="btn primary" data-a="reveal">Revelar votos (' + voted + '/' + voters().length + ')</button>') +
          '</div><div class="grp"><button class="btn" data-a="next">Próxima história →</button></div></div>';
      }
    }
    $('storyPanel').innerHTML = h;
  }
  function renderSeats() {
    var r = S.room, vs = currentVotes(), st = stats(vs), spread = st && vs.length > 1 && st.max > st.min;
    var mem = S.members.slice().sort(function (a, b) { return a.id === r.hostId ? -1 : b.id === r.hostId ? 1 : (a.joinedAt || 0) - (b.joinedAt || 0); });
    var host = isHost(), html = '';
    mem.forEach(function (m) {
      var obs = m.role === 'observer', voted = m.voted && m.round === r.round, sv = vs.find(function (v) { return v.id === m.id; });
      var face, cls;
      if (obs) { cls = 'obs'; face = 'Observa'; }
      else if (r.revealed) {
        if (sv) { cls = 'shown'; face = '<b>' + fmt(sv.value) + '</b><small>h</small>' + (spread && sv.value === st.min ? '<span class="flag lo">Menor</span>' : '') + (spread && sv.value === st.max ? '<span class="flag hi">Maior</span>' : ''); }
        else if (voted) { cls = 'wait'; face = '···'; }
        else { cls = 'none'; face = 'Sem voto'; }
      } else if (voted) { cls = 'sealed'; face = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>Votou'; }
      else { cls = 'wait'; face = 'Aguardando'; }
      var role = m.id === r.hostId ? 'Facilitador' : obs ? 'Observador' : 'Participante';
      html += '<li class="seat"><div class="card ' + cls + '">' + face + '</div><div class="who"><span class="av" style="background:hsl(' + hue(m.id) + ' 55% 42%)">' + esc((m.name || '?').charAt(0).toUpperCase()) + '</span><span class="nm" title="' + esc(m.name) + '">' + esc(m.name) + (m.id === uid ? ' (você)' : '') + '</span></div><span class="rl">' + role + '</span>' +
        (host && m.id !== uid ? '<button class="rm" type="button" data-rm="' + esc(m.id) + '" aria-label="Remover ' + esc(m.name) + '">remover</button>' : '') + '</li>';
    });
    $('seats').innerHTML = html;
    var nv = voters(), done = nv.filter(function (m) { return m.voted && m.round === r.round; }).length;
    $('voteCount').textContent = story() ? done + ' de ' + nv.length + ' votaram' : '';
    var el = $('stats');
    if (r.revealed && st) {
      el.hidden = false;
      el.innerHTML = '<div class="c-mean"><span>Média</span><b>' + fmt(st.mean) + 'h</b></div><div class="c-med"><span>Mediana</span><b>' + fmt(st.median) + 'h</b></div><div class="c-lo"><span>Menor voto</span><b>' + fmt(st.min) + 'h</b></div><div class="c-hi"><span>Maior voto</span><b>' + fmt(st.max) + 'h</b></div><div><span>Consenso</span><span class="pill ' + st.cons[1] + '">' + st.cons[0] + '</span></div>';
    } else { el.hidden = true; }
  }
  function renderFinal() {
    var r = S.room, a = story(), st = stats(currentVotes()), vis = isHost() && r.revealed && a;
    $('finalBar').hidden = !vis;
    if (!vis) return;
    if (S.finalRound !== r.round) { S.finalRound = r.round; S.finalTouched = false; }
    if (!S.finalTouched) $('finalInput').value = a.estimate != null && a.status === 'estimated' ? fmt(a.estimate) : st ? fmt(st.half) : '';
    $('finalBtn').textContent = a.status === 'estimated' ? 'Atualizar (' + fmt(a.estimate) + 'h)' : 'Confirmar';
  }
  function renderVote() {
    var r = S.room, a = story(), obs = me.role === 'observer', mv = myVote(), mine = mv && mv.round === r.round;
    var open = !!a && !r.revealed && !obs;
    $('voteForm').hidden = !open;
    if (S.panelRound !== r.round) { S.panelRound = r.round; $('voteInput').value = mine ? fmt(mv.value) : ''; }
    var note;
    if (obs) note = 'Você entrou como observador e não vota.';
    else if (!a) note = 'Aguardando uma história em votação.';
    else if (r.revealed) note = mine ? 'Votação encerrada. Seu voto: ' + fmt(mv.value) + ' h.' : 'Votação encerrada.';
    else if (mine) note = 'Voto enviado e escondido. Você pode alterar até a revelação.';
    else note = 'Seu voto fica oculto para os outros até o facilitador revelar.';
    $('voteNote').textContent = note;
    $('voteBtn').textContent = mine ? 'Atualizar voto' : 'Confirmar voto';
  }
  function renderBacklog() {
    var r = S.room, host = isHost(), bl = r.backlog || [];
    $('blHostBar').hidden = !host;
    $('blList').innerHTML = bl.length ? bl.map(function (s) {
      var pill = s.status === 'estimated' ? '<span class="st est">' + fmt(s.estimate) + ' h</span>' : s.status === 'voting' ? '<span class="st vot">Em votação</span>' : '<span class="st">Pendente</span>';
      return '<li class="bl' + (s.id === r.activeId ? ' on' : '') + (host ? ' hostable' : '') + '" data-id="' + esc(s.id) + '"><div class="r1"><span class="id">' + esc(s.id) + '</span><span class="ctl">' + pill +
        (host ? '<button type="button" data-act="edit">editar</button><button type="button" class="del" data-act="del">excluir</button>' : '') + '</span></div><h4>' + esc(s.title) + '</h4></li>';
    }).join('') : '<li class="muted">Nenhuma história ainda.</li>';
  }
  function totals() {
    var bl = S.room.backlog || [], tot = 0, n = 0;
    bl.forEach(function (s) { if (s.estimate != null && s.status === 'estimated') { tot += Number(s.estimate); n++; } });
    return { tot: tot, n: n, all: bl.length };
  }
  function renderSummary() {
    var t = totals(), bl = S.room.backlog || [];
    $('sumTotal').textContent = fmt(t.tot) + ' h';
    $('sumCounts').textContent = t.n + ' de ' + t.all + ' histórias estimadas';
    $('sumBody').innerHTML = bl.length ? bl.map(function (s) {
      return '<tr><td class="mono">' + esc(s.id) + '</td><td>' + esc(s.title) + '</td><td class="num">' + (s.rounds || 0) + '</td><td class="num">' + (s.status === 'estimated' ? fmt(s.estimate) + ' h' : '–') + '</td></tr>';
    }).join('') : '<tr><td colspan="4" class="muted">Nenhuma história no backlog.</td></tr>';
  }
  function openSummary() { renderSummary(); openLayer('sumLayer'); }

  /* ---------- events: room ---------- */
  $('storyPanel').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-a]'); if (!b || !isHost()) return;
    var a = b.getAttribute('data-a');
    if (a === 'reveal') doReveal(); else if (a === 'again') newRound(); else if (a === 'next') nextStory();
    else if (a === 'add') openStoryForm(null); else if (a === 'bulk') openLayer('bulkLayer');
  });
  var armT = null;
  $('seats').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-rm]'); if (!b || !isHost()) return;
    if (!b.hasAttribute('data-armed')) { b.setAttribute('data-armed', '1'); b.textContent = 'confirmar'; clearTimeout(armT); armT = setTimeout(function () { b.removeAttribute('data-armed'); b.textContent = 'remover'; }, 3000); return; }
    var id = b.getAttribute('data-rm');
    (async function () {
      try {
        var v = await sb.from('votes').delete().eq('room_code', S.code).eq('user_id', id); if (v.error) throw v.error;
        var m = await sb.from('members').delete().eq('room_code', S.code).eq('user_id', id); if (m.error) throw m.error;
        await Promise.all([loadMembers(), loadVotes()]); onData(); toast('Participante removido');
      } catch (er) { toast(dbMsg(er), true); }
    })();
  });
  $('blBtn').addEventListener('click', function () { renderBacklog(); openLayer('blLayer'); });
  $('sumBtn').addEventListener('click', openSummary);
  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-close]')) closeLayers();
    else if (e.target.classList && e.target.classList.contains('layer')) closeLayers();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeLayers(); });
  $('copyBtn').addEventListener('click', function () {
    var name = S.room ? S.room.name : '';
    var done = function () { toast('Nome da sala copiado: ' + name); };
    try { navigator.clipboard.writeText(name).then(done, function () { toast('Nome da sala: ' + name); }); } catch (e) { toast('Nome da sala: ' + name); }
  });
  function openStoryForm(st) {
    S.editing = st ? st.id : null;
    $('storyH').textContent = st ? 'Editar história' : 'Nova história';
    $('stTitle').value = st ? st.title : ''; $('stUrl').value = st ? (st.url || '') : ''; $('stErr').textContent = '';
    openLayer('storyLayer'); $('stTitle').focus();
  }
  $('addStoryBtn').addEventListener('click', function () { openStoryForm(null); });
  $('bulkBtn').addEventListener('click', function () { $('bulkText').value = ''; openLayer('bulkLayer'); $('bulkText').focus(); });
  $('storyForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var title = $('stTitle').value.trim(), url = $('stUrl').value.trim();
    if (!title) { $('stErr').textContent = 'Informe o título do card.'; return; }
    if (url && !/^https?:\/\//i.test(url)) { $('stErr').textContent = 'O link precisa começar com http:// ou https://'; return; }
    if (S.editing) {
      var bl = cloneBacklog(); bl.forEach(function (s) { if (s.id === S.editing) { s.title = title; s.url = url; } });
      saveRoom({ backlog: bl });
    } else addStories([{ title: title, url: url }]);
    closeLayers();
  });
  $('bulkForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var items = $('bulkText').value.split('\n').map(function (l) { return l.trim(); }).filter(Boolean).slice(0, 200).map(function (t) { return { title: t.slice(0, 160) }; });
    if (!items.length) return;
    addStories(items); closeLayers(); toast(items.length + ' histórias importadas');
  });
  $('blList').addEventListener('click', function (e) {
    var li = e.target.closest('li.bl'); if (!li || !isHost()) return;
    var id = li.getAttribute('data-id'), act = e.target.closest('button[data-act]');
    var s = (S.room.backlog || []).find(function (x) { return x.id === id; }); if (!s) return;
    if (act && act.getAttribute('data-act') === 'edit') openStoryForm(s);
    else if (act && act.getAttribute('data-act') === 'del') deleteStory(id);
    else if (id !== S.room.activeId) { activate(id); closeLayers(); }
  });
  $('csvBtn').addEventListener('click', function () {
    if (!S.room) return;
    var q = function (v) { return '"' + String(v).replace(/"/g, '""') + '"'; };
    var rows = [['ID', 'Título', 'Link', 'Horas finais', 'Rodadas'].map(q).join(';')];
    (S.room.backlog || []).forEach(function (s) { rows.push([q(s.id), q(s.title), q(s.url || ''), s.status === 'estimated' ? fmt(s.estimate) : '', s.rounds || 0].join(';')); });
    rows.push([q(''), q('TOTAL'), q(''), fmt(totals().tot), ''].join(';'));
    saveFile('poseidon-' + S.code.toLowerCase() + '.csv', '﻿' + rows.join('\r\n'));
  });

  /* ---------- boot ---------- */
  function connErr(msg) { var b = $('connBanner'); b.hidden = false; b.textContent = msg; }
  async function boot() {
    show('home');
    if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) { connErr('Falta configurar o Supabase. Preencha supabaseUrl e supabaseAnonKey no arquivo config.js (passo 3 do README).'); return; }
    if (!window.supabase || !window.supabase.createClient) { connErr('Não foi possível carregar a biblioteca do Supabase. Verifique a conexão e recarregue.'); return; }
    try {
      sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
      var s = await sb.auth.getSession(), session = s.data && s.data.session;
      if (!session) {
        var r = await sb.auth.signInAnonymously();
        if (r.error) { connErr('Não foi possível entrar. No Supabase, ative o login anônimo em Authentication, Sign In / Providers, Anonymous Sign-Ins (passo 2 do README).'); return; }
        session = r.data.session;
      }
      uid = session.user.id;
    } catch (e) { connErr('Não foi possível conectar ao Supabase. Confira a URL e a chave no config.js.'); return; }
    ready = true; $('createBtn').disabled = false; $('joinBtn').disabled = false;
    if (ls.get('pp-active') === '1' && me.name && ls.get('pp-room')) {
      try {
        var ex = await sb.from('rooms').select('code').eq('code', ls.get('pp-room')).maybeSingle();
        if (ex.data) await enterRoom(ls.get('pp-room')); else ls.del('pp-active');
      } catch (e) { ls.del('pp-active'); }
    }
  }
  boot();
})();
