'use strict';
/**
 * 코딩 모드 — 각 서비스 탭의 [채팅 | 코딩] 중 코딩. Claude는 Claude Code, ChatGPT는 Codex, Gemini는 Gemini CLI를
 * 앱 안의 터미널(node-pty)에서 실행한다. 도구마다 세션은 하나.
 * 화면(xterm)은 renderer/terminal.html이 그리고, 프로세스는 여기서 관리한다.
 */
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

// service: 이 도구가 들어가는 서비스 탭, login: 처음 실행할 때 로그인하는 계정
const TOOLS = [
  { id: 'claude-code', service: 'claude', name: 'Claude Code', color: '#d97757', command: 'claude', pkg: '@anthropic-ai/claude-code', login: 'Claude 계정' },
  { id: 'codex', service: 'chatgpt', name: 'Codex', color: '#10a37f', command: 'codex', pkg: '@openai/codex', login: 'ChatGPT 계정' },
  { id: 'gemini-cli', service: 'gemini', name: 'Gemini CLI', color: '#4285f4', command: 'gemini', pkg: '@google/gemini-cli', login: 'Google 계정' },
];
const byId = Object.fromEntries(TOOLS.map((t) => [t.id, t]));
const BUFFER_MAX = 512 * 1024; // 화면이 다시 그려질 때(뷰 재시작 등) 되살릴 최근 출력

let pty = null;
function loadPty() {
  if (!pty) pty = require('node-pty'); // 네이티브 모듈 — 코딩 탭을 처음 쓸 때만 불러온다
  return pty;
}

/** 자식 프로세스 환경변수 — 앱(Electron)이나 이 앱을 띄운 도구의 흔적은 지운다 */
function childEnv() {
  const env = { ...process.env, COLORTERM: 'truecolor' };
  for (const k of Object.keys(env)) {
    // ELECTRON_RUN_AS_NODE가 남으면 자식 Electron 앱이 Node로 실행되고,
    // CLAUDECODE가 남으면 Claude Code가 "다른 세션 안"이라며 시작을 거부한다
    if (k.startsWith('ELECTRON_') || k === 'CLAUDECODE' || k === 'CLAUDE_CODE_ENTRYPOINT') delete env[k];
  }
  return env;
}

function isDir(p) {
  try { return typeof p === 'string' && p.length > 0 && fs.statSync(p).isDirectory(); } catch { return false; }
}

class Terminals {
  /** @param {{ onData(id, data), onExit(id, code), onChange() }} hooks */
  constructor(hooks) {
    this.hooks = hooks;
    this.sessions = new Map(); // toolId -> { proc, cwd, buffer, running, kind, exitCode }
    this.installed = {}; // toolId -> true/false (확인 전에는 없음)
    this.hasNpm = undefined; // 설치하려면 Node.js(npm)가 있어야 한다
    this.pending = new Map(); // toolId -> 아직 보내지 않은 출력 (짧게 모아서 보낸다)
  }

  /** where.exe로 설치 여부 확인 */
  checkInstalled() {
    const where = (cmd) => new Promise((resolve) => {
      execFile('where.exe', [cmd], { windowsHide: true, env: childEnv() }, (err) => resolve(!err));
    });
    return Promise.all([
      ...TOOLS.map(async (t) => { this.installed[t.id] = await where(t.command); }),
      where('npm').then((ok) => { this.hasNpm = ok; }),
    ]).then(() => this.hooks.onChange());
  }

  /**
   * 세션 시작. mode: 'run'(도구 실행) | 'install'(npm으로 설치)
   * 이미 실행 중이면 끄고 다시 시작한다.
   */
  start(toolId, cwd, cols, rows, mode = 'run') {
    const tool = byId[toolId];
    if (!tool) return { error: '알 수 없는 도구입니다.' };
    if (!isDir(cwd)) return { error: '작업 폴더를 찾을 수 없습니다. 다시 선택해 주세요.' };
    this.stop(toolId);

    const comspec = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
    // npm 전역 설치는 .cmd 껍데기라 cmd를 거친다
    const file = comspec;
    const args = ['/d', '/s', '/c', mode === 'install' ? `npm install -g ${tool.pkg}` : tool.command];

    let proc;
    try {
      proc = loadPty().spawn(file, args, {
        name: 'xterm-256color',
        cols: Math.max(20, cols | 0) || 120,
        rows: Math.max(5, rows | 0) || 30,
        cwd,
        env: childEnv(),
        useConpty: true,
      });
    } catch (err) {
      return { error: `실행하지 못했습니다: ${err.message}` };
    }

    const s = { proc, cwd, buffer: '', running: true, kind: mode, exitCode: null };
    this.sessions.set(toolId, s);
    proc.onData((data) => {
      if (this.sessions.get(toolId) !== s) return;
      s.buffer += data;
      if (s.buffer.length > BUFFER_MAX) s.buffer = s.buffer.slice(-BUFFER_MAX);
      this.queue(toolId, data);
    });
    proc.onExit(({ exitCode }) => {
      if (this.sessions.get(toolId) !== s) return; // 다시 시작하면서 끈 이전 세션
      this.flush(toolId);
      s.running = false;
      s.exitCode = exitCode;
      this.hooks.onExit(toolId, exitCode, mode);
      if (mode === 'install') this.checkInstalled();
      this.hooks.onChange();
    });
    this.hooks.onChange();
    return { ok: true };
  }

  // 출력이 잘게 쪼개져 오면 IPC가 너무 많아지므로 몇 ms씩 모아 보낸다
  queue(toolId, data) {
    const had = this.pending.has(toolId);
    this.pending.set(toolId, (this.pending.get(toolId) || '') + data);
    if (!had) setTimeout(() => this.flush(toolId), 8);
  }

  flush(toolId) {
    const data = this.pending.get(toolId);
    if (data === undefined) return;
    this.pending.delete(toolId);
    this.hooks.onData(toolId, data);
  }

  write(toolId, data) {
    const s = this.sessions.get(toolId);
    if (s && s.running && typeof data === 'string') s.proc.write(data);
  }

  resize(toolId, cols, rows) {
    const s = this.sessions.get(toolId);
    if (!s || !s.running) return;
    try { s.proc.resize(Math.max(20, cols | 0), Math.max(5, rows | 0)); } catch { /* 종료 직후 등 */ }
  }

  stop(toolId) {
    const s = this.sessions.get(toolId);
    if (!s) return;
    this.sessions.delete(toolId);
    this.pending.delete(toolId);
    if (s.running) { try { s.proc.kill(); } catch { /* 이미 종료 */ } }
    this.hooks.onChange();
  }

  stopAll() {
    for (const id of [...this.sessions.keys()]) this.stop(id);
  }

  runningCount() {
    return [...this.sessions.values()].filter((s) => s.running).length;
  }

  /** 화면에 넘길 세션 요약 (+ 되살리기용 출력) */
  info(toolId, withBuffer = false) {
    const s = this.sessions.get(toolId);
    if (!s) return null;
    return { cwd: s.cwd, running: s.running, kind: s.kind, exitCode: s.exitCode, ...(withBuffer ? { buffer: s.buffer } : {}) };
  }
}

module.exports = { TOOLS, byId, Terminals, isDir, homeDir: os.homedir() };
