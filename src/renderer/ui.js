'use strict';

const $ = (sel) => document.querySelector(sel);
const tabsEl = $('#tabs');
const statusEl = $('#status');
const zoomBtn = $('#zoom');
const splitBtn = $('#split');
const splitMenuBtn = $('#split-menu');
const bcToggle = $('#broadcast-toggle');
const pinBtn = $('#pin');
const bcBar = $('#broadcast');
const bcTargets = $('#bc-targets');
const bcNewChat = $('#bc-newchat');
const bcText = $('#bc-text');
const bcSend = $('#bc-send');
const bcClear = $('#bc-clear');
const bcResult = $('#bc-result');
const bcHint = $('#bc-hint');
const bcCount = $('#bc-count');
const modal = $('#modal');
const settingsBody = $('#settings-body');
const settingsNav = $('#settings-nav');

let state = null;
let settingsSection = 'general';
let historyIndex = -1; // -1 = 지금 쓰는 글, 0 = 가장 최근 질문
let draft = '';
let recordingShortcut = null; // 단축키 설정에서 키 입력을 기다리는 동작 id
let shortcutMsg = null; // { text, kind } — 단축키를 바꾼 결과 안내
let composerEdits = 0; // 입력창·첨부를 사용자가 바꾼 횟수 — 전송 실패 시 되돌려 놓아도 되는지 판단
const statusTimers = new Map(); // 표시 영역별 자동 지우기 타이머

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c != null) node.append(c);
  return node;
}

function icon(id) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}

const activeAccount = (sid) => state.accounts[sid].find((a) => a.id === state.activeAccount[sid]);

// ───────── 상단 바 ─────────

function renderTabs() {
  const visible = state.activeTerminal ? [state.activeService] : state.layout === 'split' ? state.splitServices : [state.activeService];
  tabsEl.replaceChildren(...state.services.map((svc, i) => {
    const account = activeAccount(svc.id);
    const multi = state.accounts[svc.id].length > 1;
    const needLogin = state.loginStatus[account.id] === false;
    const active = svc.id === state.activeService;
    const coding = state.coding[svc.id]; // 이 탭의 코딩 도구 (꺼져 있으면 null)
    const codeMode = active && !!state.activeTerminal;
    const folder = coding && coding.cwd ? coding.cwd.split(/[\\/]/).filter(Boolean).pop() : '';

    // 둘째 줄: 코딩 모드면 폴더, 다른 탭을 보는 동안 코딩이 돌고 있으면 그 사실, 아니면 계정·로그인 상태
    let subText = needLogin ? (multi ? `${account.label} · 로그인 필요` : '로그인 필요') : (multi ? account.label : '');
    let subClass = needLogin ? ' need-login' : '';
    if (codeMode) { subText = `코딩${folder ? ` · ${folder}` : ''}`; subClass = coding.running ? ' running' : ''; }
    else if (coding && coding.running) { subText = '코딩 실행 중'; subClass = ' running'; }

    const main = el('button', {
      className: 'tab-main',
      title: `${svc.name}${codeMode ? ` — ${coding.name}` : ` — ${account.label}`} (Ctrl+${i + 1})`,
      disabled: state.sending,
      onclick: () => window.hub.selectService(svc.id),
    }, [
      el('span', { className: 'dot' }),
      el('span', { className: 'tab-text' }, [
        el('span', { className: 'tab-name', textContent: svc.name }),
        el('span', { className: `tab-account${subClass}`, textContent: subText }),
      ]),
      i < 9 ? el('span', { className: 'tab-key', textContent: String(i + 1) }) : null,
    ]);
    main.setAttribute('role', 'tab');
    main.setAttribute('aria-selected', String(active));

    // [채팅 | 코딩] — 보고 있는 탭에만. 코딩을 누르면 같은 탭에서 그 회사의 코딩 에이전트가 열린다
    let toggle = null;
    if (active && coding) {
      const seg = (mode, label, tip) => {
        const b = el('button', {
          className: 'seg',
          textContent: label,
          title: tip,
          disabled: state.sending,
          onclick: () => window.hub.setServiceMode(svc.id, mode),
        });
        b.setAttribute('aria-pressed', String((mode === 'code') === codeMode));
        return b;
      };
      toggle = el('div', { className: 'mode-toggle', role: 'group' }, [
        seg('chat', '채팅', `${svc.name} 웹 채팅`),
        seg('code', '코딩', `${coding.name} — 내 PC의 폴더에서 코드를 만들고 실행합니다`),
      ]);
      toggle.setAttribute('aria-label', `${svc.name} 채팅/코딩 전환`);
    }

    const caret = el('button', {
      className: 'caret',
      title: '계정 전환 / 추가',
      disabled: state.sending,
      onclick: (e) => {
        const r = e.currentTarget.closest('.tab').getBoundingClientRect();
        window.hub.accountMenu(svc.id, r.left, r.bottom + 2);
      },
    }, [icon('i-caret')]);
    caret.setAttribute('aria-label', `${svc.name} 계정 메뉴`);

    // 코딩 모드에는 "새 대화"가 없다 (세션은 코딩 화면의 버튼으로)
    const fresh = codeMode ? null : el('button', {
      className: 'tab-new',
      title: `${svc.name} 새 대화`,
      disabled: state.sending,
      onclick: () => window.hub.newChat(svc.id),
    }, [icon('i-plus')]);
    if (fresh) fresh.setAttribute('aria-label', `${svc.name} 새 대화`);

    const tab = el('div', { className: 'tab' }, [main, toggle, fresh, caret].filter(Boolean));
    tab.style.setProperty('--svc', svc.color);
    tab.classList.toggle('active', active);
    tab.classList.toggle('visible', visible.includes(svc.id));
    tab.classList.toggle('loading', !codeMode && state.status[svc.id].loading);
    if (!state.sending) makeDraggable(tab, svc.id);
    return tab;
  }));
}

// 탭 드래그 앤 드롭으로 순서 바꾸기
let dragId = null;

function dropSide(tab, e) {
  const r = tab.getBoundingClientRect();
  return e.clientX < r.left + r.width / 2 ? 'before' : 'after';
}

function makeDraggable(tab, id) {
  tab.draggable = true;
  // ＋·▾ 버튼을 누를 때는 드래그가 시작되지 않게 (살짝 움직여도 클릭으로 처리)
  tab.addEventListener('pointerdown', (e) => { tab.draggable = !e.target.closest('.tab-new, .caret, .mode-toggle'); });
  tab.addEventListener('pointerup', () => { tab.draggable = true; });
  tab.title = '드래그해서 순서를 바꿀 수 있습니다';
  tab.addEventListener('dragstart', (e) => {
    dragId = id;
    tab.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
  });
  tab.addEventListener('dragend', () => {
    dragId = null;
    tabsEl.querySelectorAll('.tab').forEach((t) => t.classList.remove('dragging', 'drop-before', 'drop-after'));
  });
  tab.addEventListener('dragover', (e) => {
    if (!dragId || dragId === id) return;
    e.preventDefault();
    const side = dropSide(tab, e);
    tab.classList.toggle('drop-before', side === 'before');
    tab.classList.toggle('drop-after', side === 'after');
  });
  tab.addEventListener('dragleave', () => tab.classList.remove('drop-before', 'drop-after'));
  tab.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!dragId || dragId === id) return;
    // 꺼 둔 서비스도 포함한 전체 순서에서 옮긴다
    const order = state.allServices.map((s) => s.id).filter((x) => x !== dragId);
    const at = order.indexOf(id) + (dropSide(tab, e) === 'after' ? 1 : 0);
    order.splice(at, 0, dragId);
    window.hub.setOrder(order);
  });
}

function renderTools() {
  const st = state.status[state.activeService];
  // 동시 질문 전송 중에는 레이아웃/계정/이동 조작을 잠근다(메인 프로세스에서도 막지만 눈에 보이게)
  const lock = state.sending;
  const term = !!state.activeTerminal;
  document.querySelector('[data-nav="back"]').disabled = lock || term || !st.canGoBack;
  document.querySelector('[data-nav="forward"]').disabled = lock || term || !st.canGoForward;
  document.querySelector('[data-nav="reload"]').disabled = lock || term;
  $('#new-all').disabled = lock;
  renderUpdateButton();
  $('#bc-new-all').disabled = lock;
  zoomBtn.textContent = `${Math.round(state.zoom * 100)}%`;
  for (const b of [zoomBtn, splitBtn, splitMenuBtn, bcToggle, $('#settings-btn')]) b.disabled = lock;
  splitBtn.setAttribute('aria-pressed', String(state.layout === 'split'));
  splitMenuBtn.setAttribute('aria-pressed', String(state.layout === 'split'));
  bcToggle.setAttribute('aria-pressed', String(state.broadcastOpen));
  pinBtn.setAttribute('aria-pressed', String(state.settings.alwaysOnTop));
  $('#sidebar-toggle').setAttribute('aria-pressed', String(state.sidebarOpen));
  pinBtn.title = state.settings.alwaysOnTop ? '항상 위 고정 해제' : '항상 위에 고정';
}

// 새 버전을 받는 중이면 진행률, 다 받았으면 "업데이트 — 재시작" 버튼
function renderUpdateButton() {
  const btn = $('#update-btn');
  const u = state.update || {};
  btn.hidden = !(u.state === 'ready' || u.state === 'downloading');
  btn.classList.toggle('ready', u.state === 'ready');
  btn.disabled = u.state !== 'ready';
  btn.textContent = u.state === 'ready' ? `업데이트 ${u.version} — 재시작` : `새 버전 받는 중 ${u.percent || 0}%`;
  btn.title = u.state === 'ready' ? '지금 재시작해서 새 버전으로 바꿉니다 (누르지 않아도 다음에 앱을 끌 때 설치됩니다)' : '';
}
$('#update-btn').addEventListener('click', () => window.hub.installUpdate());

// ───────── 동시 질문 바 ─────────

function renderBroadcast() {
  bcBar.hidden = !state.broadcastOpen;
  if (!resizing) applyComposerHeight(state.composerHeight);
  const targets = new Set(state.broadcastTargets);

  bcTargets.replaceChildren(...state.services.map((svc) => {
    const account = activeAccount(svc.id);
    const multi = state.accounts[svc.id].length > 1;
    const on = targets.has(svc.id);
    const pill = el('button', {
      className: 'pill',
      title: on ? `${svc.name} 제외` : `${svc.name} 포함`,
      disabled: state.sending,
      onclick: () => {
        const next = new Set(state.broadcastTargets);
        if (on) next.delete(svc.id); else next.add(svc.id);
        if (next.size === 0) return showStatus('최소 1개 서비스는 선택해야 합니다.', 'warn', 'broadcast');
        window.hub.setTargets([...next]);
      },
    }, [el('span', { className: 'dot' }), multi ? `${svc.name} · ${account.label}` : svc.name]);
    pill.style.setProperty('--svc', svc.color);
    pill.setAttribute('aria-pressed', String(on));
    return pill;
  }));

  bcNewChat.checked = state.settings.newChat;
  bcNewChat.disabled = state.sending;
  bcSend.disabled = state.sending;
  bcAttach.disabled = state.sending;
  renderAttachments(); // 전송 중에는 첨부 빼기 버튼도 잠근다
  bcSend.classList.toggle('busy', state.sending);
  bcSend.replaceChildren(icon(state.sending ? 'i-reload' : 'i-send'));

  const send = state.settings.enterToSend ? 'Enter' : 'Ctrl+Enter';
  const newline = state.settings.enterToSend ? 'Shift+Enter' : 'Enter';
  bcHint.replaceChildren(
    el('kbd', { textContent: send }), ' 전송   ',
    el('kbd', { textContent: newline }), ' 줄바꿈   ',
    el('kbd', { textContent: '↑' }), ' 이전 질문   ',
    el('kbd', { textContent: 'Esc' }), ' 닫기',
  );
}

function autosize() {
  const n = bcText.value.length;
  bcCount.textContent = n ? `${n.toLocaleString()}자` : '';
  if (bcBar.classList.contains('fixed')) return; // 사용자가 높이를 정했으면 입력칸이 그 공간을 채운다
  bcText.style.height = 'auto';
  bcText.style.height = `${Math.min(bcText.scrollHeight, 240)}px`;
}

// ───────── 입력창 크기 조절 (윗변 드래그) ─────────

const bcResize = $('#bc-resize');
const COMPOSER_MIN = 110;
let resizing = null; // { pointerId, height }

function clampComposer(h) {
  const max = window.innerHeight - state.metrics.top - 120; // 웹페이지 영역은 최소한 남긴다
  return Math.round(Math.max(COMPOSER_MIN, Math.min(max, h)));
}

/** null이면 내용에 맞춘 자동 높이, 숫자면 그 높이로 고정 */
function applyComposerHeight(h) {
  if (h) {
    bcBar.classList.add('fixed');
    bcBar.style.height = `${clampComposer(h)}px`;
    bcText.style.height = '';
  } else {
    bcBar.classList.remove('fixed');
    bcBar.style.height = '';
  }
  autosize();
}

bcResize.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || state.sending) return;
  e.preventDefault();
  bcResize.setPointerCapture(e.pointerId);
  resizing = { pointerId: e.pointerId, height: bcBar.getBoundingClientRect().height };
  document.body.classList.add('resizing');
  // 드래그하는 동안 UI를 맨 위로 — 마우스가 웹페이지 위로 올라가도 이벤트를 놓치지 않게 (배경은 투명)
  window.hub.setOverlay(true);
});

bcResize.addEventListener('pointermove', (e) => {
  if (!resizing || e.pointerId !== resizing.pointerId) return;
  resizing.height = clampComposer(window.innerHeight - e.clientY);
  applyComposerHeight(resizing.height);
});

function endResize(e) {
  if (!resizing || e.pointerId !== resizing.pointerId) return;
  const h = resizing.height;
  resizing = null;
  document.body.classList.remove('resizing');
  // 드래그 중에 설정·안내 창이 열렸다면(트레이 메뉴 등) 그 창이 오버레이를 계속 쓰므로 내리지 않는다
  if (modal.hidden) window.hub.setOverlay(false);
  window.hub.setComposerHeight(h);
}
bcResize.addEventListener('pointerup', endResize);
bcResize.addEventListener('pointercancel', endResize);
bcResize.addEventListener('lostpointercapture', endResize);

// 더블클릭하면 자동 높이로
bcResize.addEventListener('dblclick', () => window.hub.setComposerHeight(null));

// 키보드: ↑↓로 20px씩, Home은 자동 높이
bcResize.addEventListener('keydown', (e) => {
  const cur = bcBar.getBoundingClientRect().height;
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    window.hub.setComposerHeight(clampComposer(cur + (e.key === 'ArrowUp' ? 20 : -20)));
  } else if (e.key === 'Home') {
    e.preventDefault();
    window.hub.setComposerHeight(null);
  }
});

// 창 크기가 바뀌면 저장된 높이를 창 안에 맞춘다
window.addEventListener('resize', () => { if (state && !resizing) applyComposerHeight(state.composerHeight); });

// 바의 실제 높이를 main에 알려서 웹페이지 영역을 그만큼 줄이게 한다
new ResizeObserver(() => {
  if (!bcBar.hidden) window.hub.setBarHeight(Math.ceil(bcBar.getBoundingClientRect().height));
}).observe(bcBar);

function setComposer(text) {
  bcText.value = text;
  autosize();
  updateClearButton();
  bcText.setSelectionRange(text.length, text.length);
}

/** 지울 내용(글·첨부)이 있을 때만 지우기 버튼을 보인다 */
function updateClearButton() {
  bcClear.hidden = !bcText.value && attachments.length === 0;
  bcClear.disabled = !!(state && state.sending);
}

/** 입력한 글과 첨부를 모두 비운다 */
function clearComposer() {
  if (state.sending) return;
  historyIndex = -1;
  draft = '';
  composerEdits++; // 진행 중이던 전송이 실패해도 지운 질문을 되살리지 않게
  setComposer('');
  // 붙여넣기·끌어다 놓기 처리가 진행 중이면 그게 끝난 뒤에 비워야 늦게 도착한 첨부가 남지 않는다
  queueAttach(async () => {
    attachFailed = false;
    removeAttachments(attachments.slice());
  });
  bcText.focus();
}

async function send() {
  const submitted = bcText.value;
  const text = submitted.trim();
  if (state.sending) return;
  if (!text) {
    if (attachments.length) showStatus('첨부한 파일에 대해 물어볼 내용을 입력하세요.', 'warn', 'broadcast');
    return;
  }
  // 붙여넣기·끌어다 놓기 처리가 아직 진행 중이면 끝난 뒤에 보낸다 (첨부 없이 글만 가지 않도록).
  // 기다리는 사이에 또 첨부가 추가될 수 있으므로 모두 끝날 때까지 반복
  if (pendingAttach) showStatus('첨부 파일을 준비하는 중…', 'info', 'broadcast');
  while (pendingAttach) await pendingAttach;
  if (attachFailed) {
    attachFailed = false;
    showStatus('첨부하지 못한 파일이 있어 보내지 않았습니다. 첨부 목록을 확인한 뒤 다시 보내 주세요.', 'error', 'broadcast');
    return;
  }
  historyIndex = -1;
  const sentFiles = attachments.slice();
  const clearNow = state.settings.clearAfterSend;
  if (clearNow) {
    // Enter를 누르면 바로 비운다 — 전송은 뒤에서 진행되고, 그동안 다음 질문을 쓸 수 있다.
    // 첨부 파일은 업로드가 끝날 때까지 필요하므로 목록에서만 빼고 정리는 전송이 끝난 뒤에 한다.
    setComposer('');
    attachments = attachments.filter((a) => !sentFiles.includes(a));
    renderAttachments();
  }
  const editsAtClear = composerEdits;
  let results = null;
  try {
    results = await window.hub.broadcast(text, state.broadcastTargets, {
      newChat: bcNewChat.checked,
      files: sentFiles.map((a) => a.path),
    });
  } catch (err) {
    showStatus(`전송 중 오류: ${err.message}`, 'error', 'broadcast');
  }
  const allSent = !!results && results.every((r) => r.status === 'sent');

  if (!clearNow) {
    if (allSent && bcText.value === submitted) { setComposer(''); removeAttachments(sentFiles); }
    return;
  }
  // 일부라도 못 보냈고 아직 다음 질문을 쓰기 전이면, 다시 보낼 수 있게 질문과 첨부를 되돌려 놓는다
  if (!allSent && composerEdits === editsAtClear && attachments.length === 0) {
    setComposer(text);
    attachments = sentFiles;
    renderAttachments();
    return;
  }
  releaseAttachments(sentFiles);
}

// ───────── 첨부 (파일·이미지) ─────────

const MAX_ATTACH = 10;
const bcFiles = $('#bc-files');
const bcAttach = $('#bc-attach');
let attachments = []; // { path, name, size, thumb } — thumb는 이미지 미리보기 blob URL
let pendingAttach = null; // 진행 중인 붙여넣기·끌어다 놓기 처리
let attachFailed = false; // 처리 중 실패가 있었으면 다음 전송을 막고 확인을 요청

/** 첨부 처리를 하나씩 이어서 실행하고, 실패하면 알리고 표시해 둔다 */
function queueAttach(task) {
  const run = (pendingAttach || Promise.resolve()).then(task).catch((err) => {
    attachFailed = true;
    showStatus(`첨부하지 못했습니다: ${err.message}`, 'error', 'broadcast');
  });
  pendingAttach = run;
  run.finally(() => { if (pendingAttach === run) pendingAttach = null; });
  return run;
}

function formatSize(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/** 받은 첨부를 목록에 넣는다. 중복이거나 개수를 넘는 것은 정리(미리보기 해제·임시 파일 삭제)하고 버린다 */
function addAttachments(infos) {
  const rejected = [];
  let full = false;
  for (const info of infos) {
    if (!info) continue;
    const dup = attachments.some((a) => a.path === info.path);
    if (dup || attachments.length >= MAX_ATTACH) {
      full = full || !dup;
      rejected.push(info);
    } else {
      attachments.push(info);
    }
  }
  if (full) showStatus(`파일은 최대 ${MAX_ATTACH}개까지 첨부할 수 있습니다.`, 'warn', 'broadcast');
  for (const r of rejected) {
    if (r.thumb) URL.revokeObjectURL(r.thumb);
    window.hub.discardFiles([r.path]); // 등록할 때 늘어난 횟수를 되돌린다(같은 파일이 목록에 남아 있어도 그쪽 등록은 유지됨)
  }
  renderAttachments();
}

/** 미리보기 해제 + main에 알려 등록 해제(붙여넣기 임시 파일은 삭제) */
function releaseAttachments(list) {
  for (const a of list) if (a.thumb) URL.revokeObjectURL(a.thumb);
  if (list.length) window.hub.discardFiles(list.map((a) => a.path));
}

function removeAttachments(list) {
  releaseAttachments(list);
  attachments = attachments.filter((a) => !list.includes(a));
  renderAttachments();
}

/** 끌어다 놓기·붙여넣기로 받은 File 목록 → 경로가 있으면 그대로, 없으면(캡처 이미지) 임시 파일로 저장 */
async function addFileObjects(fileList) {
  const room = MAX_ATTACH - attachments.length;
  if (room <= 0) return showStatus(`파일은 최대 ${MAX_ATTACH}개까지 첨부할 수 있습니다.`, 'warn', 'broadcast');
  if (fileList.length > room) showStatus(`파일은 최대 ${MAX_ATTACH}개까지 — 앞의 ${room}개만 첨부합니다.`, 'warn', 'broadcast');
  const files = fileList.slice(0, room);

  const resolved = await window.hub.resolveFiles(files);
  const infos = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    let info = resolved[i];
    if (!info) {
      // 경로가 없는 파일 = 클립보드에서 붙여넣은 캡처 이미지 등 → 임시 파일로
      const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
      const name = f.name && f.name !== 'image.png' ? f.name : `붙여넣은 이미지 ${new Date().toLocaleTimeString('ko-KR', { hour12: false }).replace(/:/g, '')}.${ext}`;
      info = f.size > 0 ? await window.hub.saveTempFile(name, new Uint8Array(await f.arrayBuffer())) : null;
    }
    if (info) {
      infos.push({ ...info, thumb: f.type.startsWith('image/') ? URL.createObjectURL(f) : null });
    } else {
      showStatus(`"${f.name || '파일'}"은(는) 첨부할 수 없습니다 (100MB 이하의 파일만).`, 'warn', 'broadcast');
    }
  }
  addAttachments(infos);
  bcText.focus();
}

function renderAttachments() {
  updateClearButton();
  bcFiles.hidden = attachments.length === 0;
  bcFiles.replaceChildren(...attachments.map((a) => {
    const ext = (a.name.split('.').pop() || '').slice(0, 4).toUpperCase();
    const remove = el('button', { className: 'icon small', title: '첨부 빼기', disabled: state && state.sending, onclick: () => removeAttachments([a]) }, [icon('i-close')]);
    remove.setAttribute('aria-label', `${a.name} 첨부 빼기`);
    return el('div', { className: 'file-chip', title: a.path }, [
      a.thumb ? el('img', { src: a.thumb, alt: '' }) : el('span', { className: 'ext', textContent: ext || 'FILE' }),
      el('span', { className: 'fname', textContent: a.name }),
      el('span', { className: 'fsize', textContent: formatSize(a.size) }),
      remove,
    ]);
  }));
}

bcAttach.addEventListener('click', () => queueAttach(async () => {
  addAttachments(await window.hub.pickFiles());
  bcText.focus();
}));

// 붙여넣기: 클립보드에 파일·캡처 이미지가 있으면 첨부로 (글자는 평소처럼 붙여넣기)
bcText.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData ? e.clipboardData.files : [])];
  if (files.length === 0) return;
  e.preventDefault();
  queueAttach(() => addFileObjects(files));
});

// 끌어다 놓기: 동시 질문 바 어디에 놓아도 첨부
const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
bcBar.addEventListener('dragover', (e) => {
  if (!hasFiles(e) || state.sending) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  bcBar.classList.add('dragover');
});
bcBar.addEventListener('dragleave', (e) => { if (!bcBar.contains(e.relatedTarget)) bcBar.classList.remove('dragover'); });
bcBar.addEventListener('drop', (e) => {
  bcBar.classList.remove('dragover');
  if (!hasFiles(e) || state.sending) return;
  e.preventDefault();
  const dropped = [...e.dataTransfer.files];
  queueAttach(() => addFileObjects(dropped));
});
// 바 밖(상단바·사이드바)에 잘못 놓아도 앱 화면이 그 파일로 바뀌지 않게
document.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
document.addEventListener('drop', (e) => { if (hasFiles(e)) e.preventDefault(); });

function onComposerKey(e) {
  // 한글 조합 중 Enter는 글자 확정용 — 전송하면 마지막 글자가 빠진다
  if (e.isComposing || e.keyCode === 229) return;

  if (e.key === 'Enter') {
    const wantsSend = state.settings.enterToSend
      ? !e.shiftKey && !e.altKey
      : (e.ctrlKey || e.metaKey);
    if (wantsSend) {
      e.preventDefault();
      send();
    }
    return; // 그 외(Shift+Enter 등)는 기본 동작 = 줄바꿈
  }

  const atStart = bcText.selectionStart === 0 && bcText.selectionEnd === 0;
  const atEnd = bcText.selectionStart === bcText.value.length;
  const history = state.history || [];
  if (e.key === 'ArrowUp' && atStart && historyIndex < history.length - 1) {
    e.preventDefault();
    if (historyIndex === -1) draft = bcText.value;
    historyIndex++;
    setComposer(history[historyIndex]);
  } else if (e.key === 'ArrowDown' && atEnd && historyIndex >= 0) {
    e.preventDefault();
    historyIndex = Math.min(historyIndex - 1, history.length - 1);
    setComposer(historyIndex === -1 ? draft : history[historyIndex]);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    window.hub.toggleBroadcast();
  }
}

bcText.addEventListener('keydown', onComposerKey);
bcText.addEventListener('input', () => { historyIndex = -1; composerEdits++; autosize(); updateClearButton(); });
bcSend.addEventListener('click', send);
bcClear.addEventListener('click', clearComposer);
bcNewChat.addEventListener('change', () => window.hub.updateSettings({ newChat: bcNewChat.checked }));
$('#bc-close').addEventListener('click', () => window.hub.toggleBroadcast());

// ───────── 알림 ─────────

function showStatus(message, kind = 'info', scope = 'top', durationMs) {
  // 동시 질문 결과는 아래 바에, 그 외 알림은 상단 바 가운데에 표시
  const target = scope === 'broadcast' && state && state.broadcastOpen ? bcResult : statusEl;
  target.textContent = message;
  target.title = message;
  target.className = kind;
  clearTimeout(statusTimers.get(target));
  statusTimers.set(target, setTimeout(() => { target.textContent = ''; target.title = ''; }, durationMs || (kind === 'error' ? 15000 : 6000)));
}

// ───────── 설정 ─────────

function row(title, desc, control) {
  return el('div', { className: 'row' }, [
    el('div', { className: 'row-text' }, [
      el('div', { className: 'row-title', textContent: title }),
      desc ? el('div', { className: 'row-desc', textContent: desc }) : null,
    ]),
    control,
  ]);
}

function settingSwitch(key, label) {
  const input = el('input', {
    type: 'checkbox',
    className: 'switch',
    checked: !!state.settings[key],
    onchange: () => window.hub.updateSettings({ [key]: input.checked }),
  });
  input.setAttribute('aria-label', label);
  return input;
}

function settingSelect(key, options, label) {
  const select = el('select', {
    onchange: () => window.hub.updateSettings({ [key]: select.value }),
  }, options.map(([value, text]) => el('option', { value, textContent: text, selected: state.settings[key] === value })));
  select.setAttribute('aria-label', label);
  return select;
}

function button(text, onclick, className = 'btn', disabled = false) {
  return el('button', { className, textContent: text, onclick, disabled });
}

// ───────── 단축키 표시·변경 ─────────

// 조합은 main/shortcuts.js와 같은 형식 — "Ctrl+Shift+KeyB" (KeyboardEvent.code 기준)
const CODE_LABEL = {
  Backslash: '\\', Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", Backquote: '`',
  BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=',
  ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
  NumpadAdd: 'Num +', NumpadSubtract: 'Num -', NumpadMultiply: 'Num *', NumpadDivide: 'Num /', NumpadDecimal: 'Num .',
  PageUp: 'PgUp', PageDown: 'PgDn', Delete: 'Del', Insert: 'Ins',
};

function keyLabel(combo) {
  return combo.split('+').map((p) => CODE_LABEL[p] || p.replace(/^(Key|Digit)/, '').replace(/^Numpad(\d)$/, 'Num $1')).join('+');
}

/** 지금 적용 중인 단축키 표시 문자열 ('' = 사용 안 함) */
function shortcutLabel(id) {
  const a = state.shortcutActions.find((x) => x.id === id);
  if (!a) return '';
  const o = state.settings.shortcuts;
  const combo = id in o ? o[id] : a.key;
  return combo ? keyLabel(combo) : '';
}

/** "동시 질문{key}" → "동시 질문 (Ctrl+Shift+B)" — 단축키가 없으면 괄호째 뺀다 */
function withKey(text, id) {
  const k = shortcutLabel(id);
  return text.replace('{key}', k ? ` (${k})` : '');
}

function renderShortcutTitles() {
  for (const node of document.querySelectorAll('[data-sc]')) node.title = withKey(node.dataset.tip, node.dataset.sc);
}

async function applyShortcut(id, combo) {
  const r = await window.hub.setShortcut(id, combo);
  if (r && r.error) shortcutMsg = { text: r.error, kind: 'error' };
  else if (r && r.taken) shortcutMsg = { text: `'${r.taken}'에서 쓰던 조합이라 그쪽은 '사용 안 함'으로 바꿨습니다.`, kind: 'warn' };
  else shortcutMsg = null;
  renderSettings();
}

/** 버튼에 포커스를 두고 다음 키 조합을 받는다. 앱 단축키는 설정 화면이 떠 있는 동안 꺼져 있어 원래 동작이 실행되지 않는다 */
function startRecording(id, btn) {
  recordingShortcut = id;
  btn.classList.add('recording');
  btn.replaceChildren('키를 누르세요…');
  const stop = () => {
    btn.removeEventListener('keydown', onKey);
    btn.removeEventListener('blur', cancel);
    recordingShortcut = null;
  };
  const cancel = () => { stop(); renderSettings(); };
  const onKey = (e) => {
    e.preventDefault();
    e.stopPropagation(); // Esc가 설정 창까지 닫지 않게
    if (!e.code || /^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/.test(e.code)) return; // 수식키만 누른 상태 — 나머지 키를 기다린다
    const mods = [];
    if (e.ctrlKey || e.metaKey) mods.push('Ctrl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    const plain = mods.length === 0;
    if (plain && e.code === 'Escape') return cancel();
    stop();
    applyShortcut(id, plain && (e.code === 'Backspace' || e.code === 'Delete') ? '' : [...mods, e.code].join('+'));
  };
  btn.addEventListener('keydown', onKey);
  btn.addEventListener('blur', cancel);
  btn.focus();
}

const SECTIONS = {
  general: () => [
    el('h3', { textContent: '일반' }),
    el('p', { className: 'lead', textContent: '창과 시작 동작을 설정합니다.' }),
    row('시작 화면', '앱을 켰을 때 보여줄 레이아웃',
      settingSelect('startupLayout', [['remember', '마지막 상태 기억'], ['single', '탭 하나'], ['split', '분할 화면']], '시작 화면')),
    row('다른 서비스 미리 불러오기', '시작 후 다른 탭도 백그라운드에서 열어 두어 전환이 즉시 됩니다 (메모리 사용 증가)',
      settingSwitch('preloadAll', '다른 서비스 미리 불러오기')),
    row('항상 위에 고정', '다른 창보다 항상 위에 표시합니다', settingSwitch('alwaysOnTop', '항상 위에 고정')),
    row(`로그인은 ${state.browserName}에서`, `Google·Apple 로그인이나 ChatGPT 로그인 화면으로 가면 ${state.browserName} 창을 열어 로그인합니다. 로그인 후 그 창을 닫으면 앱으로 옮겨집니다 (권장)`,
      settingSwitch('loginInBrowser', '로그인은 브라우저에서')),
    row('닫으면 트레이로', '창을 닫아도 종료하지 않고 작업 표시줄 트레이에 남겨 둡니다', settingSwitch('closeToTray', '닫으면 트레이로')),
    row('전역 단축키', '어느 프로그램에서든 눌러 AI Hub를 불러오고 질문 입력창을 엽니다',
      settingSelect('globalHotkey', state.hotkeys.map((h) => [h.value, h.label]), '전역 단축키')),
  ],

  broadcast: () => [
    el('h3', { textContent: '동시 질문' }),
    el('p', { className: 'lead', textContent: '여러 AI에 같은 질문을 보내는 입력창의 동작입니다.' }),
    row('Enter로 전송', '끄면 Ctrl+Enter로 전송하고 Enter는 줄바꿈이 됩니다', settingSwitch('enterToSend', 'Enter로 전송')),
    row('보내면 입력창 비우기', 'Enter를 누르는 즉시 입력창을 비워 다음 질문을 쓸 수 있게 합니다. 보내지 못한 곳이 있으면 질문과 첨부를 되돌려 놓습니다', settingSwitch('clearAfterSend', '보내면 입력창 비우기')),
    row('새 대화에서 질문', '기존 대화에 이어 쓰지 않고 각 서비스의 새 대화를 열어 질문합니다', settingSwitch('newChat', '새 대화에서 질문')),
    row('질문 기록 저장', '입력창에서 ↑ 키로 이전 질문을 불러옵니다 (이 PC에만 저장)', settingSwitch('saveHistory', '질문 기록 저장')),
    row('저장된 기록', `${state.history.length}개`,
      button('기록 지우기', () => window.hub.clearHistory(), 'btn danger', state.history.length === 0)),
  ],

  accounts: () => [
    el('h3', { textContent: '서비스 · 계정' }),
    el('p', { className: 'lead', textContent: '쓰지 않는 서비스는 꺼서 숨기고, ▲▼로 탭 순서를 바꿀 수 있습니다(상단 탭을 끌어다 놓아도 됩니다). 서비스마다 여러 계정을 등록할 수 있고, 계정마다 로그인이 따로 저장됩니다.' }),
    ...state.allServices.map((svc) => {
      const enabled = state.settings.enabledServices.includes(svc.id);
      const list = state.accounts[svc.id];
      const toggle = el('input', {
        type: 'checkbox',
        className: 'switch',
        checked: enabled,
        onchange: () => {
          const next = new Set(state.settings.enabledServices);
          if (toggle.checked) next.add(svc.id); else next.delete(svc.id);
          if (next.size === 0) {
            toggle.checked = true;
            return showStatus('최소 1개 서비스는 켜 두어야 합니다.', 'warn');
          }
          window.hub.updateSettings({ enabledServices: [...next] });
        },
      });
      toggle.setAttribute('aria-label', `${svc.name} 사용`);

      const idx = state.allServices.findIndex((s) => s.id === svc.id);
      const up = el('button', { className: 'icon small', title: '앞으로 (탭 순서)', disabled: idx === 0, onclick: () => window.hub.moveService(svc.id, -1) }, ['▲']);
      const down = el('button', { className: 'icon small', title: '뒤로 (탭 순서)', disabled: idx === state.allServices.length - 1, onclick: () => window.hub.moveService(svc.id, 1) }, ['▼']);
      up.setAttribute('aria-label', `${svc.name} 앞으로`);
      down.setAttribute('aria-label', `${svc.name} 뒤로`);
      const head = el('div', { className: 'svc-head' }, [
        el('span', { className: 'dot' }),
        el('span', { className: 'name', textContent: svc.name }),
        up,
        down,
        toggle,
      ]);
      head.style.setProperty('--svc', svc.color);

      const rows = list.map((a) => {
        const radio = el('input', {
          type: 'radio',
          name: `active-${svc.id}`,
          checked: a.id === state.activeAccount[svc.id],
          title: '이 계정 사용',
          onchange: () => window.hub.accountAction('switch', a.id),
        });
        radio.setAttribute('aria-label', `${a.label} 사용`);
        const name = el('input', {
          className: 'text',
          value: a.label,
          maxLength: 30,
          onchange: () => window.hub.renameAccount(a.id, name.value),
          onkeydown: (e) => { if (e.key === 'Enter') name.blur(); },
        });
        name.setAttribute('aria-label', '계정 이름');
        const loggingIn = state.browserLogin === a.id;
        const browserBtn = loggingIn
          ? button('로그인 취소', () => window.hub.accountAction('browser-login-cancel', a.id), 'btn primary')
          : button(`${state.browserName}에서 로그인`, () => window.hub.accountAction('browser-login', a.id), 'btn', !!state.browserLogin);
        browserBtn.title = '앱 안에서 Google 로그인 등이 막힐 때, 실제 브라우저에서 로그인하고 가져옵니다';
        return el('div', { className: 'acc-row' }, [
          radio,
          name,
          browserBtn,
          button('로그아웃', () => window.hub.accountAction('reset', a.id)),
          button('삭제', () => window.hub.accountAction('remove', a.id), 'btn danger', list.length <= 1),
        ]);
      });

      return el('div', { className: `svc-card${enabled ? '' : ' off'}` }, [
        head,
        ...rows,
        el('div', { className: 'svc-foot' }, [
          button('+ 계정 추가', () => window.hub.accountAction('add', svc.id), 'btn', !enabled),
          button('데스크톱 앱 열기', () => window.hub.accountAction('native', svc.id)),
        ]),
      ]);
    }),
  ],

  coding: () => {
    const on = new Set(state.settings.codingTools);
    return [
      el('h3', { textContent: '코딩' }),
      el('p', { className: 'lead', textContent: '서비스 탭의 [채팅 | 코딩] 중 코딩을 누르면, 같은 탭에서 그 회사의 코딩 에이전트가 열립니다. 고른 폴더 안에서 직접 파일을 만들고 고치고, 실행해서 확인합니다. 쓰지 않는 것은 꺼 두면 전환 버튼이 사라집니다.' }),
      ...state.allTools.map((t) => {
        const toggle = el('input', {
          type: 'checkbox',
          className: 'switch',
          checked: on.has(t.id),
          onchange: () => {
            const next = new Set(state.settings.codingTools);
            if (toggle.checked) next.add(t.id); else next.delete(t.id);
            window.hub.updateSettings({ codingTools: state.allTools.map((x) => x.id).filter((id) => next.has(id)) });
          },
        });
        toggle.setAttribute('aria-label', `${t.service} 탭에서 ${t.name} 사용`);
        const status = t.installed === undefined ? '설치 여부 확인 중…'
          : t.installed ? '설치됨' : '설치 안 됨 — 코딩을 누르면 설치 버튼이 나옵니다';
        return row(`${t.service} → ${t.name}`, status, toggle);
      }),
    ];
  },

  shortcuts: () => {
    const overrides = state.settings.shortcuts;
    const rows = state.shortcutActions.map((a) => {
      const changed = a.id in overrides;
      const current = shortcutLabel(a.id);
      const rec = el('button', {
        className: `btn sc-key${current ? '' : ' none'}`,
        title: '누른 뒤 새 키 조합을 입력하세요',
        onclick: () => startRecording(a.id, rec),
      }, [current ? el('kbd', { textContent: current }) : '사용 안 함']);
      rec.setAttribute('aria-label', `${a.label} 단축키 바꾸기 (지금: ${current || '사용 안 함'})`);
      const reset = button('기본값', () => applyShortcut(a.id, null), 'btn', !changed);
      reset.title = `기본값: ${keyLabel(a.key)}`;
      return row(a.label, changed ? `기본값 ${keyLabel(a.key)}` : null, el('div', { className: 'sc-ctl' }, [rec, reset]));
    });
    const fixed = [
      ['서비스 전환', 'Ctrl+1 ~ 9'],
      ['새로고침', 'F5'],
      ['확대 / 축소 / 원래대로', 'Ctrl++ / Num + / Num - / Num 0'],
      ['전역: AI Hub 불러오기 (일반 설정에서 변경)', (state.hotkeys.find((h) => h.value === state.settings.globalHotkey) || {}).label || '사용 안 함'],
    ];
    return [
      el('h3', { textContent: '단축키' }),
      el('p', { className: 'lead', textContent: '바꿀 단축키를 누른 뒤 원하는 키 조합을 누르세요. Esc는 취소, Backspace는 사용 안 함. 웹페이지에 포커스가 있어도 동작합니다.' }),
      shortcutMsg ? el('p', { className: `sc-msg ${shortcutMsg.kind}`, textContent: shortcutMsg.text, role: 'status' }) : null,
      ...rows,
      row('모두 기본값으로', null, button('초기화', () => applyShortcut('*', null), 'btn', Object.keys(overrides).length === 0)),
      el('h4', { textContent: '바꿀 수 없는 단축키' }),
      el('table', { className: 'keys' }, [el('tbody', {}, fixed.map(([x, y]) =>
        el('tr', {}, [el('td', { textContent: x }), el('td', {}, [el('kbd', { textContent: y })])])))]),
    ].filter(Boolean);
  },

  about: () => {
    const info = el('p', { className: 'lead', textContent: '버전 정보를 불러오는 중…' });
    window.hub.getVersion().then((v) => {
      if (v) info.textContent = `AI Hub ${v.app} · Electron ${v.electron} · Chromium ${v.chrome}`;
    });
    const u = state.update || {};
    const updateText = {
      dev: '개발 모드로 실행 중이라 업데이트를 확인하지 않습니다 (설치된 앱에서만 동작)',
      idle: '아직 확인하지 않았습니다',
      checking: '확인하는 중…',
      latest: `최신 버전입니다 (${state.appVersion})`,
      downloading: `새 버전 ${u.version || ''} 내려받는 중 ${u.percent || 0}%`,
      ready: `새 버전 ${u.version || ''} 준비 완료 — 재시작하면 적용됩니다`,
      error: `확인하지 못했습니다: ${u.error || ''}`,
    }[u.state] || '';
    return [
      el('h3', { textContent: '정보' }),
      info,
      row('업데이트', updateText, u.state === 'ready'
        ? button('지금 재시작', () => window.hub.installUpdate(), 'btn primary')
        : button('업데이트 확인', () => window.hub.checkUpdate(), 'btn', u.state === 'checking' || u.state === 'downloading')),
      row('자동 업데이트', '앱을 켤 때와 4시간마다 새 버전을 확인해 백그라운드에서 내려받습니다',
        settingSwitch('autoUpdate', '자동 업데이트')),
      row('설정 · 로그인 데이터 폴더', '설정 파일(config.json)과 계정별 로그인 정보가 저장된 위치',
        button('폴더 열기', () => window.hub.openDataFolder())),
    ];
  },
};

function renderSettings() {
  if (modal.hidden || recordingShortcut) return; // 단축키 입력을 기다리는 중에는 버튼이 사라지지 않게
  // 계정 이름을 입력하는 중에는 다시 그리지 않는다(포커스와 입력 중인 글자가 사라지므로)
  if (settingsBody.contains(document.activeElement) && document.activeElement.classList.contains('text')) return;
  const scroller = settingsBody.parentElement;
  const scroll = scroller.scrollTop;
  settingsBody.replaceChildren(...SECTIONS[settingsSection]());
  scroller.scrollTop = scroll;
  for (const b of settingsNav.querySelectorAll('button')) {
    b.setAttribute('aria-current', String(b.dataset.section === settingsSection));
  }
}

const settingsDialog = $('.settings');
const welcomeDialog = $('#welcome');
const guideDialog = $('#login-guide');

/** 모달(설정/안내) 하나를 띄우고 뒤의 UI는 포커스가 가지 않게 inert */
function showModal(dialog) {
  modal.hidden = false;
  for (const d of [settingsDialog, welcomeDialog, guideDialog]) d.hidden = d !== dialog;
  for (const n of [$('#topbar'), bcBar, sidebar]) n.inert = true;
}

// ───────── 브라우저 로그인 안내 ─────────

/** 로그인이 진행되는 동안 무엇을 해야 하는지 단계별로 보여준다 (창을 닫아야 끝난다는 걸 놓치지 않도록) */
let guideReturnTo = null; // 안내 전에 떠 있던 설정/처음 안내 — 로그인이 끝나면 그 화면으로 돌아간다

function renderLoginGuide() {
  const info = state.browserLoginInfo;
  if (!info) {
    if (guideDialog.hidden) return;
    const back = guideReturnTo;
    guideReturnTo = null;
    if (back) {
      showModal(back);
      if (back === settingsDialog) renderSettings(); else renderWelcome();
    } else {
      closeModal();
    }
    return;
  }
  if (guideDialog.hidden) {
    guideReturnTo = modal.hidden ? null : [settingsDialog, welcomeDialog].find((d) => !d.hidden) || null;
    showModal(guideDialog);
    window.hub.setOverlay(true);
  }
  const who = info.multi ? `${info.service} (${info.account})` : info.service;
  const importing = info.phase === 'importing';
  const step = (n, title, text, status) => el('li', { className: `g-step ${status}` }, [
    el('span', { className: 'num', textContent: status === 'done' ? '✓' : String(n) }),
    el('div', {}, [el('b', { textContent: title }), text ? el('p', { textContent: text }) : null]),
  ]);
  guideDialog.replaceChildren(
    el('h2', { id: 'guide-title', textContent: importing ? '로그인 정보를 가져오는 중…' : `${info.browser}에서 ${who}에 로그인하세요` }),
    el('p', { className: 'lead', textContent: importing
      ? '잠시만 기다려 주세요. 끝나면 이 창이 자동으로 닫힙니다.'
      : `앱 안에서는 Google 보안 확인이 막혀서, 별도의 ${info.browser} 창에서 로그인합니다.` }),
    el('ol', { className: 'tips' }, [
      step(1, `열린 ${info.browser} 창에서 평소처럼 로그인`, '패스키·휴대폰 인증 모두 사용할 수 있습니다.', importing ? 'done' : 'now'),
      step(2, `로그인이 끝나면 ${info.browser} 창을 닫기`, '창의 X 버튼을 누르세요. 창을 닫아야 로그인이 앱으로 옮겨집니다.', importing ? 'done' : 'next'),
      step(3, 'AI Hub에 자동으로 로그인', null, importing ? 'now' : 'next'),
    ]),
    el('div', { className: 'w-actions' }, [
      el('span', { className: 'row-desc', textContent: importing ? '' : `${info.browser} 창이 안 보이면 작업 표시줄에서 찾아 주세요.` }),
      button('취소', () => window.hub.accountAction('browser-login-cancel', ''), 'btn', importing),
    ]),
  );
}

function openSettings(section) {
  shortcutMsg = null;
  settingsSection = SECTIONS[section] ? section : 'general';
  showModal(settingsDialog);
  renderSettings();
  settingsNav.querySelector(`[data-section="${settingsSection}"]`).focus();
}

function closeModal() {
  if (modal.hidden) return;
  if (!welcomeDialog.hidden && !state.onboarded) window.hub.completeOnboarding(null); // 건너뛰어도 다시 묻지 않음
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); // 이름 변경 확정
  modal.hidden = true;
  for (const n of [$('#topbar'), bcBar, sidebar]) n.inert = false;
  window.hub.setOverlay(false);
}
const closeSettings = closeModal;

// ───────── 처음 안내 ─────────

let welcomeStep = 0;
let welcomePick = null; // 고른 서비스

function welcomeContent() {
  const steps = el('div', { className: 'steps' }, [0, 1, 2].map((i) => el('span', { className: i <= welcomeStep ? 'on' : '' })));
  const browser = state.browserName;

  if (welcomeStep === 0) {
    return [
      steps,
      el('h2', { id: 'welcome-title', textContent: 'AI Hub에 오신 것을 환영합니다' }),
      el('p', { className: 'lead', textContent: 'Claude, ChatGPT, Gemini를 한 창에서 씁니다. 사용할 서비스를 고르세요. (나중에 설정에서 바꿀 수 있어요)' }),
      el('div', { className: 'choices' }, state.allServices.map((svc) => {
        const b = el('button', {
          className: 'choice',
          onclick: () => {
            const next = new Set(welcomePick);
            if (next.has(svc.id)) next.delete(svc.id); else next.add(svc.id);
            if (next.size === 0) return;
            welcomePick = [...next];
            renderWelcome();
          },
        }, [el('span', { className: 'dot' }), svc.name]);
        b.style.setProperty('--svc', svc.color);
        b.setAttribute('aria-pressed', String(welcomePick.includes(svc.id)));
        return b;
      })),
    ];
  }

  const tipTitle = (title, id) => (shortcutLabel(id) ? `${title} — ${shortcutLabel(id)}` : title);
  const tip = (n, title, text) => el('li', {}, [el('span', { className: 'num', textContent: String(n) }), el('div', {}, [el('b', { textContent: title }), el('p', { textContent: text })])]);

  if (welcomeStep === 1) {
    return [
      steps,
      el('h2', { id: 'welcome-title', textContent: '로그인은 한 번만' }),
      el('p', { className: 'lead', textContent: '각 탭에서 한 번 로그인하면 다음부터는 자동으로 로그인되어 있습니다.' }),
      el('ol', { className: 'tips' }, [
        tip(1, '탭을 눌러 로그인 화면으로', '아직 로그인하지 않은 탭에는 "로그인 필요"가 표시됩니다.'),
        tip(2, `Google·Apple 로그인은 ${browser} 창에서`, `로그인 버튼을 누르면 ${browser} 창이 열립니다. 평소처럼 로그인하고 그 창을 닫으면 앱으로 로그인이 옮겨집니다.`),
        tip(3, '계정이 여러 개라면', '탭 옆 ▾ 에서 계정을 추가하고 전환할 수 있습니다. 계정마다 로그인이 따로 저장됩니다.'),
      ]),
    ];
  }

  return [
    steps,
    el('h2', { id: 'welcome-title', textContent: '이렇게 써 보세요' }),
    el('p', { className: 'lead', textContent: withKey('자주 쓰는 기능 다섯 가지입니다. 언제든 ? 버튼{key}으로 다시 볼 수 있어요.', 'help') }),
    el('ol', { className: 'tips' }, [
      tip(1, tipTitle('동시 질문', 'broadcast'), '아래 입력창에 쓰고 Enter를 누르면 고른 AI 모두에게 같은 질문이 갑니다. Shift+Enter는 줄바꿈.'),
      tip(2, tipTitle('분할 화면', 'split'), '여러 AI의 답을 나란히 비교합니다.'),
      tip(3, tipTitle('질문 기록', 'sidebar'), '보낸 질문과 그때의 대화들이 왼쪽에 쌓입니다. 누르면 그 대화들을 다시 엽니다.'),
      tip(4, '탭 순서 바꾸기', '상단 탭을 끌어다 놓으면 순서가 바뀌고, Ctrl+1·2·3도 그 순서를 따릅니다.'),
      tip(5, '어디서든 불러오기', `다른 프로그램을 쓰다가 ${(state.hotkeys.find((h) => h.value === state.settings.globalHotkey) || {}).label || '전역 단축키(설정에서 지정)'}를 누르면 바로 질문할 수 있습니다.`),
    ]),
  ];
}

function renderWelcome() {
  const last = welcomeStep === 2;
  welcomeDialog.replaceChildren(
    ...welcomeContent(),
    el('div', { className: 'w-actions' }, [
      button('건너뛰기', closeModal, 'btn'),
      el('div', { className: 'row-actions' }, [
        welcomeStep > 0 ? button('이전', () => { welcomeStep--; renderWelcome(); }, 'btn') : null,
        ' ',
        button(last ? '시작하기' : '다음', () => {
          if (!last) { welcomeStep++; renderWelcome(); return; }
          window.hub.completeOnboarding(welcomePick);
          closeModal();
        }, 'btn primary'),
      ]),
    ]),
  );
  welcomeDialog.querySelector('.btn.primary').focus();
}

function openWelcome() {
  welcomeStep = 0;
  welcomePick = state.settings.enabledServices.slice();
  showModal(welcomeDialog);
  renderWelcome();
}

// ───────── 질문 기록 사이드바 ─────────

const sidebar = $('#sidebar');
const sideList = $('#side-list');
const sideQ = $('#side-q');

function relativeTime(at) {
  if (!at) return '';
  const diff = Date.now() - at;
  if (diff < 60e3) return '방금';
  if (diff < 3600e3) return `${Math.floor(diff / 60e3)}분 전`;
  if (diff < 86400e3) return `${Math.floor(diff / 3600e3)}시간 전`;
  const d = new Date(at);
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
}

function dayGroup(at) {
  if (!at) return '이전';
  const start = new Date(); start.setHours(0, 0, 0, 0);
  if (at >= start.getTime()) return '오늘';
  if (at >= start.getTime() - 86400e3) return '어제';
  if (at >= start.getTime() - 7 * 86400e3) return '지난 7일';
  return '이전';
}

/** 기록과 연결된 대화를 연다 — serviceId가 있으면 그 서비스의 대화만 */
async function openHistoryItem(h, serviceId) {
  const res = await window.hub.openHistory(h.id, serviceId || '');
  if (!res || res.opened > 0) return;
  showStatus(res.capturing
    ? '대화 주소를 기록하는 중입니다. 답변이 시작된 뒤 잠시 후 다시 눌러 주세요.'
    : '이 질문과 연결된 대화가 없습니다 (전송에 실패했거나 기록 전에 다른 대화로 옮겨졌을 수 있음). ↻로 다시 물을 수 있습니다.', 'warn');
}

function askAgain(h) {
  if (!state.broadcastOpen) window.hub.toggleBroadcast();
  setComposer(h.text);
  bcText.focus();
}

function renderSidebar() {
  sidebar.hidden = state.metrics.side === 0;
  document.documentElement.style.setProperty('--side', `${state.metrics.side}px`);
  if (sidebar.hidden) return;

  const q = sideQ.value.trim().toLowerCase();
  const items = state.history.filter((h) => !q || h.text.toLowerCase().includes(q));
  if (items.length === 0) {
    sideList.replaceChildren(el('li', { className: 'side-empty' }, q
      ? [el('strong', { textContent: '검색 결과가 없습니다' })]
      : [el('strong', { textContent: '아직 기록이 없습니다' }), '아래 "동시 질문"으로 질문을 보내면 여기에 쌓이고, 누르면 그때의 대화들을 다시 열 수 있어요.']));
    return;
  }

  const colors = Object.fromEntries(state.allServices.map((s) => [s.id, s]));
  const nodes = [];
  let group = null;
  for (const h of items) {
    const g = dayGroup(h.at);
    if (g !== group) { group = g; nodes.push(el('li', { className: 'h-group', textContent: g })); }
    // 탭 순서대로, 이 질문의 대화가 기록된 서비스만 칩으로 — 누르면 그 서비스의 대화만 연다
    const chats = state.allServices.map((s) => s.id).filter((sid) => h.chats && h.chats[sid]);
    const chips = chats.map((sid) => {
      const b = el('button', {
        className: 'h-chip',
        title: `${colors[sid].name}에서 이 대화 열기`,
        disabled: state.sending,
        onclick: () => openHistoryItem(h, sid),
      }, [el('span', { className: 'dot' }), colors[sid].name]);
      b.style.setProperty('--svc', colors[sid].color);
      return b;
    });
    const retry = el('button', { className: 'icon small', title: '다시 묻기 (질문을 입력창에 넣기)', onclick: () => askAgain(h) }, [icon('i-retry')]);
    retry.setAttribute('aria-label', '다시 묻기');
    const del = el('button', { className: 'icon small', title: '기록에서 삭제', onclick: () => window.hub.deleteHistory(h.id) }, [icon('i-close')]);
    del.setAttribute('aria-label', '기록에서 삭제');
    nodes.push(el('li', { className: 'h-item' }, [
      el('button', {
        className: 'h-open',
        title: chats.length ? '이 질문의 대화들을 각 탭에서 열기' : '연결된 대화가 아직 없습니다',
        disabled: state.sending,
        onclick: () => openHistoryItem(h),
      }, [
        el('span', { className: 'h-text', textContent: h.text }),
        el('span', { className: 'h-meta' }, [
          relativeTime(h.at),
          h.files && h.files.length ? el('span', { className: 'h-files', title: h.files.join('\n'), textContent: `· 첨부 ${h.files.length}` }) : null,
          chats.length ? null : el('span', { className: 'h-files', textContent: Date.now() - h.at < 30000 ? '· 대화 기록 중…' : '· 연결된 대화 없음' }),
        ]),
      ]),
      chips.length ? el('div', { className: 'h-chips' }, chips) : null,
      el('div', { className: 'h-actions' }, [retry, del]),
    ]));
  }
  sideList.replaceChildren(...nodes);
}

sideQ.addEventListener('input', renderSidebar);
$('#side-close').addEventListener('click', () => window.hub.toggleSidebar());
$('#sidebar-toggle').addEventListener('click', () => window.hub.toggleSidebar());
$('#help-btn').addEventListener('click', () => window.hub.openWelcome());

settingsNav.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-section]');
  if (!b) return;
  settingsSection = b.dataset.section;
  settingsBody.parentElement.scrollTop = 0;
  renderSettings();
});
$('#settings-close').addEventListener('click', closeSettings);
modal.addEventListener('keydown', (e) => { if (e.key === 'Escape' && guideDialog.hidden) closeModal(); });
modal.addEventListener('mousedown', (e) => { if (e.target === modal && welcomeDialog.hidden && guideDialog.hidden) closeModal(); });

// ───────── 상단 바 이벤트 ─────────

document.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', () => window.hub.nav(b.dataset.nav)));
zoomBtn.addEventListener('click', () => window.hub.zoom(0));
splitBtn.addEventListener('click', () => window.hub.toggleLayout());
splitMenuBtn.addEventListener('click', (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  window.hub.splitMenu(r.left, r.bottom + 2);
});
bcToggle.addEventListener('click', () => window.hub.toggleBroadcast());
pinBtn.addEventListener('click', () => window.hub.updateSettings({ alwaysOnTop: !state.settings.alwaysOnTop }));
$('#settings-btn').addEventListener('click', () => window.hub.openSettings('general'));
$('#new-all').addEventListener('click', () => window.hub.newChatAll());
$('#bc-new-all').addEventListener('click', () => window.hub.newChatAll());

// ───────── main 연결 ─────────

function render() {
  document.documentElement.style.setProperty('--top', `${state.metrics.top}px`);
  renderTabs();
  renderTools();
  renderSidebar();
  renderLoginGuide();
  renderBroadcast();
  renderSettings();
  renderShortcutTitles();
}

window.hub.onFocusBroadcast(() => {
  bcText.focus();
  autosize();
  if (!bcBar.hidden) window.hub.setBarHeight(Math.ceil(bcBar.getBoundingClientRect().height));
});
window.hub.onOpenSettings(({ section }) => openSettings(section));
window.hub.onOpenWelcome(() => openWelcome());
window.hub.onToast(({ message, kind, scope, durationMs }) => showStatus(message, kind, scope, durationMs));
window.hub.onState((s) => {
  // 기록이 바뀌면(지우기·새 질문) 보던 위치를 초기화 — 사라진 항목을 가리키지 않도록
  if (state && (s.history.length !== state.history.length || s.history[0] !== state.history[0])) historyIndex = -1;
  state = s;
  render();
});

window.hub.getState().then((s) => { if (!state) { state = s; render(); } });
