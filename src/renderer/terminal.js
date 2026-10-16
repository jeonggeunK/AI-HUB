'use strict';
/* global Terminal, FitAddon, Unicode11Addon */
// 코딩 도구 탭 화면 — 도구마다 xterm 하나. 프로세스(node-pty)는 main/terminals.js가 갖고 있다.

const $ = (s) => document.querySelector(s);

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null) continue;
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node[k] = v;
  }
  for (const c of [].concat(children)) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}

const FONT = "'Cascadia Mono', 'Cascadia Code', Consolas, 'D2Coding', 'Malgun Gothic', monospace";
const THEME = {
  background: '#1b1c1f',
  foreground: '#e8e8ea',
  cursor: '#7aa2ff',
  cursorAccent: '#1b1c1f',
  selectionBackground: '#7aa2ff55',
  black: '#2d2f34', brightBlack: '#6b6e76',
  red: '#ff6b6b', brightRed: '#ff8f8f',
  green: '#4cc38a', brightGreen: '#6fdaa5',
  yellow: '#e6b450', brightYellow: '#f2ca72',
  blue: '#7aa2ff', brightBlue: '#9db9ff',
  magenta: '#c792ea', brightMagenta: '#d7aef2',
  cyan: '#5ccfe6', brightCyan: '#86e1f0',
  white: '#e8e8ea', brightWhite: '#ffffff',
};

// 처음 쓰는 사람을 위한 예시 — 시작 화면에 보여 준다
const EXAMPLES = [
  '이 폴더에 있는 프로젝트가 뭔지 설명해 줘',
  '할 일 목록 웹페이지를 만들어 줘. 만들고 나면 실행 방법도 알려 줘',
  '이 코드에서 버그를 찾아서 고치고, 테스트를 돌려서 확인해 줘',
];
const TIPS = [
  'Shift+Enter 줄바꿈 · 선택한 글자는 Ctrl+C로 복사 · Ctrl+V 붙여넣기 · 오른쪽 클릭으로 복사/붙여넣기',
  '파일을 끌어다 놓으면 그 파일 경로가 입력됩니다 · Ctrl+= / Ctrl+- 글자 크기',
  '답을 멈추려면 Esc · 이전 대화를 이어 가려면 /resume (Claude Code)',
];
// 처음 실행할 때 나오는 영어 질문 화면 — 처음 쓰는 사람이 막히지 않게 한국어로 한 번씩 알려 준다
const HINTS = [
  { key: 'trust', re: /trust\s+(the|this)\s+(files|folder|directory)|do\s+you\s+trust|trust\s+the\s+contents|trust\s+folder/i,
    text: '처음 여는 폴더라서, 이 폴더의 파일을 다뤄도 되는지 묻고 있어요. 내 폴더가 맞으면 Enter를 누르세요.' },
  { key: 'login', re: /select\s+login\s+method|sign\s+in\s+with\s+chatgpt|login\s+with\s+google|how\s+would\s+you\s+like\s+to\s+authenticate/i,
    text: '로그인 방법을 고르는 화면이에요. ↑↓로 내 계정 방식(구독 계정·ChatGPT·Google)을 고르고 Enter → 열리는 브라우저에서 로그인하면 됩니다.' },
  { key: 'update', re: /update\s+available/i,
    text: '새 버전이 나왔다는 안내예요. ↑↓로 고르고 Enter — 지금은 건너뛰어도 괜찮습니다.' },
];

let st = null; // main이 보낸 상태 (hub.termSnapshot)
const sessions = {}; // toolId -> { term, fit, host, ended, exited, kind, cols, rows }
const picked = {}; // 시작 화면에서 고른 폴더
const launching = {}; // 시작 요청을 보냈고 아직 결과를 기다리는 중
let confirmFor = null; // 실행 중인 세션을 끝내기 전 확인: { id, action: 'restart' | 'end' }
let startMsg = null; // { id, text }

const tool = (id = st && st.active) => (st ? st.tools.find((t) => t.id === id) : null);

// ───────── xterm ─────────

function ensureTerm(id) {
  if (sessions[id]) return sessions[id];
  const host = el('div', { className: 'term-host', hidden: true });
  const ended = el('div', { className: 'ended', hidden: true });
  $('#terms').append(host);
  const term = new Terminal({
    fontFamily: FONT,
    fontSize: st.fontSize,
    theme: THEME,
    cursorBlink: true,
    scrollback: 10000,
    allowProposedApi: true, // unicode11 (한글·이모지 폭)
    windowsPty: { backend: 'conpty' },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new Unicode11Addon.Unicode11Addon());
  term.unicode.activeVersion = '11';
  term.open(host);
  host.append(ended);
  const hint = el('div', { className: 'hint', hidden: true });
  host.append(hint);
  // 글자·배경색 질문(OSC 10/11)에 답한다 — Gemini CLI 등은 답이 없으면 몇 초 기다린 뒤에야 화면을 그린다
  const answerColor = (code, rgb) => term.parser.registerOscHandler(code, (data) => {
    if (data !== '?') return false;
    window.term.write(id, `\x1b]${code};rgb:${rgb}\x1b\\`);
    return true;
  });
  answerColor(10, 'e8e8/e8e8/eaea');
  answerColor(11, '1b1b/1c1c/1f1f');

  const s = { term, fit, host, ended, hint, exited: false, kind: 'run', cols: 0, rows: 0, startedAt: 0, hintsSeen: new Set() };
  sessions[id] = s;
  term.attachCustomKeyEventHandler((e) => onKey(id, s, e));
  term.onData((data) => onInput(id, data));
  host.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (term.hasSelection()) copySelection(term);
    else navigator.clipboard.readText().then((t) => t && term.paste(t)).catch(() => {});
  });
  new ResizeObserver(() => scheduleFit(id)).observe(host);
  return s;
}

function copySelection(term) {
  navigator.clipboard.writeText(term.getSelection()).catch(() => {});
  term.clearSelection();
}

function onKey(id, s, e) {
  if (e.type !== 'keydown') return true;
  // 키를 누르면 안내는 닫는다 (onData는 터미널이 자동으로 보내는 응답에도 불리므로 여기서)
  if (!['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) s.hint.hidden = true;
  const ctrl = e.ctrlKey || e.metaKey;
  // 선택한 글자가 있으면 Ctrl+C는 복사 (없으면 평소처럼 중단 신호)
  if (ctrl && !e.altKey && e.code === 'KeyC' && (e.shiftKey || s.term.hasSelection())) {
    if (s.term.hasSelection()) copySelection(s.term);
    e.preventDefault();
    return false;
  }
  // 붙여넣기는 브라우저 기본 동작에 맡긴다 — xterm이 paste 이벤트로 받아 한 번에 보낸다
  if (ctrl && !e.altKey && e.code === 'KeyV') return false;
  // Shift+Enter: 줄바꿈 (ESC+CR = Alt+Enter — Claude Code 등이 "보내지 말고 줄만 바꾸기"로 받는다)
  if (e.code === 'Enter' && e.shiftKey && !ctrl && !e.altKey) {
    onInput(id, '\x1b\r');
    e.preventDefault();
    return false;
  }
  return true;
}

function onInput(id, data) {
  const s = sessions[id];
  if (!s) return;
  if (s.exited) {
    if (data === '\r') restart(id);
    return;
  }
  window.term.write(id, data);
}

const fitTimers = {};
function scheduleFit(id) {
  cancelAnimationFrame(fitTimers[id]);
  fitTimers[id] = requestAnimationFrame(() => {
    const s = sessions[id];
    if (!s || s.host.hidden || s.host.clientWidth === 0) return;
    try { s.fit.fit(); } catch { return; }
    if (s.term.cols !== s.cols || s.term.rows !== s.rows) {
      s.cols = s.term.cols;
      s.rows = s.term.rows;
      window.term.resize(id, s.cols, s.rows);
    }
  });
}

// ───────── 세션 시작·끝 ─────────

function folderOf(t) {
  return picked[t.id] || t.cwd || null;
}

async function start(id, mode = 'run') {
  const t = tool(id);
  if (!t || launching[id]) return;
  const cwd = mode === 'install' ? (folderOf(t) || st.home) : folderOf(t);
  if (!cwd) { startMsg = { id, text: '작업 폴더를 먼저 선택하세요.' }; return render(); }
  const s = ensureTerm(id);
  s.term.reset();
  s.exited = false;
  s.kind = mode;
  s.ended.hidden = true;
  s.hint.hidden = true;
  s.startedAt = Date.now();
  s.hintsSeen = new Set();
  s.scan = '';
  startMsg = null;
  launching[id] = true;
  render(); // 터미널을 먼저 보여 줘야 크기를 잴 수 있다
  try { s.fit.fit(); } catch { /* 숨겨진 상태 */ }
  s.cols = s.term.cols;
  s.rows = s.term.rows;
  const r = await window.term.start(id, cwd, s.cols, s.rows, mode);
  launching[id] = false;
  if (!r || r.error) startMsg = { id, text: (r && r.error) || '시작하지 못했습니다.' };
  render();
  if (r && r.ok) s.term.focus();
}

function restart(id) {
  const t = tool(id);
  if (!t) return;
  if (!folderOf(t)) return endSession(id); // 설치만 하고 폴더를 아직 안 골랐으면 시작 화면으로
  start(id, 'run');
}

function endSession(id) {
  confirmFor = null;
  window.term.stop(id);
  const s = sessions[id];
  if (s) { s.exited = false; s.ended.hidden = true; }
}

function onExit({ id, code, kind }) {
  const s = sessions[id];
  if (!s) return;
  s.exited = true;
  showEnded(id, s, code, kind);
  render();
}

function showEnded(id, s, code, kind) {
  const ok = code === 0;
  const text = kind === 'install'
    ? (ok ? '설치가 끝났습니다.' : `설치하지 못했습니다 (코드 ${code}). 위의 메시지를 확인하세요.`)
    : `프로그램이 끝났습니다${code ? ` (코드 ${code})` : ''}.`;
  const again = kind === 'install' && ok ? '시작' : '다시 시작';
  s.ended.replaceChildren(
    el('span', { textContent: text }),
    el('button', { className: 'btn primary', onclick: () => restart(id) }, [`${again} `, el('kbd', { textContent: 'Enter' })]),
    el('button', { className: 'btn', textContent: '닫기', onclick: () => { endSession(id); } }),
  );
  s.ended.hidden = false;
}

// ───────── 화면 ─────────

function render() {
  const t = tool();
  const bar = $('#bar');
  for (const [id, s] of Object.entries(sessions)) {
    const tt = tool(id);
    s.host.hidden = !(t && id === t.id && tt && (tt.session || launching[id]));
  }
  if (!t) { bar.hidden = true; $('#start').hidden = true; return; }

  const sess = t.session;
  bar.hidden = false;
  bar.style.setProperty('--svc', t.color);
  document.body.style.setProperty('--svc', t.color);
  $('#tool-name').textContent = `${t.service} · 코딩 (${t.name})`;
  const cwdBtn = $('#cwd');
  cwdBtn.hidden = !sess;
  if (sess) { cwdBtn.textContent = sess.cwd; cwdBtn.title = `${sess.cwd}\n탐색기에서 열기`; }
  const rs = $('#run-state');
  rs.className = sess ? (sess.running ? 'on' : 'off') : '';
  rs.textContent = sess ? (sess.running ? '● 실행 중' : '종료됨') : '';
  $('#restart').hidden = !sess;
  $('#shell').hidden = !sess;
  $('#end').hidden = !sess;

  const confirm = $('#confirm');
  if (confirmFor && confirmFor.id === t.id && sess && sess.running) {
    const label = confirmFor.action === 'restart' ? '다시 시작' : '끝내기';
    confirm.replaceChildren(
      '실행 중인 세션을 끝낼까요?',
      el('button', { className: 'btn danger', textContent: label, onclick: () => doConfirmed() }),
      el('button', { className: 'btn', textContent: '취소', onclick: () => { confirmFor = null; render(); } }),
    );
    confirm.hidden = false;
  } else {
    confirmFor = null;
    confirm.hidden = true;
  }

  const showStart = !sess && !launching[t.id];
  $('#start').hidden = !showStart;
  if (showStart) renderStart(t);
  else scheduleFit(t.id);
}

function doConfirmed() {
  const c = confirmFor;
  confirmFor = null;
  if (!c) return;
  if (c.action === 'restart') restart(c.id);
  else endSession(c.id);
}

function step(n, title, body, done) {
  return el('div', { className: `step${done ? ' done' : ''}` }, [
    el('span', { className: 'num', textContent: done ? '✓' : String(n) }),
    el('div', { className: 'step-body' }, [el('div', { className: 'step-title', textContent: title }), body]),
  ]);
}

let projectName = '새 프로젝트';

function renderStart(t) {
  const cwd = folderOf(t);
  const missing = t.installed === false;
  const checking = t.installed === undefined;

  // 0) 설치 — 없을 때만
  let install = null;
  if (missing) {
    install = el('div', { className: 'install' }, st.hasNpm === false ? [
      el('p', { textContent: `${t.name}를 쓰려면 먼저 Node.js가 필요합니다. 설치한 뒤 이 앱을 다시 켜고 "다시 확인"을 누르세요.` }),
      el('div', { className: 'row' }, [
        el('button', { className: 'btn primary', textContent: 'Node.js 내려받기', onclick: () => window.term.openNode() }),
        el('button', { className: 'btn', textContent: '다시 확인', onclick: () => window.term.recheck() }),
      ]),
    ] : [
      el('p', { textContent: `처음 한 번 ${t.name} 설치가 필요합니다. 1~2분 정도 걸립니다.` }),
      el('div', { className: 'row' }, [
        el('button', { className: 'btn primary', textContent: '설치하기', onclick: () => start(t.id, 'install') }),
        el('button', { className: 'btn', textContent: '다시 확인', onclick: () => window.term.recheck() }),
        el('code', { textContent: `npm install -g ${t.pkg}`, title: '직접 설치하려면 이 명령을 실행하세요' }),
      ]),
    ]);
  }

  // 1) 폴더
  const nameInput = el('input', {
    className: 'text',
    value: projectName,
    maxLength: 60,
    oninput: () => { projectName = nameInput.value; },
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); makeProject(); } },
  });
  nameInput.setAttribute('aria-label', '새 프로젝트 폴더 이름');
  const makeProject = async () => {
    const r = await window.term.newProject(t.id, nameInput.value);
    if (r && r.path) { picked[t.id] = r.path; startMsg = null; }
    else startMsg = { id: t.id, text: (r && r.error) || '폴더를 만들지 못했습니다.' };
    render();
  };
  const recent = st.recent.map((p) => el('div', { className: 'recent-row' }, [
    el('button', { className: `pick${p === cwd ? ' sel' : ''}`, textContent: p, title: p, onclick: () => { picked[t.id] = p; startMsg = null; render(); } }),
    el('button', { className: 'x', textContent: '×', title: '목록에서 빼기', onclick: () => window.term.forgetRecent(p) }),
  ]));
  const folderBody = el('div', {}, [
    el('div', { className: `cur${cwd ? '' : ' empty'}`, textContent: cwd || '아직 고르지 않았습니다', title: cwd || '' }),
    el('div', { className: 'folder-actions' }, [
      el('span', { className: 'muted', textContent: '새로 시작:' }),
      nameInput,
      el('button', { className: 'btn', textContent: '새 프로젝트 만들기', title: '문서\\AI Hub 프로젝트 안에 새 폴더를 만듭니다', onclick: makeProject }),
      el('span', { className: 'muted', textContent: '또는' }),
      el('button', {
        className: 'btn',
        textContent: '기존 폴더 선택…',
        onclick: async () => {
          const p = await window.term.pickFolder(t.id);
          if (p) { picked[t.id] = p; startMsg = null; render(); }
        },
      }),
    ]),
    recent.length ? el('details', { className: 'recent', open: !cwd }, [el('summary', { textContent: '최근 폴더' }), ...recent]) : null,
  ]);

  // 2) 시작
  const startBtn = el('button', { className: 'btn primary', textContent: `${t.name} 시작`, disabled: !cwd || missing || checking, onclick: () => start(t.id) });
  startBtn.id = 'start-btn';
  const startBody = el('div', {}, [
    el('p', { className: 'muted', textContent: `처음 한 번은 ${t.login} 로그인 화면이 나옵니다. 그다음 "이 폴더를 믿을까요?"라고 물으면 Enter를 누르면 됩니다.` }),
    el('div', { className: 'go' }, [startBtn, cwd && !missing && !checking ? el('span', { className: 'muted' }, [el('kbd', { textContent: 'Enter' }), ' 로도 시작']) : null]),
  ]);

  // 3) 말로 시키기
  const exBody = el('div', {}, [
    el('p', { className: 'muted', textContent: '채팅하듯 한국어로 하고 싶은 일을 쓰면, 파일을 직접 만들고 고치고 실행해서 확인합니다. 파일을 바꾸거나 명령을 실행하기 전에는 허락을 물어봅니다.' }),
    el('ul', { className: 'examples' }, EXAMPLES.map((x) => el('li', { textContent: `“${x}”` }))),
  ]);

  $('#start').replaceChildren(el('div', { className: 'card' }, [
    el('h2', {}, [el('span', { className: 'dot' }), `${t.service}로 코딩하기`]),
    el('p', { className: 'lead', textContent: `${t.name}가 내 PC의 폴더 안에서 직접 코드를 만들고, 실행해 보고, 고칩니다. 결과물은 그 폴더에 파일로 남습니다.` }),
    install,
    step(1, '작업할 폴더 고르기', folderBody, !!cwd),
    step(2, '시작하기', startBody, false),
    step(3, '하고 싶은 일을 말하기', exBody, false),
    startMsg && startMsg.id === t.id ? el('div', { className: 'msg error', textContent: startMsg.text }) : null,
    el('div', { className: 'tips' }, [
      el('b', { textContent: '알아 두면 좋은 점' }),
      el('ul', {}, TIPS.map((x) => el('li', { textContent: x }))),
    ]),
  ]));
}

function focusActive() {
  const t = tool();
  if (!t) return;
  const s = sessions[t.id];
  if (s && !s.host.hidden) s.term.focus();
  else { const b = $('#start-btn'); if (b && !b.disabled) b.focus(); }
}

// ───────── 이벤트 ─────────

$('#cwd').addEventListener('click', () => { const t = tool(); if (t && t.session) window.term.openFolder(t.session.cwd); });
$('#shell').addEventListener('click', () => { const t = tool(); if (t && t.session) window.term.openShell(t.session.cwd); });
$('#restart').addEventListener('click', () => {
  const t = tool();
  if (!t || !t.session) return;
  if (t.session.running) { confirmFor = { id: t.id, action: 'restart' }; render(); } else restart(t.id);
});
$('#end').addEventListener('click', () => {
  const t = tool();
  if (!t || !t.session) return;
  if (t.session.running) { confirmFor = { id: t.id, action: 'end' }; render(); } else endSession(t.id);
});

// 시작 화면에서 Enter = 시작
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || $('#start').hidden || e.target.closest('button, input, summary')) return;
  const t = tool();
  if (t && folderOf(t) && t.installed === true) { e.preventDefault(); start(t.id); }
});

// 파일을 끌어다 놓으면 경로를 입력 (공백이 있으면 따옴표)
const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
document.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  const t = tool();
  $('#drop-hint').hidden = !(t && t.session && t.session.running);
});
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) $('#drop-hint').hidden = true; });
document.addEventListener('drop', (e) => {
  $('#drop-hint').hidden = true;
  if (!hasFiles(e)) return;
  e.preventDefault();
  const t = tool();
  if (!t || !t.session || !t.session.running) return;
  const paths = [...e.dataTransfer.files].map((f) => window.term.pathOf(f)).filter(Boolean).map((p) => (/\s/.test(p) ? `"${p}"` : p));
  if (paths.length) { onInput(t.id, `${paths.join(' ')} `); sessions[t.id].term.focus(); }
});

window.term.onState((next) => {
  const prevActive = st && st.active;
  st = next;
  for (const t of st.tools) {
    const s = sessions[t.id];
    if (t.session && t.session.buffer !== undefined) {
      // 화면을 새로 그리는 경우(처음 열기·뷰 재시작) — 지금까지의 출력을 되살린다
      const ss = ensureTerm(t.id);
      ss.term.reset();
      ss.term.write(t.session.buffer);
      ss.kind = t.session.kind;
      ss.exited = !t.session.running;
      if (ss.exited) showEnded(t.id, ss, t.session.exitCode, t.session.kind);
    } else if (!t.session && s && !launching[t.id]) {
      s.exited = false;
      s.ended.hidden = true;
    }
  }
  for (const s of Object.values(sessions)) {
    if (s.term.options.fontSize !== st.fontSize) s.term.options.fontSize = st.fontSize;
  }
  render();
  for (const id of Object.keys(sessions)) scheduleFit(id);
  if (st.active !== prevActive) setTimeout(focusActive, 0);
});
window.term.onData(({ id, data }) => {
  const s = sessions[id];
  if (!s) return;
  s.term.write(data);
  // 시작하고 3분 안에 나오는 질문 화면을 알아보고 한 번씩 안내
  if (s.kind !== 'run' || Date.now() - s.startedAt > 180000) return;
  s.scan = ((s.scan || '') + data.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ' ')).slice(-4000); // 문장이 여러 조각으로 나뉘어 와도 찾도록
  const h = HINTS.find((x) => !s.hintsSeen.has(x.key) && x.re.test(s.scan));
  if (h) {
    s.hintsSeen.add(h.key);
    s.scan = ''; // 같은 글자로 다음 안내가 또 걸리지 않게
    showHint(s, h.text);
  }
});

function showHint(s, text) {
  s.hint.replaceChildren(el('span', { textContent: text }), el('button', { className: 'x', textContent: '×', title: '닫기', onclick: () => { s.hint.hidden = true; s.term.focus(); } }));
  s.hint.hidden = false;
}
window.term.onExit(onExit);
window.term.onFocus(() => focusActive());
window.term.ready();
