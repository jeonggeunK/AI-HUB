'use strict';
const fs = require('fs');
const path = require('path');
const { app, WebContentsView, Menu, Notification, dialog, session } = require('electron');
const { spawn } = require('child_process');
const { loginWithBrowser, findBrowser, hasSession } = require('./browserLogin');
const { SERVICES, byId } = require('./services');
const { setupSession, attachGuards, closeAllPopups } = require('./security');
const { broadcast } = require('./broadcast');
const { validateFiles } = require('./attach');
const store = require('./store');
const updater = require('./updater');

const TOP_BAR = 48;
const BAR_MIN = 80;
const PANE_MIN = 120; // 입력창을 키워도 웹페이지 영역은 이만큼 남긴다
const GAP = 2;
const SIDEBAR_W = 272;
const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

class Hub {
  /**
   * @param {import('electron').BaseWindow} win
   * @param {WebContentsView} uiView 상단바/동시 질문 바/설정 화면을 그리는 앱 UI
   * @param {{dev: boolean, onSettingsChanged: (keys: string[]) => void}} opts
   */
  constructor(win, uiView, opts) {
    this.win = win;
    this.ui = uiView;
    this.dev = opts.dev;
    this.onSettingsChanged = opts.onSettingsChanged || (() => {});
    this.views = new Map(); // accountId -> { view, serviceId, accountId }
    this.attached = new Set(); // 현재 창에 붙어 있는 accountId
    this.overlay = false;
    this.sending = false;
    this.accountLock = false;
    this.browserLoginTask = null; // { accountId, signal } — 진행 중인 "브라우저로 로그인"
    this.barHeight = 120; // 동시 질문 바의 실제 높이 — 렌더러가 측정해서 알려준다
    this.loginStatus = new Map(); // accountId -> true(로그인됨) / false(로그인 필요)
    this.navGen = new WeakMap(); // webContents -> 우리가 이동시킨 횟수 — 대화 주소 기록이 엉뚱한 대화를 잡지 않도록
    this.lastSide = 0;
    this.lastSignInWarn = 0;

    const st = this.state;
    if (st.settings.startupLayout !== 'remember') st.layout = st.settings.startupLayout;
    this.normalizeEnabled();
  }

  get state() {
    return store.get();
  }

  get settings() {
    return this.state.settings;
  }

  /** 사용자가 정한 탭 순서 */
  orderedIds() {
    return this.state.serviceOrder;
  }

  /** 설정에서 켜 둔 서비스 id (탭 순서대로) */
  enabledIds() {
    return this.orderedIds().filter((id) => this.settings.enabledServices.includes(id));
  }

  /** 서비스를 끄고 켠 뒤 활성 탭/분할/동시 질문 대상을 켜진 서비스 안으로 맞춘다 */
  normalizeEnabled() {
    const st = this.state;
    const ids = this.enabledIds();
    if (!ids.includes(st.activeService)) st.activeService = ids[0];
    st.splitServices = st.splitServices.filter((id) => ids.includes(id));
    if (st.splitServices.length === 0) st.splitServices = [...ids];
    st.broadcastTargets = st.broadcastTargets.filter((id) => ids.includes(id));
    if (st.broadcastTargets.length === 0) st.broadcastTargets = [...ids];
  }

  // ───────────── 계정/뷰 ─────────────

  findAccount(accountId) {
    for (const s of SERVICES) {
      const acc = this.state.accounts[s.id].find((a) => a.id === accountId);
      if (acc) return { serviceId: s.id, account: acc };
    }
    return null;
  }

  activeAccountId(serviceId) {
    return this.state.activeAccount[serviceId];
  }

  ensureView(accountId) {
    const existing = this.views.get(accountId);
    if (existing) return existing;

    const { serviceId, account } = this.findAccount(accountId);
    const svc = byId[serviceId];
    setupSession(session.fromPartition(account.partition), serviceId);

    const view = new WebContentsView({
      webPreferences: {
        partition: account.partition,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        spellcheck: false,
      },
    });
    view.setBackgroundColor('#ffffff');
    const wc = view.webContents;
    attachGuards(wc, serviceId, () => this.onSignInAttempt(accountId));

    const entry = { view, serviceId, accountId };
    this.views.set(accountId, entry);

    const notify = () => this.pushState();
    wc.on('did-start-loading', notify);
    wc.on('did-stop-loading', () => { notify(); this.checkLogin(accountId); });
    wc.on('dom-ready', () => this.checkLogin(accountId)); // 계속 로딩 중인 페이지(Gemini 등)도 표시되도록
    wc.on('did-navigate', notify);
    wc.on('did-navigate-in-page', notify);
    wc.on('did-finish-load', () => this.applyZoom(accountId));
    wc.on('focus', () => {
      // 동시 질문 중에는 포커스가 대상마다 옮겨 다니므로 활성 탭으로 기록하지 않는다
      if (!this.sending && this.state.activeService !== serviceId) {
        this.state.activeService = serviceId;
        store.save();
        this.pushState();
      }
    });
    wc.on('before-input-event', (e, input) => this.handleShortcut(e, input));
    wc.on('render-process-gone', (_e, details) => {
      if (details.reason !== 'clean-exit') this.toast(`${svc.name} 페이지가 비정상 종료되어 다시 불러옵니다.`, 'warn');
      setTimeout(() => !wc.isDestroyed() && wc.reload(), 500);
    });

    wc.loadURL(svc.url);
    return entry;
  }

  destroyView(accountId) {
    const entry = this.views.get(accountId);
    if (!entry) return;
    if (this.attached.has(accountId)) {
      // 창 종료(closed) 중에는 창이 이미 파괴돼 있으므로 떼어낼 필요 없이 webContents만 닫는다
      if (!this.win.isDestroyed()) this.win.contentView.removeChildView(entry.view);
      this.attached.delete(accountId);
    }
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
    this.views.delete(accountId);
  }

  destroyAll() {
    this.cancelBrowserLogin(); // 열려 있는 로그인용 브라우저도 닫힌다
    for (const id of [...this.views.keys()]) this.destroyView(id);
    closeAllPopups();
  }

  /** 동시 질문 전송 중에는 레이아웃/계정을 바꾸지 못하게 막는다 */
  busy() {
    if (this.sending) this.toast('동시 질문 전송 중에는 변경할 수 없습니다.', 'warn');
    return this.sending;
  }

  /** 시작 직후 활성 탭만 띄우고, 나머지 서비스는 잠시 뒤 백그라운드에서 미리 로드 */
  preloadOthers() {
    if (!this.settings.preloadAll) return;
    setTimeout(() => {
      if (this.win.isDestroyed()) return;
      for (const id of this.enabledIds()) this.ensureView(this.activeAccountId(id));
      this.pushState();
    }, 2000);
  }

  // ───────────── 레이아웃 ─────────────

  visibleServices() {
    const st = this.state;
    if (st.layout === 'split') return this.enabledIds().filter((id) => st.splitServices.includes(id));
    return [st.activeService];
  }

  /** 사이드바가 열려 있으면 그 폭 — 창이 좁으면 서비스 화면을 위해 자동으로 숨긴다 */
  sideWidth() {
    if (!this.state.sidebarOpen || this.win.isDestroyed()) return 0;
    return this.win.getContentSize()[0] >= 900 ? SIDEBAR_W : 0;
  }

  layout() {
    if (this.win.isDestroyed()) return;
    const [width, height] = this.win.getContentSize();
    this.ui.setBounds({ x: 0, y: 0, width, height });

    const top = TOP_BAR;
    const left = this.sideWidth();
    if (left !== this.lastSide) {
      this.lastSide = left;
      setImmediate(() => this.pushState()); // 창 크기 때문에 사이드바가 숨겨지거나 다시 보일 때
    }
    const bottom = this.state.broadcastOpen ? this.barHeight : 0;
    const paneH = Math.max(0, height - top - bottom);
    const areaW = Math.max(0, width - left);

    const wanted = this.visibleServices().map((sid) => this.activeAccountId(sid));

    for (const id of [...this.attached]) {
      if (!wanted.includes(id)) {
        const entry = this.views.get(id);
        if (entry) this.win.contentView.removeChildView(entry.view);
        this.attached.delete(id);
      }
    }

    const n = wanted.length;
    const paneW = Math.floor((areaW - GAP * (n - 1)) / n);
    wanted.forEach((id, i) => {
      const { view } = this.ensureView(id);
      if (!this.attached.has(id)) {
        this.win.contentView.addChildView(view);
        this.attached.add(id);
      }
      const x = left + i * (paneW + GAP);
      const w = i === n - 1 ? width - x : paneW;
      view.setBounds({ x, y: top, width: w, height: paneH });
    });

    if (this.overlay) this.win.contentView.addChildView(this.ui); // 오버레이 중엔 UI가 맨 위
  }

  barMax() {
    if (this.win.isDestroyed()) return 420;
    return Math.max(BAR_MIN, this.win.getContentSize()[1] - TOP_BAR - PANE_MIN);
  }

  /** 사용자가 드래그로 정한 입력창 높이를 저장 (null = 자동) */
  setComposerHeight(h) {
    this.state.composerHeight = Number.isFinite(h) ? Math.round(Math.min(this.barMax(), Math.max(BAR_MIN, h))) : null;
    store.save();
    this.pushState();
  }

  setBarHeight(h) {
    const next = Math.round(Math.min(this.barMax(), Math.max(BAR_MIN, h)));
    if (next === this.barHeight) return;
    this.barHeight = next;
    if (this.state.broadcastOpen) this.layout();
  }

  setOverlay(on) {
    this.overlay = !!on;
    if (this.win.isDestroyed()) return;
    if (this.overlay) {
      this.win.contentView.addChildView(this.ui);
      this.ui.webContents.focus();
    } else {
      // 서비스 뷰들을 다시 UI 위로 올린다
      for (const id of this.attached) this.win.contentView.addChildView(this.views.get(id).view);
      if (this.state.broadcastOpen) this.focusComposer();
      else this.focusActive();
    }
  }

  focusActive() {
    if (this.overlay) return; // 설정 화면이 떠 있으면 키 입력은 UI가 받아야 한다
    const entry = this.views.get(this.activeAccountId(this.state.activeService));
    if (entry && this.attached.has(entry.accountId)) entry.view.webContents.focus();
  }

  focusComposer() {
    this.ui.webContents.focus();
    this.ui.webContents.send('focus-broadcast');
  }

  activeWebContents() {
    const entry = this.views.get(this.activeAccountId(this.state.activeService));
    return entry ? entry.view.webContents : null;
  }

  // ───────────── 동작 ─────────────

  selectService(serviceId) {
    if (this.busy()) return;
    if (!this.enabledIds().includes(serviceId)) return;
    const st = this.state;
    st.activeService = serviceId;
    if (st.layout === 'split' && !st.splitServices.includes(serviceId)) st.splitServices.push(serviceId);
    store.save();
    this.layout();
    this.focusActive();
    this.pushState();
  }

  cycleService(step) {
    const ids = this.state.layout === 'split' ? this.visibleServices() : this.enabledIds();
    const i = ids.indexOf(this.state.activeService);
    this.selectService(ids[(i + step + ids.length) % ids.length]);
  }

  /** 탭의 ＋ 버튼: 그 서비스(현재 계정)만 새 대화로. 화면에 안 보이는 탭이면 그 탭으로 전환한다 */
  newChat(serviceId) {
    if (this.busy() || !this.enabledIds().includes(serviceId)) return;
    if (!this.visibleServices().includes(serviceId)) this.selectService(serviceId);
    const { view } = this.ensureView(this.activeAccountId(serviceId));
    this.bumpNav(view.webContents); // 진행 중인 대화 주소 기록이 새 대화를 잡지 않도록
    // 빠르게 여러 번 누르면 앞의 이동이 취소(ERR_ABORTED)되는데, 이는 정상이므로 무시
    view.webContents.loadURL(byId[serviceId].url).catch(() => {});
    if (this.state.activeService === serviceId) this.focusActive();
  }

  toggleLayout() {
    if (this.busy()) return;
    const st = this.state;
    st.layout = st.layout === 'split' ? 'single' : 'split';
    if (st.layout === 'split' && !st.splitServices.includes(st.activeService)) st.splitServices.push(st.activeService);
    store.save();
    this.layout();
    this.focusActive();
    this.pushState();
  }

  toggleBroadcast(force) {
    if (this.busy()) return;
    const st = this.state;
    st.broadcastOpen = typeof force === 'boolean' ? force : !st.broadcastOpen;
    store.save();
    this.layout();
    this.pushState();
    if (st.broadcastOpen) this.focusComposer();
    else this.focusActive();
  }

  /** 전역 단축키/트레이에서 "빠른 질문" — 입력창을 열고 포커스 */
  quickAsk() {
    if (this.overlay) return;
    if (!this.state.broadcastOpen) this.toggleBroadcast(true);
    else this.focusComposer();
  }

  nav(action) {
    if (this.busy()) return;
    const wc = this.activeWebContents();
    if (!wc) return;
    const h = wc.navigationHistory;
    if (action === 'back' && h.canGoBack()) h.goBack();
    else if (action === 'forward' && h.canGoForward()) h.goForward();
    else if (action === 'reload') wc.reload();
    else if (action === 'hard-reload') wc.reloadIgnoringCache();
    else if (action === 'home') wc.loadURL(byId[this.state.activeService].url);
  }

  zoom(direction) {
    if (this.busy()) return;
    const accountId = this.activeAccountId(this.state.activeService);
    const cur = this.state.zoom[accountId] || 1;
    let next = 1;
    if (direction !== 0) {
      const idx = ZOOM_STEPS.findIndex((z) => z >= cur - 0.001);
      const base = idx === -1 ? ZOOM_STEPS.length - 1 : idx;
      next = ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, base + direction))];
    }
    if (next === 1) delete this.state.zoom[accountId];
    else this.state.zoom[accountId] = next;
    store.save();
    this.applyZoom(accountId);
    this.pushState();
  }

  applyZoom(accountId) {
    const entry = this.views.get(accountId);
    if (entry && !entry.view.webContents.isDestroyed()) {
      entry.view.webContents.setZoomFactor(this.state.zoom[accountId] || 1);
    }
  }

  openNativeApp(serviceId) {
    const svc = byId[serviceId];
    if (!svc || !svc.nativeApp) return;
    try {
      const child = spawn('explorer.exe', [`shell:AppsFolder\\${svc.nativeApp.appId}`], { detached: true, stdio: 'ignore' });
      child.on('error', () => this.toast(`${svc.name} 데스크톱 앱을 실행하지 못했습니다.`, 'error'));
      child.unref();
    } catch {
      this.toast(`${svc.name} 데스크톱 앱을 실행하지 못했습니다.`, 'error');
    }
  }

  // ───────────── 설정 ─────────────

  openSettings(section) {
    if (this.busy()) return;
    this.setOverlay(true);
    this.ui.webContents.send('open-settings', { section: typeof section === 'string' ? section : 'general' });
  }

  /** 렌더러가 보낸 설정 변경. 검증을 통과한 키만 반영한다 */
  updateSettings(patch) {
    if (!patch || typeof patch !== 'object' || this.sending) return;
    const changed = [];
    for (const [key, value] of Object.entries(patch)) {
      const v = store.validateSetting(key, value);
      if (v === undefined || JSON.stringify(v) === JSON.stringify(this.settings[key])) continue;
      this.settings[key] = v;
      changed.push(key);
    }
    if (changed.length === 0) return;

    if (changed.includes('enabledServices')) {
      // 끈 서비스의 페이지는 닫아서 메모리를 돌려준다(로그인은 저장소에 남아 있음)
      for (const [accountId, entry] of [...this.views]) {
        if (!this.settings.enabledServices.includes(entry.serviceId)) this.destroyView(accountId);
      }
      this.normalizeEnabled();
      this.layout();
    }
    if (changed.includes('saveHistory') && !this.settings.saveHistory) this.state.history = [];
    store.save();
    this.onSettingsChanged(changed);
    this.pushState();
  }

  setBroadcastTargets(ids) {
    if (this.sending || !Array.isArray(ids)) return;
    const next = this.enabledIds().filter((id) => ids.includes(id));
    if (next.length === 0) return;
    this.state.broadcastTargets = next;
    store.save();
    this.pushState();
  }

  clearHistory() {
    this.state.history = [];
    store.save();
    this.pushState();
  }

  addHistory(prompt, fileNames = []) {
    if (!this.settings.saveHistory) return null;
    const st = this.state;
    const entry = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text: prompt.slice(0, store.HISTORY_TEXT_MAX), at: Date.now(), chats: {}, files: fileNames };
    st.history = [entry, ...st.history].slice(0, store.HISTORY_MAX);
    return entry;
  }

  bumpNav(wc) {
    this.navGen.set(wc, (this.navGen.get(wc) || 0) + 1);
  }

  deleteHistory(id) {
    const st = this.state;
    st.history = st.history.filter((h) => h.id !== id);
    store.save();
    this.pushState();
  }

  /**
   * 전송 후 각 서비스의 대화 주소(예: chatgpt.com/c/…)를 기록한다.
   * 답변이 시작돼야 주소가 바뀌므로 잠시 지켜보다가, 첫 화면 주소와 달라지면 저장한다.
   */
  async captureChats(entry, targets) {
    const pending = new Map(targets.map((t) => [t.serviceId, { ...t, gen: this.navGen.get(t.webContents) || 0 }]));
    for (let waited = 0; waited < 30000 && pending.size; waited += 1500) {
      if (waited) await new Promise((r) => setTimeout(r, 1500));
      if (this.win.isDestroyed() || !this.state.history.includes(entry)) return; // 기록이 지워졌으면 그만
      for (const [sid, { accountId, webContents, gen }] of [...pending]) {
        // 그 사이 다른 질문 전송·기록 열기로 이 탭을 옮겼다면 이 질문의 대화가 아니다
        if (webContents.isDestroyed() || (this.navGen.get(webContents) || 0) !== gen) { pending.delete(sid); continue; }
        const url = webContents.getURL();
        let home;
        try { home = new URL(byId[sid].url); } catch { continue; }
        let cur;
        try { cur = new URL(url); } catch { continue; }
        const isConversation = cur.hostname === home.hostname && cur.pathname !== home.pathname && cur.pathname !== '/';
        if (isConversation) {
          entry.chats[sid] = { accountId, url };
          pending.delete(sid);
        }
      }
      store.save();
      this.pushState();
    }
  }

  /** 기록을 누르면 그때 대화들을 각 계정으로 다시 연다 (분할 화면) */
  /**
   * 기록과 연결된 대화를 각 탭에서 다시 연다.
   * onlyService를 주면 그 서비스의 대화만(서비스 칩 클릭), 아니면 기록된 서비스 모두를 분할 화면으로.
   * @returns {{opened: number, capturing: boolean} | null}
   */
  async openHistory(id, onlyService) {
    if (this.busy()) return null;
    const entry = this.state.history.find((h) => h.id === id);
    if (!entry) return null;
    const st = this.state;
    let sids = this.enabledIds().filter((sid) => entry.chats[sid] && this.findAccount(entry.chats[sid].accountId));
    if (onlyService) sids = sids.filter((sid) => sid === onlyService);
    // 보낸 지 30초가 안 됐으면 대화 주소를 아직 기록하는 중일 수 있다
    if (sids.length === 0) return { opened: 0, capturing: Date.now() - entry.at < 30000 };

    const loads = [];
    for (const sid of sids) {
      const { accountId, url } = entry.chats[sid];
      st.activeAccount[sid] = accountId;
      const { view } = this.ensureView(accountId);
      this.bumpNav(view.webContents);
      if (view.webContents.getURL() !== url) {
        // 실패(오프라인·삭제된 대화 등)한 곳은 세어서 알려 준다
        loads.push(view.webContents.loadURL(url).then(() => null, (err) =>
          (err && err.code === 'ERR_ABORTED' ? null : byId[sid].name)));
      }
    }
    if (onlyService) {
      // 한 서비스만: 지금 레이아웃은 두고 그 탭을 보여 준다
      if (st.layout === 'split' && !st.splitServices.includes(onlyService)) st.splitServices.push(onlyService);
    } else {
      st.layout = sids.length > 1 ? 'split' : 'single';
      if (sids.length > 1) st.splitServices = sids;
    }
    st.activeService = sids[0];
    store.save();
    this.layout();
    this.focusActive();
    this.pushState();
    const failed = (await Promise.all(loads)).filter(Boolean);
    if (failed.length) this.toast(`${failed.join(', ')} 대화를 열지 못했습니다 (인터넷 연결 또는 삭제된 대화일 수 있음).`, 'error');
    return { opened: sids.length - failed.length, capturing: false, failed };
  }

  /** 켜 둔 모든 서비스(각 현재 계정)를 한 번에 새 대화로 */
  async newChatAll() {
    if (this.busy()) return;
    const loads = this.enabledIds().map((sid) => {
      const { view } = this.ensureView(this.activeAccountId(sid));
      this.bumpNav(view.webContents);
      // 빠르게 다시 눌러 앞의 이동이 취소된 것(ERR_ABORTED)은 실패가 아니다
      return view.webContents.loadURL(byId[sid].url).then(() => null, (err) =>
        (err && err.code === 'ERR_ABORTED' ? null : byId[sid].name));
    });
    this.focusActive();
    const failed = (await Promise.all(loads)).filter(Boolean);
    if (this.win.isDestroyed()) return;
    if (failed.length) this.toast(`${failed.join(', ')}에서 새 대화를 열지 못했습니다 (인터넷 연결을 확인하세요).`, 'error');
    else this.toast('모든 탭에서 새 대화를 열었습니다.', 'ok');
  }

  toggleSidebar(force) {
    const st = this.state;
    st.sidebarOpen = typeof force === 'boolean' ? force : !st.sidebarOpen;
    store.save();
    this.layout();
    this.pushState();
    if (st.sidebarOpen && this.sideWidth() === 0) this.toast('창이 좁아 기록을 표시할 수 없습니다. 창을 넓혀 주세요.', 'warn');
  }

  // ───────────── 탭 순서 · 처음 안내 ─────────────

  /** 드래그 앤 드롭으로 바꾼 탭 순서. 모든 서비스가 정확히 한 번씩 있어야 반영 */
  setServiceOrder(ids) {
    const all = SERVICES.map((s) => s.id);
    if (!Array.isArray(ids) || ids.length !== all.length || !all.every((id) => ids.includes(id))) return;
    this.state.serviceOrder = [...ids];
    this.state.splitServices = this.enabledIds().filter((id) => this.state.splitServices.includes(id));
    store.save();
    this.layout();
    this.pushState();
  }

  moveService(id, step) {
    const order = [...this.orderedIds()];
    const i = order.indexOf(id);
    const j = i + step;
    if (i === -1 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    this.setServiceOrder(order);
  }

  openWelcome() {
    if (this.sending) return;
    this.setOverlay(true);
    this.ui.webContents.send('open-welcome');
  }

  completeOnboarding(enabledServices) {
    this.state.onboarded = true;
    if (Array.isArray(enabledServices)) this.updateSettings({ enabledServices });
    store.save();
    this.pushState();
  }

  // ───────────── 계정 관리 ─────────────

  /** 설정 화면/메뉴에서 오는 계정 작업을 한곳에서 분기 */
  accountAction(action, id) {
    if (action === 'add') return this.addAccount(id);
    if (action === 'switch') {
      const found = this.findAccount(id);
      return found && this.switchAccount(found.serviceId, id);
    }
    if (action === 'reset') return this.resetAccount(id);
    if (action === 'remove') return this.removeAccount(id);
    if (action === 'native') return this.openNativeApp(id);
    if (action === 'browser-login') return this.browserLogin(id);
    if (action === 'browser-login-cancel') return this.cancelBrowserLogin();
    return undefined;
  }

  switchAccount(serviceId, accountId) {
    if (this.busy()) return;
    if (!this.state.accounts[serviceId].some((a) => a.id === accountId)) return;
    this.state.activeAccount[serviceId] = accountId;
    if (this.enabledIds().includes(serviceId)) this.state.activeService = serviceId;
    store.save();
    this.layout();
    this.focusActive();
    this.pushState();
  }

  addAccount(serviceId) {
    if (this.busy() || !byId[serviceId]) return;
    const list = this.state.accounts[serviceId];
    const suffix = Date.now().toString(36);
    const id = `${serviceId}-${suffix}`;
    let n = list.length + 1;
    while (list.some((a) => a.label === `계정 ${n}`)) n++;
    list.push({ id, label: `계정 ${n}`, partition: `persist:${serviceId}-${suffix}` });
    this.switchAccount(serviceId, id);
    this.toast(`${byId[serviceId].name}: "계정 ${n}" 탭이 열렸습니다. 이 탭에서 다른 계정으로 로그인하세요.`);
  }

  renameAccount(accountId, label) {
    const found = this.findAccount(accountId);
    const clean = String(label || '').trim().slice(0, 30);
    if (!found || !clean) return;
    found.account.label = clean;
    store.save();
    this.pushState();
  }

  /** 확인 창을 띄우는 계정 작업은 한 번에 하나만 — 두 삭제가 겹쳐 마지막 계정까지 지우는 일을 막는다 */
  async withAccountLock(fn) {
    if (this.accountLock) return;
    this.accountLock = true;
    try { await fn(); } finally { this.accountLock = false; }
  }

  removeAccount(accountId) {
    return this.withAccountLock(() => this.removeAccountUnlocked(accountId));
  }

  resetAccount(accountId) {
    return this.withAccountLock(() => this.resetAccountUnlocked(accountId));
  }

  async removeAccountUnlocked(accountId) {
    if (this.busy()) return;
    const found = this.findAccount(accountId);
    if (!found) return;
    const { serviceId, account } = found;
    const list = this.state.accounts[serviceId];
    if (list.length <= 1) {
      this.toast('마지막 계정은 삭제할 수 없습니다. "로그아웃"을 사용하세요.', 'warn');
      return;
    }
    const { response } = await dialog.showMessageBox(this.win, {
      type: 'warning',
      buttons: ['삭제', '취소'],
      defaultId: 1,
      cancelId: 1,
      title: '계정 삭제',
      message: `${byId[serviceId].name} — "${account.label}" 계정을 삭제할까요?`,
      detail: '이 계정의 로그인 정보와 사이트 데이터가 지워집니다.',
    });
    // 확인 창이 떠 있는 동안 상태가 바뀌었을 수 있으니 다시 확인
    if (response !== 0 || this.sending || this.win.isDestroyed()) return;
    const idx = list.findIndex((a) => a.id === accountId);
    if (idx === -1 || list.length <= 1) return;
    await this.stopBrowserLogin(accountId); // 진행 중인 가져오기가 지운 뒤에 쿠키를 넣지 못하게
    this.destroyView(accountId);
    list.splice(idx, 1);
    delete this.state.zoom[accountId];
    if (this.state.activeAccount[serviceId] === accountId) this.state.activeAccount[serviceId] = list[0].id;
    store.save();
    await clearPartition(account.partition);
    this.layout();
    this.pushState();
  }

  async resetAccountUnlocked(accountId) {
    if (this.busy()) return;
    const found = this.findAccount(accountId);
    if (!found) return;
    const { serviceId, account } = found;
    const { response } = await dialog.showMessageBox(this.win, {
      type: 'warning',
      buttons: ['로그아웃', '취소'],
      defaultId: 1,
      cancelId: 1,
      title: '로그아웃',
      message: `${byId[serviceId].name} — "${account.label}"에서 로그아웃할까요?`,
      detail: '이 계정의 쿠키와 사이트 데이터를 모두 지웁니다.',
    });
    if (response !== 0 || this.sending || this.win.isDestroyed() || !this.findAccount(accountId)) return;
    // 진행 중인 브라우저 로그인과 살아 있는 페이지가 쿠키를 다시 써넣지 못하도록 먼저 멈추고 닫은 뒤 지운다
    await this.stopBrowserLogin(accountId);
    this.destroyView(accountId);
    await clearPartition(account.partition);
    this.layout();
    this.pushState();
  }

  /** 로그인 쿠키가 있는지로 "로그인 필요" 표시를 갱신 (페이지 로드가 끝날 때마다) */
  async checkLogin(accountId) {
    const found = this.findAccount(accountId);
    if (!found) return;
    const cookies = await session.fromPartition(found.account.partition).cookies.get({}).catch(() => []);
    const ok = hasSession(found.serviceId, cookies);
    if (this.loginStatus.get(accountId) === ok) return;
    this.loginStatus.set(accountId, ok);
    if (!this.win.isDestroyed()) this.pushState();
  }

  // ───────────── 브라우저로 로그인 ─────────────

  /** 일회용 로그인 프로필을 만드는 폴더. 비정상 종료로 남은 프로필은 시작할 때 지운다 */
  static loginProfileRoot() {
    return path.join(app.getPath('userData'), 'browser-login');
  }

  static cleanupLoginProfiles() {
    // 시작 시점에 있던 폴더만 지운다 — 바로 시작된 새 로그인의 프로필까지 지우지 않도록
    const root = Hub.loginProfileRoot();
    let stale = [];
    try { stale = fs.readdirSync(root); } catch { return; }
    for (const name of stale) fs.promises.rm(path.join(root, name), { recursive: true, force: true }).catch(() => {});
  }

  /**
   * 이 계정의 브라우저 로그인이 진행 중이면 멈추고 완전히 끝날 때까지 기다린다.
   * 로그아웃·삭제가 쿠키를 지운 뒤에 가져오기가 끝나 다시 로그인되는 일을 막기 위해, 데이터 삭제 전에 호출한다.
   */
  async stopBrowserLogin(accountId) {
    const task = this.browserLoginTask;
    if (!task || task.accountId !== accountId) return;
    task.controller.abort(new Error('취소했습니다'));
    await task.done;
  }

  /**
   * 실제 Chrome/Edge에서 로그인하고 쿠키를 이 계정으로 가져온다.
   * 앱 내장 브라우저에서는 Google 패스키·보안 확인이 막히는 경우가 있어 그 대안으로 쓴다.
   */
  async browserLogin(accountId) {
    if (this.busy()) return;
    if (this.browserLoginTask) {
      this.toast('이미 브라우저 로그인이 진행 중입니다. 열린 브라우저 창에서 로그인을 마치거나 창을 닫으세요.', 'warn');
      return;
    }
    const found = this.findAccount(accountId);
    const browser = findBrowser();
    if (!found || !browser) {
      if (!browser) this.toast('Chrome 또는 Edge가 설치되어 있지 않습니다.', 'error');
      return;
    }
    const { serviceId, account } = found;
    const svc = byId[serviceId];
    let finish;
    const task = {
      accountId,
      phase: 'login', // 'login' = 브라우저에서 로그인 중, 'importing' = 창이 닫혀 가져오는 중
      browser: browser.name,
      controller: new AbortController(),
      done: new Promise((r) => { finish = r; }),
    };
    this.browserLoginTask = task;
    this.pushState();
    // 사용자는 지금부터 Chrome 창을 보고 있으므로, 앱 밖에서도 보이는 Windows 알림으로 다음 할 일을 알린다
    if (Notification.isSupported()) {
      new Notification({
        title: `${browser.name}에서 ${svc.name}에 로그인하세요`,
        body: `로그인을 마친 뒤 ${browser.name} 창을 닫으면 AI Hub로 로그인이 옮겨집니다.`,
      }).show();
    }

    try {
      const { imported } = await loginWithBrowser({
        serviceId,
        session: session.fromPartition(account.partition),
        profileRoot: Hub.loginProfileRoot(),
        signal: task.controller.signal,
        onLoginWindowClosed: () => {
          task.phase = 'importing';
          if (!this.win.isDestroyed()) {
            this.pushState();
            showWindow(this.win); // 가져오는 과정과 결과를 바로 볼 수 있게 앱을 앞으로
          }
        },
      });
      if (this.win.isDestroyed()) return;
      // 새 쿠키로 페이지를 다시 연다
      const entry = this.views.get(accountId);
      if (entry) entry.view.webContents.loadURL(svc.url);
      this.switchAccount(serviceId, accountId);
      this.checkLogin(accountId);
      this.win.focus();
      this.toast(`${svc.name} (${account.label}) 로그인을 가져왔습니다. (쿠키 ${imported}개)`, 'ok');
    } catch (err) {
      const cancelled = task.controller.signal.aborted;
      if (!this.win.isDestroyed()) this.toast(`${svc.name} 브라우저 로그인: ${err.message}`, cancelled ? 'info' : 'error');
    } finally {
      if (this.browserLoginTask === task) this.browserLoginTask = null;
      finish();
      if (!this.win.isDestroyed()) this.pushState();
    }
  }

  /**
   * 탭 안에서 로그인 화면으로 가려 할 때 호출. "로그인은 Chrome에서" 설정이면 Chrome 로그인을 열고 true(이동 막기).
   */
  onSignInAttempt(accountId) {
    if (!this.settings.loginInBrowser || !findBrowser()) return false;
    // 이미 로그인된 계정(계정 전환·재인증 등)은 앱 안에서 그대로 진행
    if (this.loginStatus.get(accountId) === true) return false;
    if (this.browserLoginTask) {
      if (Date.now() - this.lastSignInWarn > 5000) {
        this.lastSignInWarn = Date.now();
        this.toast(`${browserName()} 로그인 창이 이미 열려 있습니다. 그 창에서 로그인한 뒤 창을 닫아 주세요.`, 'warn');
      }
      return true;
    }
    this.browserLogin(accountId);
    return true;
  }

  cancelBrowserLogin() {
    if (this.browserLoginTask) this.browserLoginTask.controller.abort(new Error('취소했습니다'));
  }

  showAccountMenu(serviceId, x, y) {
    if (this.busy()) return;
    const svc = byId[serviceId];
    if (!svc) return;
    const list = this.state.accounts[serviceId];
    const activeId = this.activeAccountId(serviceId);
    const active = list.find((a) => a.id === activeId);
    const template = [
      ...list.map((a) => ({
        label: a.label,
        type: 'radio',
        checked: a.id === activeId,
        click: () => this.switchAccount(serviceId, a.id),
      })),
      { type: 'separator' },
      { label: '새 계정 추가', click: () => this.addAccount(serviceId) },
      { label: '계정 관리(이름 변경·삭제)…', click: () => this.openSettings('accounts') },
      { label: `"${active.label}" 로그아웃…`, click: () => this.resetAccount(activeId) },
      this.browserLoginTask
        ? { label: '브라우저 로그인 취소', click: () => this.cancelBrowserLogin() }
        : { label: `${browserName()}에서 로그인… (앱 안에서 로그인이 막힐 때)`, enabled: !!findBrowser(), click: () => this.browserLogin(activeId) },
      { type: 'separator' },
      { label: `${svc.name} 데스크톱 앱으로 열기`, click: () => this.openNativeApp(serviceId) },
    ];
    Menu.buildFromTemplate(template).popup({ window: this.win, x: Math.round(x), y: Math.round(y) });
  }

  showSplitMenu(x, y) {
    if (this.busy()) return;
    const st = this.state;
    const template = this.enabledIds().map((id) => ({
      label: byId[id].name,
      type: 'checkbox',
      checked: st.splitServices.includes(id),
      click: () => {
        const set = new Set(st.splitServices);
        if (set.has(id)) {
          if (set.size === 1) return this.toast('분할 화면에는 최소 1개 서비스가 필요합니다.', 'warn');
          set.delete(id);
        } else {
          set.add(id);
        }
        st.splitServices = this.enabledIds().filter((x) => set.has(x));
        if (!st.splitServices.includes(st.activeService)) st.activeService = st.splitServices[0];
        st.layout = 'split';
        store.save();
        this.layout();
        this.pushState();
      },
    }));
    Menu.buildFromTemplate(template).popup({ window: this.win, x: Math.round(x), y: Math.round(y) });
  }

  // ───────────── 동시 질문 ─────────────

  async sendBroadcast(text, serviceIds, opts = {}) {
    const prompt = String(text || '').trim();
    const ids = this.enabledIds().filter((id) => (serviceIds || []).includes(id));
    if (!prompt || ids.length === 0 || this.sending) return null;
    const files = validateFiles(opts.files);
    const requested = opts.requestedFiles || (Array.isArray(opts.files) ? opts.files.length : 0);
    if (requested && files.length !== requested) {
      this.toast('첨부 파일 중 읽을 수 없거나 너무 큰(100MB 초과) 파일이 있어 보내지 않았습니다.', 'error', 'broadcast');
      return null;
    }
    this.sending = true;
    const st = this.state;
    const prevActive = st.activeService;
    const historyEntry = this.addHistory(prompt, files.map((p) => path.basename(p)));

    // 입력 이벤트가 전달되려면 대상 뷰가 화면에 붙어 있어야 한다. 이미 다 보이면 레이아웃은 그대로 둔다.
    const visible = this.visibleServices();
    if (!ids.every((id) => visible.includes(id))) {
      st.layout = ids.length > 1 ? 'split' : 'single';
      if (ids.length > 1) st.splitServices = ids;
      if (!ids.includes(st.activeService)) st.activeService = ids[0];
      this.layout();
    }
    store.save();
    this.pushState();

    // 각 단계마다 대상이 아직 유효한지 확인 — 창이 닫히거나 대상 탭이 바뀌면 중단.
    // 입력은 DevTools Protocol로 하므로 다른 창으로 넘어가거나 최소화해도 계속 진행된다.
    const checkTarget = ({ serviceId, webContents }) => {
      if (this.win.isDestroyed()) throw new Error('창이 닫혔습니다');
      const accountId = this.activeAccountId(serviceId);
      const entry = this.views.get(accountId);
      if (!entry || entry.view.webContents !== webContents || webContents.isDestroyed() || !this.attached.has(accountId)) {
        throw new Error('대상 화면이 바뀌어 중단했습니다');
      }
    };

    try {
      const targets = ids.map((sid) => ({ serviceId: sid, webContents: this.ensureView(this.activeAccountId(sid)).view.webContents }));
      targets.forEach((t) => this.bumpNav(t.webContents)); // 이전 질문의 대화 주소 기록은 여기서 끊긴다
      const results = [];
      let ready = targets;
      if (opts.newChat) {
        // 각 서비스의 새 대화 화면으로 이동한 뒤 질문 — 이전 대화 맥락이 섞이지 않는다.
        // 이동에 실패한 서비스에 보내면 기존 대화에 들어가므로 그 서비스는 건너뛴다.
        const loads = await Promise.all(targets.map(({ serviceId, webContents }) =>
          webContents.loadURL(byId[serviceId].url).then(() => null, (err) => err)));
        ready = targets.filter((_t, i) => !loads[i]);
        targets.forEach((t, i) => {
          if (loads[i]) results.push({ serviceId: t.serviceId, status: 'failed', error: '새 대화를 열지 못해 보내지 않았습니다' });
        });
      }
      results.push(...(await broadcast(prompt, ready, checkTarget, files)));
      const name = (r) => byId[r.serviceId].name;
      const sent = results.filter((r) => r.status === 'sent');
      const unconfirmed = results.filter((r) => r.status === 'unconfirmed');
      const failed = results.filter((r) => r.status === 'failed');
      const parts = [];
      if (sent.length) parts.push(`전송됨: ${sent.map(name).join(', ')}`);
      if (unconfirmed.length) parts.push(`확인 필요: ${unconfirmed.map(name).join(', ')}`);
      for (const r of failed) parts.push(`${name(r)} 실패 — ${r.error}`);
      const kind = failed.length ? 'error' : unconfirmed.length ? 'warn' : 'ok';
      this.toast(parts.join(' · '), kind, 'broadcast');
      if (historyEntry) {
        const delivered = results.filter((r) => r.status !== 'failed').map((r) => ({
          serviceId: r.serviceId,
          accountId: this.activeAccountId(r.serviceId),
          webContents: targets.find((t) => t.serviceId === r.serviceId).webContents,
        }));
        this.captureChats(historyEntry, delivered); // 기다리지 않음 — 다음 질문을 바로 쓸 수 있게
      }
      return results;
    } finally {
      this.sending = false;
      if (!this.win.isDestroyed()) {
        if (this.visibleServices().includes(prevActive)) st.activeService = prevActive;
        store.save();
        this.pushState();
        this.focusComposer();
      }
    }
  }

  // ───────────── 단축키 ─────────────

  handleShortcut(event, input) {
    // 설정 화면이 떠 있을 때는 앱 단축키를 끈다 — 뒤의 입력창으로 포커스가 새는 것을 막고 Esc가 모달에 닿게
    if (input.type !== 'keyDown' || this.overlay) return;
    const ctrl = input.control || input.meta;
    const key = input.key;
    const lower = key.toLowerCase();
    let handled = true;

    if (ctrl && !input.shift && !input.alt && /^[1-9]$/.test(key)) {
      const id = this.enabledIds()[Number(key) - 1];
      if (id) this.selectService(id);
      else handled = false;
    } else if (ctrl && key === 'Tab') this.cycleService(input.shift ? -1 : 1);
    else if ((ctrl && !input.shift && lower === 'r') || key === 'F5') this.nav('reload');
    else if (ctrl && input.shift && lower === 'r') this.nav('hard-reload');
    else if (ctrl && !input.shift && lower === 'n') this.nav('home');
    else if (ctrl && input.shift && lower === 'n') this.newChatAll();
    else if (input.alt && key === 'ArrowLeft') this.nav('back');
    else if (input.alt && key === 'ArrowRight') this.nav('forward');
    else if (ctrl && key === '\\') this.toggleLayout();
    else if (ctrl && input.shift && lower === 'b') this.toggleBroadcast();
    else if (ctrl && key === ',') this.openSettings('general');
    else if (ctrl && !input.shift && lower === 'h') this.toggleSidebar();
    else if (key === 'F1') this.openWelcome();
    else if (ctrl && (key === '=' || key === '+')) this.zoom(1);
    else if (ctrl && key === '-') this.zoom(-1);
    else if (ctrl && key === '0') this.zoom(0);
    else if (this.dev && key === 'F12') this.activeWebContents()?.toggleDevTools();
    else if (this.dev && key === 'F11') this.ui.webContents.toggleDevTools();
    else handled = false;

    if (handled) event.preventDefault();
  }

  // ───────────── UI 상태 ─────────────

  snapshot() {
    const st = this.state;
    const status = {};
    for (const s of SERVICES) {
      const entry = this.views.get(this.activeAccountId(s.id));
      const wc = entry && !entry.view.webContents.isDestroyed() ? entry.view.webContents : null;
      status[s.id] = {
        loaded: !!wc,
        loading: wc ? wc.isLoading() : false,
        canGoBack: wc ? wc.navigationHistory.canGoBack() : false,
        canGoForward: wc ? wc.navigationHistory.canGoForward() : false,
      };
    }
    return {
      allServices: this.orderedIds().map((id) => ({ id, name: byId[id].name, color: byId[id].color })),
      services: this.enabledIds().map((id) => ({ id, name: byId[id].name, color: byId[id].color })),
      activeService: st.activeService,
      layout: st.layout,
      splitServices: st.splitServices,
      broadcastOpen: st.broadcastOpen,
      broadcastTargets: st.broadcastTargets,
      accounts: st.accounts,
      activeAccount: st.activeAccount,
      zoom: st.zoom[this.activeAccountId(st.activeService)] || 1,
      sending: this.sending,
      settings: st.settings,
      hotkeys: store.HOTKEYS,
      history: st.history,
      alwaysOnTop: !this.win.isDestroyed() && this.win.isAlwaysOnTop(),
      appVersion: app.getVersion(),
      update: { ...updater.status },
      browserLogin: this.browserLoginTask ? this.browserLoginTask.accountId : null,
      browserLoginInfo: this.browserLoginTask ? (() => {
        const t = this.browserLoginTask;
        const found = this.findAccount(t.accountId);
        return found && {
          phase: t.phase,
          browser: t.browser,
          service: byId[found.serviceId].name,
          account: found.account.label,
          multi: this.state.accounts[found.serviceId].length > 1,
        };
      })() : null,
      browserName: browserName(),
      metrics: { top: TOP_BAR, side: this.sideWidth() },
      sidebarOpen: st.sidebarOpen,
      composerHeight: st.composerHeight,
      onboarded: st.onboarded,
      loginStatus: Object.fromEntries(this.loginStatus),
      status,
    };
  }

  pushState() {
    if (!this.ui.webContents.isDestroyed()) this.ui.webContents.send('state', this.snapshot());
  }

  toast(message, kind = 'info', scope = 'top', durationMs) {
    if (!this.ui.webContents.isDestroyed()) this.ui.webContents.send('toast', { message, kind, scope, durationMs });
  }
}

function showWindow(win) {
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
}

function browserName() {
  const b = findBrowser();
  return b ? b.name : '브라우저';
}

async function clearPartition(partition) {
  const ses = session.fromPartition(partition);
  await ses.clearStorageData();
  await ses.clearCache();
}

module.exports = { Hub };
