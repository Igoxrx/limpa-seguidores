(() => {
  const PROFILE_WIN = 'limpa-seguidores-perfil';
  const ACTION_WIN = 'limpa-seguidores-acao';
  // não mostra o painel nas janelas que a própria extensão abre
  if (window.__limpaSeguidores || window.name === PROFILE_WIN || window.name === ACTION_WIN) return;
  window.__limpaSeguidores = true;

  const APP_ID = '936619743392459'; // id público do app web do Instagram
  const API = 'https://www.instagram.com/api/v1';
  const MIN_DELAY_MS = 5000;  // intervalo mínimo entre duas remoções
  const JITTER_MS = 3000;     // variação aleatória somada ao intervalo
  const PAUSE_EVERY = 50;     // sugere uma pausa a cada N remoções
  const API_PAUSE_MS = 6 * 60 * 60 * 1000;         // tempo sem consultas depois de um bloqueio
  const FOLLOWING_CACHE_MS = 24 * 60 * 60 * 1000;  // validade da lista de quem você segue

  const state = {
    myId: null,
    queue: [],
    seen: new Set(),
    index: 0,
    nextMaxId: null,
    hasMore: true,
    loadP: null,
    busy: false,
    blocked: false,
    reviewed: {},      // pk -> 'kept' | 'removed'
    removedNow: 0,
    lastRemoveAt: 0,
    details: {},
    autoProfile: false,
    alsoUnfollow: true,
    domMode: false,    // lista lida da tela em vez da API
    onlyNotFollowing: false,
    fetchDetails: false,  // números de cada perfil: 1 a 2 consultas por card
    apiPausedUntil: 0,
    fileMode: false,      // lista vinda dos arquivos baixados do Instagram
    fileFollowers: [],
    fileFollowing: null,  // Set de @ em minúsculas
    profileWin: null,
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function cookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  function wwwClaim() {
    try { return sessionStorage.getItem('www-claim-v2') || '0'; } catch (_) { return '0'; }
  }

  // depois de um bloqueio, nenhuma consulta sai até o fim da pausa (insistir prolonga o bloqueio)
  function pauseApi() {
    state.apiPausedUntil = Date.now() + API_PAUSE_MS;
    chrome.storage.local.set({ apiPausedUntil: state.apiPausedUntil });
  }

  async function api(path, opts = {}) {
    if (Date.now() < state.apiPausedUntil) {
      const paused = new Error('consultas em pausa');
      paused.rate = true;
      throw paused;
    }
    const url = path.startsWith('https://') ? path : API + path;
    const res = await fetch(url, {
      credentials: 'include',
      ...opts,
      headers: {
        'x-ig-app-id': APP_ID,
        'x-csrftoken': cookie('csrftoken') || '',
        'x-ig-www-claim': wwwClaim(),
        'x-asbd-id': '129477',
        'x-requested-with': 'XMLHttpRequest',
        ...(opts.headers || {}),
      },
    });
    const text = await res.text().catch(() => '');
    let data = null;
    try { data = JSON.parse(text); } catch (_) { /* resposta não é JSON */ }
    if (!res.ok || !data || data.status === 'fail') {
      console.warn('[Limpa Seguidores] resposta inesperada', res.status, url, text.slice(0, 300));
      const msg = (data && data.message) || (data ? 'HTTP ' + res.status : 'resposta inesperada (HTTP ' + res.status + ')');
      const err = new Error(msg);
      // quando bloqueia a conta por excesso, o Instagram às vezes devolve a página do site (HTML) em vez dos dados
      const htmlInstead = res.ok && !data && /^\s*<!doctype html/i.test(text);
      err.rate = res.status === 429 || htmlInstead ||
        !!(data && (data.spam || data.message === 'feedback_required' || data.feedback_title));
      err.auth = res.status === 401 || res.status === 403 || (data && data.message === 'login_required');
      err.status = res.status;
      if (err.rate) pauseApi();
      throw err;
    }
    return data;
  }

  // ---------- dados ----------

  async function getMyId() {
    const id = cookie('ds_user_id');
    if (id) return id;
    const username = prompt('Não consegui identificar sua conta. Digite seu @ do Instagram:');
    if (!username) throw new Error('Conta não identificada.');
    const d = await api('/users/web_profile_info/?username=' + encodeURIComponent(username.replace('@', '').trim()));
    return d.data.user.id;
  }

  const storageKey = () => 'reviewed_' + state.myId;
  const cursorKey = () => 'cursor_' + state.myId;
  const importKey = () => 'imported_' + state.myId;

  async function loadReviewed() {
    const data = await chrome.storage.local.get([storageKey(), cursorKey(), importKey()]);
    state.reviewed = data[storageKey()] || {};
    state.nextMaxId = data[cursorKey()] || null; // retoma na página onde parou, sem repassar as anteriores
    applyImport(data[importKey()]);
  }

  // ---------- arquivos baixados em "Baixar suas informações" do Instagram ----------

  const NOT_USERNAMES = new Set(['accounts', 'explore', 'p', 'reel', 'reels', 'stories', 'direct', 'about', 'legal', 'developer', '_u', '_n']);

  // funciona para JSON e HTML: pega os @ dos links e dos campos "value" e "title"
  function extractUsernames(text) {
    const names = new Set();
    const patterns = [
      /instagram\.com\\?\/(?:_u\\?\/)?([A-Za-z0-9._]+)/g,
      /"value"\s*:\s*"([A-Za-z0-9._]+)"/g,
      /"title"\s*:\s*"([A-Za-z0-9._]+)"/g,
    ];
    for (const re of patterns) {
      for (const m of text.matchAll(re)) {
        const name = m[1].toLowerCase();
        if (!NOT_USERNAMES.has(name)) names.add(name);
      }
    }
    return names;
  }

  function fileKind(name, text) {
    const base = name.toLowerCase();
    if (/^following[._]/.test(base) || text.includes('relationships_following')) return 'following';
    if (/^followers(_\d+)?\./.test(base)) return 'followers';
    return null;
  }

  function applyImport(imported) {
    state.fileFollowers = imported && imported.followers ? imported.followers : [];
    state.fileFollowing = imported && imported.following ? new Set(imported.following) : null;
    state.fileMode = state.fileFollowers.length > 0;
  }

  async function importFiles(files) {
    if (!state.myId) state.myId = await getMyId();
    const found = { followers: new Set(), following: new Set() };
    const ignored = [];
    for (const file of files) {
      const text = await file.text();
      const kind = fileKind(file.name, text);
      if (!kind) { ignored.push(file.name); continue; }
      for (const name of extractUsernames(text)) found[kind].add(name);
    }
    if (!found.followers.size && !found.following.size) {
      setMsg('Esses arquivos não são as listas de seguidores. Escolha followers_1 e following, da pasta followers_and_following.', 'err');
      return;
    }
    // arquivo de um tipo só não apaga o que já foi carregado do outro tipo
    const saved = (await chrome.storage.local.get(importKey()))[importKey()] || {};
    const imported = {
      followers: found.followers.size ? [...found.followers] : saved.followers,
      following: found.following.size ? [...found.following] : saved.following,
    };
    chrome.storage.local.set({ [importKey()]: imported });
    applyImport(imported);
    Object.assign(state, { queue: [], seen: new Set(), index: 0, nextMaxId: null, hasMore: true, blocked: false });
    $('#domBtn').hidden = true;
    setMsg(ignored.length ? 'Ignorei: ' + ignored.join(', ') : '');
    render();
  }

  function fetchFromFile() {
    for (const username of state.fileFollowers) {
      const pk = 'u:' + username;
      if (state.seen.has(pk) || state.reviewed[pk]) continue;
      state.seen.add(pk);
      const iFollow = state.fileFollowing ? state.fileFollowing.has(username) : undefined;
      if (state.onlyNotFollowing && iFollow === true) continue;
      state.queue.push({ username, full_name: '', profile_pic_url: '', pk, fromDom: true, fromFile: true, iFollow });
    }
    state.hasMore = false;
  }

  function saveReviewed() {
    chrome.storage.local.set({ [storageKey()]: state.reviewed });
  }

  function fetchMore() {
    if (!state.loadP) state.loadP = doFetchMore().finally(() => { state.loadP = null; });
    return state.loadP;
  }

  async function doFetchMore() {
    if (state.fileMode) return fetchFromFile();
    if (state.domMode) return fetchFromDom();
    let added = 0;
    let tries = 0;
    while (state.hasMore && added === 0 && tries < 20) {
      tries++;
      const qs = new URLSearchParams({ count: '25', search_surface: 'follow_list_page' });
      if (state.nextMaxId) qs.set('max_id', state.nextMaxId);
      chrome.storage.local.set({ [cursorKey()]: state.nextMaxId });
      let d;
      try {
        d = await api('/friendships/' + state.myId + '/followers/?' + qs);
      } catch (e) {
        if (e.rate || !state.nextMaxId) throw e;
        state.nextMaxId = null; // a posição salva expirou: volta ao início
        continue;
      }
      const fresh = [];
      for (const u of d.users || []) {
        const pk = String(u.pk ?? u.pk_id ?? u.id);
        if (state.reviewed[pk] || state.seen.has(pk)) continue;
        state.seen.add(pk);
        fresh.push({ ...u, pk });
      }
      if (state.onlyNotFollowing) await markFollowing(fresh);
      for (const u of fresh) {
        if (state.onlyNotFollowing && u.iFollow === true) continue;
        state.queue.push(u);
        added++;
      }
      state.nextMaxId = d.next_max_id || null;
      state.hasMore = !!d.next_max_id;
      if (added === 0 && state.hasMore) await sleep(3000 + Math.random() * 2000);
    }
  }

  // carrega (uma vez por sessão) todo mundo que você segue; null se o Instagram não entregar
  let followingSetP = null;
  function getFollowingSet() {
    if (!followingSetP) followingSetP = loadFollowingSet();
    return followingSetP;
  }

  async function loadFollowingSet() {
    const key = 'following_' + state.myId;
    const cached = (await chrome.storage.local.get(key))[key];
    if (cached && Date.now() - cached.at < FOLLOWING_CACHE_MS) return new Set(cached.pks);
    const set = new Set();
    let maxId = null;
    try {
      do {
        const qs = new URLSearchParams({ count: '100' });
        if (maxId) qs.set('max_id', maxId);
        const d = await api('/friendships/' + state.myId + '/following/?' + qs);
        for (const u of d.users || []) set.add(String(u.pk ?? u.pk_id ?? u.id));
        maxId = d.next_max_id || null;
        setMsg('Carregando a lista de quem você segue… ' + set.size);
        if (maxId) await sleep(2000 + Math.random() * 2000);
      } while (maxId);
      chrome.storage.local.set({ [key]: { at: Date.now(), pks: [...set] } });
      return set;
    } catch (e) {
      // lista incompleta marcaria gente errada: fica sem filtro até recarregar a página, sem insistir
      console.warn('[Limpa Seguidores] não consegui carregar quem você segue', e.status, e.message);
      return null;
    }
  }

  // marca em cada pessoa se você a segue (u.iFollow)
  async function markFollowing(users) {
    if (!users.length) return;
    if (state.fileFollowing) {
      for (const u of users) u.iFollow = state.fileFollowing.has(u.username.toLowerCase());
      return;
    }
    const following = await getFollowingSet();
    // sem essa informação, mostra todo mundo em vez de esconder alguém por engano
    if (following) for (const u of users) u.iFollow = following.has(u.pk);
  }

  const DETAIL_SOURCES = [
    async (u) => {
      if (u.fromDom) throw new Error('sem id numérico'); // veio da tela, só temos o @
      const d = (await api('/users/' + u.pk + '/info/')).user;
      return {
        posts: d.media_count,
        followers: d.follower_count,
        following: d.following_count,
        bio: d.biography,
        externalUrl: d.external_url,
        picHd: d.hd_profile_pic_url_info?.url,
      };
    },
    async (u) => {
      const d = (await api('/users/web_profile_info/?username=' + encodeURIComponent(u.username))).data.user;
      return {
        posts: d.edge_owner_to_timeline_media?.count,
        followers: d.edge_followed_by?.count,
        following: d.edge_follow?.count,
        bio: d.biography,
        externalUrl: d.external_url,
        picHd: d.profile_pic_url_hd,
      };
    },
  ];
  const DETAILS_OFF_MSG = 'O Instagram limitou as consultas, então parei de buscar os números até você recarregar a página — abra o perfil (P).';
  let detailsOff = false;

  // tenta cada endpoint do site e devolve os dados num formato único
  async function loadDetails(u) {
    let last;
    for (const source of DETAIL_SOURCES) {
      try {
        return await source(u);
      } catch (e) {
        console.warn('[Limpa Seguidores] detalhes falharam para', u.username, e.status, e.message);
        last = e;
        if (e.rate) break; // se uma fonte está bloqueada, a outra também vai estar
      }
    }
    throw last;
  }

  function getDetails(u) {
    if (detailsOff) return Promise.resolve({ error: DETAILS_OFF_MSG });
    if (!state.details[u.pk]) {
      state.details[u.pk] = loadDetails(u).catch((e) => {
        delete state.details[u.pk]; // tenta de novo na próxima vez que o card aparecer
        if (e.rate) {
          // os números são opcionais: para de pedir de vez, para não piorar o bloqueio da lista
          detailsOff = true;
          return { error: DETAILS_OFF_MSG };
        }
        return { error: e.message };
      });
    }
    return state.details[u.pk];
  }

  function fakeSignals(u, d) {
    const s = [];
    if (u.has_anonymous_profile_picture) s.push('Sem foto de perfil');
    if (!u.full_name && !u.fromFile) s.push('Sem nome'); // o arquivo só traz o @
    if (/\d{4,}/.test(u.username)) s.push('Muitos números no @');
    if (d && !d.error) {
      const posts = d.posts ?? 0;
      const followers = d.followers ?? 0;
      const following = d.following ?? 0;
      if (posts === 0) s.push('Nenhuma publicação');
      else if (posts < 3) s.push('Quase nenhuma publicação');
      if (!d.bio) s.push('Sem bio');
      if (following > 1000 && followers < 150) s.push('Segue muita gente e quase ninguém segue de volta');
      else if (following > 300 && following > followers * 10) s.push('Segue 10x mais do que é seguido');
      if (d.externalUrl && posts < 3) s.push('Link na bio sem conteúdo');
    }
    return s;
  }

  // ---------- interface ----------

  const host = document.createElement('div');
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: -apple-system, "Segoe UI", Roboto, sans-serif; }
      #launch { position: fixed; top: 14px; right: 14px; z-index: 2147483646; padding: 9px 14px;
        border: 0; border-radius: 999px; background: #0095f6; color: #fff; font-size: 14px; font-weight: 600;
        cursor: pointer; box-shadow: 0 4px 14px rgba(0,0,0,.25); }
      #launch:hover { background: #1877f2; }
      #overlay { position: fixed; inset: 0; z-index: 2147483647; background: rgba(0,0,0,.6);
        display: flex; align-items: center; justify-content: center; padding: 16px; }
      #overlay[hidden] { display: none; }
      .panel { width: 100%; max-width: 400px; max-height: 100%; overflow: auto; background: #fff; color: #111;
        border-radius: 16px; box-shadow: 0 20px 60px rgba(0,0,0,.4); }
      header { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid #eee; }
      header strong { font-size: 15px; }
      #progress { flex: 1; color: #777; font-size: 13px; }
      #close { border: 0; background: none; font-size: 18px; cursor: pointer; color: #555; }
      #body { padding: 20px 16px 8px; text-align: center; min-height: 360px; }
      #pic { width: 110px; height: 110px; border-radius: 50%; object-fit: cover; background: #eee; display: block; margin: 0 auto 10px; }
      #uname { font-size: 18px; font-weight: 700; color: #111; text-decoration: none; }
      #uname:hover { text-decoration: underline; }
      #fname { color: #555; font-size: 14px; margin-top: 2px; }
      #profile { margin-top: 8px; padding: 6px 14px; border-radius: 8px; border: 1px solid #0095f6;
        background: #fff; color: #0095f6; font-size: 13px; font-weight: 600; cursor: pointer; }
      #profile:hover { background: #eef6ff; }
      #domBtn { margin-top: 12px; padding: 10px 16px; border: 0; border-radius: 10px; background: #0095f6;
        color: #fff; font-size: 14px; font-weight: 600; cursor: pointer; }
      #domBtn[hidden] { display: none; }
      .auto { display: flex; align-items: center; gap: 6px; padding: 0 16px 8px; font-size: 13px; color: #333; cursor: pointer; }
      #badges { margin-top: 6px; display: flex; gap: 6px; justify-content: center; flex-wrap: wrap; }
      .badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: #f0f0f0; color: #444; }
      .badge.removed { background: #fde2e2; color: #b42318; }
      .badge.kept { background: #dcfce7; color: #166534; }
      #stats { display: flex; justify-content: center; gap: 22px; margin: 14px 0 8px; }
      #stats b { display: block; font-size: 16px; }
      #stats span { font-size: 12px; color: #777; }
      #bio { font-size: 13px; color: #333; white-space: pre-line; max-height: 60px; overflow: auto; margin-bottom: 10px; }
      #risk { display: inline-block; font-size: 12px; font-weight: 700; padding: 4px 10px; border-radius: 8px; }
      #risk.low { background: #dcfce7; color: #166534; }
      #risk.mid { background: #fef3c7; color: #92400e; }
      #risk.high { background: #fde2e2; color: #b42318; }
      #risk.none { background: #f0f0f0; color: #444; }
      #signals { list-style: none; padding: 0; margin: 8px 0 0; font-size: 13px; color: #444; }
      #signals li::before { content: "• "; color: #d97706; font-weight: 700; }
      #msg { min-height: 20px; font-size: 13px; margin-top: 10px; color: #555; }
      #msg.ok { color: #166534; } #msg.err { color: #b42318; font-weight: 600; }
      footer { display: flex; gap: 8px; padding: 12px 16px; }
      footer button { flex: 1; padding: 11px 6px; border-radius: 10px; border: 1px solid #ddd; background: #fafafa;
        font-size: 14px; font-weight: 600; cursor: pointer; color: #111; }
      footer button:disabled { opacity: .45; cursor: default; }
      #remove { background: #ed4956; border-color: #ed4956; color: #fff; }
      #keep { background: #111; border-color: #111; color: #fff; }
      .foot { display: flex; justify-content: space-between; align-items: center; padding: 0 16px 12px; font-size: 12px; color: #777; }
      .link { border: 0; background: none; color: #0095f6; cursor: pointer; font-size: 12px; padding: 0; }
      #card[hidden] { display: none; }
    </style>
    <button id="launch">Revisar seguidores</button>
    <div id="overlay" hidden>
      <div class="panel">
        <header>
          <strong>Limpa Seguidores</strong>
          <span id="progress"></span>
          <button id="close" title="Fechar (Esc)">✕</button>
        </header>
        <div id="body">
          <div id="card" hidden>
            <img id="pic" alt="">
            <a id="uname" target="_blank" rel="noopener"></a>
            <div id="fname"></div>
            <button id="profile" title="Tecla P">Ver perfil (P)</button>
            <div id="badges"></div>
            <div id="stats">
              <div><b id="posts">–</b><span>posts</span></div>
              <div><b id="followers">–</b><span>seguidores</span></div>
              <div><b id="following">–</b><span>seguindo</span></div>
            </div>
            <div id="bio"></div>
            <div id="risk"></div>
            <ul id="signals"></ul>
          </div>
          <div id="msg"></div>
          <button id="domBtn" hidden>Carregar a lista pela janela auxiliar</button>
        </div>
        <footer>
          <button id="back" title="Seta para a esquerda">← Voltar</button>
          <button id="keep" title="Seta para cima">Manter ↑</button>
          <button id="remove" title="Seta para a direita">Remover →</button>
        </footer>
        <div class="auto">
          <button id="importBtn" class="link">Usar arquivos baixados do Instagram</button>
          <span id="importInfo"></span>
          <input type="file" id="importFile" multiple accept=".json,.html" hidden>
        </div>
        <label class="auto"><input type="checkbox" id="onlyNot"> Mostrar só quem eu não sigo</label>
        <label class="auto"><input type="checkbox" id="details"> Buscar os números de cada perfil (gasta mais consultas)</label>
        <label class="auto"><input type="checkbox" id="unfollow"> Ao remover, também deixar de seguir (se eu sigo)</label>
        <label class="auto"><input type="checkbox" id="auto"> Abrir o perfil de cada pessoa numa janela ao lado</label>
        <div class="foot">
          <span id="counter"></span>
          <button id="reset" class="link">Recomeçar do zero</button>
        </div>
      </div>
    </div>`;

  const $ = (sel) => root.querySelector(sel);
  const overlay = $('#overlay');
  const fmt = (n) => (n == null ? '–' : Number(n).toLocaleString('pt-BR'));

  function setMsg(text, kind = '') {
    const el = $('#msg');
    el.textContent = text;
    el.className = kind;
  }

  function current() {
    return state.queue[state.index];
  }

  let picToken = 0;
  // tenta cada URL direto; se a imagem for bloqueada, pede ao service worker da extensão para baixá-la
  function showPic(urls) {
    const my = ++picToken;
    const list = urls.filter(Boolean);
    const img = $('#pic');
    const tryNext = (i) => {
      if (my !== picToken) return;
      if (i >= list.length) {
        img.onerror = null;
        img.removeAttribute('src');
        return;
      }
      img.onerror = async () => {
        if (my !== picToken) return;
        const data = await chrome.runtime.sendMessage({ type: 'img', url: list[i] }).catch(() => null);
        if (my !== picToken) return;
        if (!data) return tryNext(i + 1);
        img.onerror = () => tryNext(i + 1);
        img.src = data;
      };
      img.src = list[i];
    };
    tryNext(0);
  }

  const profileUrl = (u) => 'https://www.instagram.com/' + encodeURIComponent(u.username) + '/';

  function openProfile(focus = true) {
    const u = current();
    if (!u) return;
    const url = profileUrl(u);
    const win = state.profileWin;
    if (win && !win.closed) {
      if (win.location.href !== url) win.location.href = url;
      if (focus) win.focus();
    } else {
      const w = 480;
      const left = (screen.availLeft || 0) + screen.availWidth - w;
      state.profileWin = window.open(url, PROFILE_WIN,
        `popup=yes,width=${w},height=${screen.availHeight - 40},left=${left},top=${screen.availTop || 0}`);
      if (!state.profileWin) {
        setMsg('O navegador bloqueou a janela do perfil. Permita pop-ups para o instagram.com.', 'err');
        return;
      }
    }
    verifyInProfile(u, renderToken);
  }

  // lê o botão do perfil já aberto: 'yes' se você segue, 'no' se não, null se ainda não carregou
  function readProfileFollow(win, username) {
    if (win.location.pathname.toLowerCase().replace(/\/?$/, '/') !== '/' + username.toLowerCase() + '/') return null;
    const main = win.document.querySelector('main');
    if (!main) return null;
    const btn = buttonsIn(main).find(hasText(/^(seguindo|following|seguir|follow|seguir de volta|follow back|solicitado|requested)$/i));
    if (!btn) return null;
    return isFollowingButton(btn) ? 'yes' : 'no';
  }

  // o perfil é a palavra final sobre quem você segue, e olhar para ele não gasta consulta
  async function verifyInProfile(u, my) {
    if (u.iFollow === true) return;
    const answer = await waitFor(() => readProfileFollow(state.profileWin, u.username), 12000, 400);
    if (!answer) return;
    u.iFollow = answer === 'yes';
    if (my !== renderToken || current() !== u || state.busy || !u.iFollow) return;
    if (state.onlyNotFollowing) setMsg(`Pulei @${u.username}: você já segue.`);
    render();
  }

  function updateChrome() {
    const u = current();
    const status = u && state.reviewed[u.pk];
    $('#back').disabled = state.busy || state.index === 0;
    $('#keep').disabled = state.busy || !u;
    $('#remove').disabled = state.busy || state.blocked || !u || status === 'removed';
    $('#progress').textContent = state.queue.length
      ? `${Math.min(state.index + 1, state.queue.length)} de ${state.queue.length}${state.hasMore ? '+' : ''}`
      : '';
    $('#counter').textContent =
      `Removidos agora: ${state.removedNow} · Revisados no total: ${Object.keys(state.reviewed).length}`;
    const parts = [];
    if (state.fileFollowers.length) parts.push(fmt(state.fileFollowers.length) + ' seguidores');
    if (state.fileFollowing) parts.push(fmt(state.fileFollowing.size) + ' seguindo');
    $('#importInfo').textContent = parts.length ? parts.join(' · ') : '(recomendado: não gasta consultas)';
  }

  function fillSignals(u, d) {
    const s = fakeSignals(u, d);
    const risk = $('#risk');
    if (s.length >= 4) { risk.textContent = 'Muito provável que seja fake'; risk.className = 'high'; }
    else if (s.length >= 2) { risk.textContent = 'Suspeito'; risk.className = 'mid'; }
    else if (!d) { risk.textContent = 'Avaliando…'; risk.className = 'none'; }
    else if (d.error) { risk.textContent = 'Sem dados para avaliar — veja o perfil'; risk.className = 'none'; }
    else { risk.textContent = 'Parece uma conta real'; risk.className = 'low'; }
    const ul = $('#signals');
    ul.replaceChildren(...s.map((t) => Object.assign(document.createElement('li'), { textContent: t })));
  }

  let renderToken = 0;

  async function render() {
    const my = ++renderToken;
    updateChrome();

    if (state.index >= state.queue.length) {
      if (state.hasMore) {
        $('#card').hidden = true;
        setMsg('Carregando seguidores…');
        try {
          await fetchMore();
        } catch (e) {
          handleError(e);
          return;
        }
        if (my !== renderToken) return;
        setMsg('');
        return render();
      }
      $('#card').hidden = true;
      setMsg('Pronto! Você revisou todos os seus seguidores.', 'ok');
      updateChrome();
      return;
    }

    const u = current();
    if (state.onlyNotFollowing && u.iFollow === true && state.reviewed[u.pk] !== 'removed') {
      state.index++; // filtro ligado: pula quem você segue
      return render();
    }
    $('#card').hidden = false;
    showPic([u.profile_pic_url]);
    const link = $('#uname');
    link.textContent = '@' + u.username;
    link.href = 'https://www.instagram.com/' + encodeURIComponent(u.username) + '/';
    $('#fname').textContent = u.full_name || (u.fromFile ? '' : '(sem nome)');

    const badges = [];
    if (u.is_private) badges.push(['Privado', '']);
    if (u.is_verified) badges.push(['Verificado', '']);
    if (u.iFollow === true) badges.push(['Você segue', 'kept']);
    if (u.iFollow === false) badges.push(['Você não segue', '']);
    if (u.iFollow == null && state.onlyNotFollowing) badges.push(['Não sei se você segue', 'removed']);
    if (state.reviewed[u.pk] === 'removed') badges.push(['Já removido', 'removed']);
    $('#badges').replaceChildren(...badges.map(([t, c]) =>
      Object.assign(document.createElement('span'), { textContent: t, className: 'badge ' + c })));

    $('#posts').textContent = $('#followers').textContent = $('#following').textContent = '…';
    $('#bio').textContent = '';
    fillSignals(u, null);

    if (state.autoProfile) openProfile(false);

    if (!state.fetchDetails) {
      $('#posts').textContent = $('#followers').textContent = $('#following').textContent = '–';
      fillSignals(u, { error: 'números desligados' });
      return;
    }

    const d = await getDetails(u);
    if (my !== renderToken) return;
    if (!d.error) {
      $('#posts').textContent = fmt(d.posts);
      $('#followers').textContent = fmt(d.followers);
      $('#following').textContent = fmt(d.following);
      $('#bio').textContent = d.bio || '';
      showPic([d.picHd, u.profile_pic_url]);
    } else {
      $('#posts').textContent = $('#followers').textContent = $('#following').textContent = '?';
      $('#bio').textContent = 'Não consegui carregar os detalhes: ' + d.error;
    }
    fillSignals(u, d);
  }

  function handleError(e) {
    if (e.rate && !state.domMode && !state.queue[state.index]) {
      // a lista não carregou pela API: oferece ler direto da tela
      setMsg('O Instagram limitou as consultas da sua conta, então a extensão parou de fazer consultas por até 6 horas para não piorar. ' +
        'Dá para continuar lendo a lista direto da tela, numa janela auxiliar:', 'err');
      $('#domBtn').hidden = false;
    } else if (e.rate) {
      state.blocked = true;
      setMsg('O Instagram limitou as ações da sua conta. Pare por algumas horas antes de continuar — seu progresso está salvo.', 'err');
    } else if (e.auth) {
      setMsg('Sessão inválida. Entre na sua conta do Instagram e recarregue a página.', 'err');
    } else {
      setMsg('Erro: ' + e.message, 'err');
    }
    updateChrome();
  }

  function keepCurrent() {
    const u = current();
    if (!u || state.busy) return;
    if (state.reviewed[u.pk] !== 'removed') {
      state.reviewed[u.pk] = 'kept';
      saveReviewed();
    }
    state.index++;
    setMsg('');
    render();
  }

  function goBack() {
    if (state.busy || state.index === 0) return;
    state.index--;
    const u = current();
    if (state.reviewed[u.pk] === 'kept') {
      delete state.reviewed[u.pk]; // permite decidir de novo
      saveReviewed();
    }
    setMsg('');
    render();
  }

  // ---------- remoção pela própria tela do Instagram ----------
  // Uma janela auxiliar fica aberta na sua lista de seguidores; a extensão busca a pessoa ali e
  // clica em "Remover" e na confirmação, exatamente como você faria à mão.

  let actionWin = null;

  // precisa ser chamada direto no clique/tecla, senão o navegador bloqueia a janela
  function ensureActionWindow() {
    if (actionWin && !actionWin.closed) return actionWin;
    actionWin = window.open('', ACTION_WIN, 'popup=yes,width=420,height=700,left=0,top=0');
    return actionWin;
  }

  async function getMyUsername() {
    const key = 'username_' + state.myId;
    const saved = (await chrome.storage.local.get(key))[key];
    if (saved) return saved;
    let name = null;
    try { name = (await api('/users/' + state.myId + '/info/')).user.username; } catch (_) { /* pergunta abaixo */ }
    if (!name) name = (prompt('Qual é o seu @ do Instagram? (só vou perguntar uma vez)') || '').replace('@', '').trim();
    if (!name) throw new Error('preciso do seu @ para abrir sua lista de seguidores');
    chrome.storage.local.set({ [key]: name });
    return name;
  }

  async function waitFor(fn, timeout, step = 250) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      try {
        const r = fn();
        if (r) return r;
      } catch (_) { /* página ainda carregando */ }
      await sleep(step);
    }
    return null;
  }

  const hasText = (re) => (el) => re.test((el.textContent || '').trim());
  const isRemoveButton = hasText(/^(remover|remove)$/i);
  const isFollowingButton = hasText(/^(seguindo|following)$/i);
  const isUnfollowButton = hasText(/^(deixar de seguir|unfollow)$/i);
  const buttonsIn = (el) => [...el.querySelectorAll('button, div[role="button"]')];
  const leafTexts = (el) => [...el.querySelectorAll('*')].filter((n) => !n.children.length).map((n) => (n.textContent || '').trim());

  // digita no campo do jeito que o React do Instagram reconhece
  function typeInto(win, input, value) {
    const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new win.Event('input', { bubbles: true }));
  }

  const LIST_NAMES = { followers: 'seguidores', following: 'quem você segue' };

  // clique completo (pressionar + soltar + clique), como o de um mouse de verdade
  function realClick(el) {
    const opts = { bubbles: true, cancelable: true, button: 0 };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.click();
  }

  // acha no seu perfil o link "seguidores" ou "seguindo"
  function findListLink(win, me, kind) {
    const path = ('/' + me + '/' + kind + '/').toLowerCase();
    const byHref = [...win.document.querySelectorAll('a[href]')].find((a) => {
      try {
        return new URL(a.getAttribute('href'), 'https://www.instagram.com').pathname.toLowerCase().replace(/\/?$/, '/') === path;
      } catch (_) {
        return false;
      }
    });
    if (byHref) return byHref;
    // sem o endereço: procura um link curto com o texto "seguidores"/"seguindo" (ex.: "2.743 seguidores")
    const re = kind === 'followers' ? /seguidores|followers/i : /seguindo|following/i;
    const main = win.document.querySelector('main') || win.document.body;
    return [...main.querySelectorAll('a, [role="link"], [role="button"]')]
      .find((el) => !el.closest('div[role="dialog"]') && (el.textContent || '').length < 40 && re.test(el.textContent || '')) || null;
  }

  function closeDialog(win, input) {
    const dialog = input.closest('div[role="dialog"]');
    const svg = dialog && dialog.querySelector('svg[aria-label="Fechar"], svg[aria-label="Close"]');
    const btn = svg && (svg.closest('button, [role="button"]') || svg);
    if (btn) realClick(btn);
    else win.history.back();
  }

  // descobre qual lista uma janelinha mostra pelo título dela ("Seguidores" ou "Seguindo")
  function dialogKind(dialog) {
    const texts = leafTexts(dialog);
    if (texts.some((t) => /^(seguidores|followers)$/i.test(t))) return 'followers';
    if (texts.some((t) => /^(seguindo|following)$/i.test(t))) return 'following';
    return null;
  }

  // campos de busca das listas abertas, com o tipo de cada uma
  function openLists(win) {
    return [...win.document.querySelectorAll('div[role="dialog"] input')]
      .map((input) => ({ input, kind: dialogKind(input.closest('div[role="dialog"]')) }));
  }

  // abre "seguidores" ou "seguindo" do seu perfil na janela auxiliar e devolve o campo de busca
  async function openList(win, me, kind) {
    const profile = ('/' + me + '/').toLowerCase();
    const here = () => win.location.pathname.toLowerCase().replace(/\/?$/, '/');
    const ready = () => {
      const lists = openLists(win);
      const wanted = lists.find((l) => l.kind === kind);
      if (wanted) return wanted.input;
      // título não reconhecido, mas o endereço confirma a lista certa
      if (lists.length && lists[0].kind === null && here() === profile + kind + '/') return lists[0].input;
      return null;
    };

    try {
      const input = ready();
      if (input) return input;
    } catch (_) { /* janela nova */ }

    let onProfile = false;
    try { onProfile = here().startsWith(profile); } catch (_) { /* janela nova */ }
    if (!onProfile) {
      win.location.href = 'https://www.instagram.com/' + me + '/';
      await sleep(1500);
    }

    setMsg('Abrindo sua lista de ' + LIST_NAMES[kind] + ' na janela auxiliar… (se demorar, clique nela você mesmo)');
    const end = Date.now() + 40000;
    let lastTry = 0;
    let attempt = 0;
    while (Date.now() < end) {
      try {
        const input = ready();
        if (input) return input;
        if (win.document.readyState === 'complete' && Date.now() - lastTry > 4000) {
          const other = openLists(win).find((l) => l.kind && l.kind !== kind);
          if (other) {
            // só fecha quando tem certeza de que é a outra lista
            closeDialog(win, other.input);
            lastTry = Date.now() - 3200;
          } else if (!openLists(win).length) {
            // cada tentativa usa um jeito diferente de abrir a lista, até um funcionar
            const path = profile + kind + '/';
            const link = findListLink(win, me, kind);
            const way = attempt % 3;
            if (way === 0 && link) {
              realClick(link);
            } else if (way === 1) {
              // troca o endereço sem recarregar, como o próprio site faz ao clicar no link
              win.history.pushState({}, '', path);
              win.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
            } else if (way === 2 && link) {
              link.focus();
              link.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
              link.click();
            }
            attempt++;
            lastTry = Date.now();
          }
        }
      } catch (_) { /* página ainda carregando */ }
      await sleep(250);
    }
    throw new Error('não consegui abrir sua lista de ' + LIST_NAMES[kind] + ' na janela auxiliar');
  }

  // ---------- lista de seguidores lida da tela (quando a API está bloqueada) ----------

  // linhas já carregadas na janelinha de seguidores: @, nome e foto
  function collectDomRows(dialog) {
    const out = [];
    const seenHere = new Set();
    for (const a of dialog.querySelectorAll('a[href]')) {
      let path;
      try { path = new URL(a.getAttribute('href'), 'https://www.instagram.com').pathname; } catch (_) { continue; }
      const m = path.match(/^\/([A-Za-z0-9._]+)\/?$/);
      if (!m || seenHere.has(m[1].toLowerCase())) continue;
      // a linha é o menor bloco em volta do @ que tem exatamente um botão "Remover"
      let row = null;
      for (let el = a.parentElement; el && el !== dialog; el = el.parentElement) {
        const n = buttonsIn(el).filter(isRemoveButton).length;
        if (n === 1) { row = el; break; }
        if (n > 1) break;
      }
      if (!row) continue;
      const username = m[1];
      seenHere.add(username.toLowerCase());
      const texts = leafTexts(row).filter((t) => t && t !== '·' &&
        !/^(remover|remove|seguir|follow)$/i.test(t) && t.toLowerCase() !== username.toLowerCase());
      const img = row.querySelector('img');
      // quem você não segue aparece com um "Seguir" ao lado do nome
      const iFollow = !leafTexts(row).some((t) => /^(seguir|follow)$/i.test(t));
      out.push({ username, full_name: texts[0] || '', profile_pic_url: img ? img.src : '', iFollow });
    }
    return out;
  }

  // rola a lista até o fim para o Instagram carregar mais gente; devolve a altura atual
  function scrollList(win, dialog) {
    const box = [...dialog.querySelectorAll('div')].find((d) =>
      d.scrollHeight > d.clientHeight + 20 && /(auto|scroll)/.test(win.getComputedStyle(d).overflowY));
    if (!box) return 0;
    box.scrollTop = box.scrollHeight;
    return box.scrollHeight;
  }

  async function fetchFromDom() {
    const win = actionWin;
    if (!win || win.closed) throw new Error('a janela auxiliar foi fechada. Clique em "Carregar a lista pela janela auxiliar" de novo.');
    const me = await getMyUsername();
    const input = await openList(win, me, 'followers');
    if (input.value) {
      typeInto(win, input, '');
      await sleep(1500);
    }
    const dialog = input.closest('div[role="dialog"]');
    setMsg('Lendo sua lista de seguidores na janela auxiliar…');
    await waitFor(() => collectDomRows(dialog).length, 15000);

    let added = 0;
    let idle = 0;
    let lastHeight = 0;
    while (added < 30 && idle < 4) {
      const rows = collectDomRows(dialog);
      for (const r of rows) {
        const pk = 'u:' + r.username.toLowerCase();
        if (state.seen.has(pk)) continue;
        state.seen.add(pk);
        if (state.reviewed[pk]) continue;
        if (state.fileFollowing && state.fileFollowing.has(r.username.toLowerCase())) r.iFollow = true;
        if (state.onlyNotFollowing && r.iFollow) continue;
        state.queue.push({ ...r, pk, fromDom: true });
        added++;
      }
      if (added >= 30) break;
      const height = scrollList(win, dialog);
      idle = height > lastHeight ? 0 : idle + 1; // a lista parou de crescer = chegou ao fim
      lastHeight = height;
      await sleep(1500 + Math.random() * 1000);
    }
    if (idle >= 4) state.hasMore = false;
    setMsg('');
  }

  // busca a pessoa na lista aberta e devolve a linha dela com o botão pedido
  async function findRow(win, input, username, isButton, timeout) {
    const dialog = input.closest('div[role="dialog"]');
    typeInto(win, input, username);
    const target = '/' + username.toLowerCase();
    return waitFor(() => {
      const link = [...dialog.querySelectorAll('a[href]')]
        .find((a) => a.getAttribute('href').replace(/\/$/, '').toLowerCase() === target);
      if (!link) return null;
      // sobe a partir do @ até achar a linha que tem o botão
      for (let el = link.parentElement; el && el !== dialog; el = el.parentElement) {
        const button = buttonsIn(el).find(isButton);
        if (button) return { row: el, button, dialog };
      }
      return null;
    }, timeout);
  }

  // clica no botão da caixa de confirmação que o Instagram abre por cima da lista
  async function clickConfirm(win, dialog, isButton) {
    const btn = await waitFor(() =>
      [...win.document.querySelectorAll('div[role="dialog"]')]
        .filter((d) => d !== dialog && !d.contains(dialog))
        .flatMap(buttonsIn)
        .find(isButton), 8000);
    if (btn) btn.click();
    return !!btn;
  }

  async function unfollow(u, win, me) {
    setMsg('Deixando de seguir @' + u.username + '…');
    const input = await openList(win, me, 'following');
    const found = await findRow(win, input, u.username, isFollowingButton, 8000);
    if (!found) {
      typeInto(win, input, '');
      return false; // não está na sua lista de "seguindo"
    }
    found.button.click();
    if (!(await clickConfirm(win, found.dialog, isUnfollowButton))) {
      throw new Error('o Instagram não mostrou a confirmação de deixar de seguir');
    }
    await waitFor(() => !found.button.isConnected || !isFollowingButton(found.button), 8000);
    typeInto(win, input, '');
    return true;
  }

  // devolve { unfollowed, warning }
  async function removeFollower(u, win) {
    if (!win || win.closed) throw new Error('a janela auxiliar foi fechada. Tente de novo.');
    const me = await getMyUsername();
    const input = await openList(win, me, 'followers');

    setMsg('Procurando @' + u.username + ' na sua lista…');
    const found = await findRow(win, input, u.username, isRemoveButton, 12000);
    if (!found) throw new Error('não achei @' + u.username + ' na sua lista de seguidores (talvez já não te siga)');
    // na lista de seguidores, quem você não segue aparece com um "Seguir" ao lado do nome
    const iFollow = !leafTexts(found.row).some((t) => /^(seguir|follow)$/i.test(t));

    found.button.click();
    if (!(await clickConfirm(win, found.dialog, isRemoveButton))) {
      throw new Error('o Instagram não mostrou a confirmação de remoção');
    }
    // o botão da linha some ou muda de texto quando a remoção é concluída
    const done = await waitFor(() => !found.button.isConnected || !isRemoveButton(found.button), 8000);
    typeInto(win, input, '');
    if (!done) throw new Error('cliquei em remover, mas não tive confirmação. Confira na janela auxiliar.');

    if (!state.alsoUnfollow || !iFollow) return { unfollowed: false, warning: null };
    await sleep(1500 + Math.random() * 1500);
    try {
      return { unfollowed: await unfollow(u, win, me), warning: null };
    } catch (e) {
      return { unfollowed: false, warning: 'Removi, mas não consegui deixar de seguir: ' + e.message };
    }
  }

  async function removeCurrent() {
    const u = current();
    if (!u || state.busy || state.blocked || state.reviewed[u.pk] === 'removed') return;
    const win = ensureActionWindow();
    if (!win) {
      setMsg('O navegador bloqueou a janela auxiliar. Permita pop-ups para o instagram.com.', 'err');
      return;
    }
    state.busy = true;
    updateChrome();
    try {
      const wait = state.lastRemoveAt + MIN_DELAY_MS + Math.random() * JITTER_MS - Date.now();
      if (wait > 0) {
        setMsg(`Aguardando ${Math.ceil(wait / 1000)}s para não chamar a atenção do Instagram…`);
        await sleep(wait);
      }
      setMsg('Removendo…');
      const result = await removeFollower(u, win);
      state.lastRemoveAt = Date.now();
      state.reviewed[u.pk] = 'removed';
      saveReviewed();
      state.removedNow++;
      if (result.warning) setMsg(result.warning, 'err');
      else setMsg(`@${u.username} não te segue mais${result.unfollowed ? ' e você deixou de seguir' : ''}.`, 'ok');
      state.index++;
      if (state.removedNow % PAUSE_EVERY === 0) {
        alert(`Você já removeu ${state.removedNow} seguidores nesta sessão.\n\nRecomendo dar uma pausa de pelo menos 1 hora para o Instagram não bloquear temporariamente suas ações.`);
      }
    } catch (e) {
      handleError(e);
    } finally {
      state.busy = false;
      render();
    }
  }

  async function open() {
    overlay.hidden = false;
    if (state.myId) return render();
    setMsg('Identificando sua conta…');
    try {
      state.myId = await getMyId();
      await loadReviewed();
      render();
    } catch (e) {
      handleError(e);
    }
  }

  function close() {
    overlay.hidden = true;
  }

  function reset() {
    if (!state.myId || state.busy) return;
    if (!confirm('Apagar o histórico de quem você já revisou e começar do primeiro seguidor?')) return;
    state.reviewed = {};
    saveReviewed();
    Object.assign(state, { queue: [], seen: new Set(), index: 0, nextMaxId: null, hasMore: true, blocked: false });
    setMsg('');
    render();
  }

  $('#launch').addEventListener('click', open);
  $('#close').addEventListener('click', close);
  $('#keep').addEventListener('click', keepCurrent);
  $('#remove').addEventListener('click', removeCurrent);
  $('#back').addEventListener('click', goBack);
  $('#reset').addEventListener('click', reset);
  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', (e) => {
    const files = [...e.target.files];
    e.target.value = ''; // permite escolher os mesmos arquivos de novo
    if (files.length) importFiles(files).catch(handleError);
  });
  $('#domBtn').addEventListener('click', () => {
    if (!ensureActionWindow()) {
      setMsg('O navegador bloqueou a janela auxiliar. Permita pop-ups para o instagram.com.', 'err');
      return;
    }
    Object.assign(state, { domMode: true, blocked: false, hasMore: true });
    $('#domBtn').hidden = true;
    setMsg('');
    render();
  });
  $('#profile').addEventListener('click', () => openProfile());
  $('#uname').addEventListener('click', (e) => { e.preventDefault(); openProfile(); });
  $('#auto').addEventListener('change', (e) => {
    state.autoProfile = e.target.checked;
    chrome.storage.local.set({ autoProfile: state.autoProfile });
    if (state.autoProfile) openProfile(false);
  });
  $('#unfollow').addEventListener('change', (e) => {
    state.alsoUnfollow = e.target.checked;
    chrome.storage.local.set({ alsoUnfollow: state.alsoUnfollow });
  });
  $('#onlyNot').addEventListener('change', (e) => {
    state.onlyNotFollowing = e.target.checked;
    chrome.storage.local.set({ onlyNotFollowing: state.onlyNotFollowing });
    if (!state.myId || state.busy) return; // vale para as próximas pessoas carregadas
    // recarrega a fila com o filtro novo (o histórico de revisados continua)
    Object.assign(state, { queue: [], seen: new Set(), index: 0, nextMaxId: null, hasMore: true });
    setMsg('');
    render();
  });
  $('#details').addEventListener('change', (e) => {
    state.fetchDetails = e.target.checked;
    chrome.storage.local.set({ fetchDetails: state.fetchDetails });
    if (state.myId && !state.busy) render();
  });
  chrome.storage.local.get(['autoProfile', 'alsoUnfollow', 'onlyNotFollowing', 'fetchDetails', 'apiPausedUntil']).then((d) => {
    state.apiPausedUntil = d.apiPausedUntil || 0;
    state.fetchDetails = !!d.fetchDetails;
    $('#details').checked = state.fetchDetails;
    state.onlyNotFollowing = !!d.onlyNotFollowing;
    $('#onlyNot').checked = state.onlyNotFollowing;
    state.autoProfile = !!d.autoProfile;
    $('#auto').checked = state.autoProfile;
    state.alsoUnfollow = d.alsoUnfollow !== false;
    $('#unfollow').checked = state.alsoUnfollow;
  });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  function onKey(e) {
    if (overlay.hidden || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.composedPath()[0];
    if (t && (/^(INPUT|TEXTAREA)$/.test(t.tagName) || t.isContentEditable)) return;
    const k = e.key.toLowerCase();
    if (e.repeat && (k === 'arrowright' || k === 'arrowup')) { e.preventDefault(); return; } // segurar a tecla não dispara várias vezes
    if (k === 'arrowright') removeCurrent();
    else if (k === 'arrowup') keepCurrent();
    else if (k === 'arrowleft') goBack();
    else if (k === 'p') openProfile();
    else if (k === 'escape') close();
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  document.addEventListener('keydown', onKey, true);
})();
