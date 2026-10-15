'use strict';
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { SERVICES } = require('./services');
const shortcuts = require('./shortcuts');

const FILE = () => path.join(app.getPath('userData'), 'config.json');
const SERVICE_IDS = SERVICES.map((s) => s.id);
const HISTORY_MAX = 100;
const HISTORY_TEXT_MAX = 20000;

// 설정 화면에서 고를 수 있는 전역 단축키 (자유 입력 대신 프리셋 — 잘못된 조합으로 등록 실패하는 일을 막는다)
const HOTKEYS = [
  { value: 'Control+Shift+Space', label: 'Ctrl + Shift + Space' },
  { value: 'Control+Alt+Space', label: 'Ctrl + Alt + Space' },
  { value: 'Control+Shift+A', label: 'Ctrl + Shift + A' },
  { value: 'Alt+Q', label: 'Alt + Q' },
  { value: '', label: '사용 안 함' },
];
const STARTUP_LAYOUTS = ['remember', 'single', 'split'];

function defaultSettings() {
  return {
    enterToSend: true, // false면 Ctrl+Enter 전송
    clearAfterSend: true,
    newChat: false, // 동시 질문을 각 서비스의 새 대화에서 시작
    saveHistory: true,
    startupLayout: 'remember',
    preloadAll: true,
    enabledServices: [...SERVICE_IDS],
    globalHotkey: HOTKEYS[0].value,
    closeToTray: false,
    alwaysOnTop: false,
    autoUpdate: true, // 새 버전 자동 확인·다운로드
    loginInBrowser: true, // 로그인 화면은 앱 대신 Chrome/Edge에서 (Google 패스키·보안 확인이 앱 안에서 막히므로)
    shortcuts: {}, // 기본값에서 바꾼 앱 단축키만 { actionId: 조합 | '' } — shortcuts.js 참고
  };
}

/** 설정 값 하나를 검증. 유효하지 않으면 undefined */
function validateSetting(key, value) {
  const d = defaultSettings();
  if (!(key in d)) return undefined;
  if (typeof d[key] === 'boolean') return typeof value === 'boolean' ? value : undefined;
  if (key === 'startupLayout') return STARTUP_LAYOUTS.includes(value) ? value : undefined;
  if (key === 'globalHotkey') return HOTKEYS.some((h) => h.value === value) ? value : undefined;
  if (key === 'shortcuts') return shortcuts.normalizeOverrides(value);
  if (key === 'enabledServices') {
    if (!Array.isArray(value)) return undefined;
    const ids = SERVICE_IDS.filter((id) => value.includes(id));
    return ids.length ? ids : undefined;
  }
  return undefined;
}

function normalizeSettings(saved) {
  const out = defaultSettings();
  if (!isObj(saved)) return out;
  for (const key of Object.keys(out)) {
    const v = validateSetting(key, saved[key]);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

function defaults() {
  const accounts = {};
  const activeAccount = {};
  for (const id of SERVICE_IDS) {
    // 첫 계정의 partition은 서비스 id 그대로 — 나중에 계정을 추가해도 기존 로그인이 유지된다
    accounts[id] = [{ id: `${id}-1`, label: '계정 1', partition: `persist:${id}` }];
    activeAccount[id] = `${id}-1`;
  }
  return {
    bounds: { width: 1400, height: 900 },
    maximized: false,
    activeService: SERVICE_IDS[0],
    layout: 'single', // 'single' | 'split'
    splitServices: [...SERVICE_IDS],
    broadcastOpen: false,
    accounts,
    activeAccount,
    zoom: {}, // accountId -> zoomFactor
    broadcastTargets: [...SERVICE_IDS],
    history: [], // 최근 동시 질문 (최신이 앞) — { id, text, at, chats: { serviceId: { accountId, url } } }
    serviceOrder: [...SERVICE_IDS], // 탭 순서 (드래그로 변경)
    sidebarOpen: true, // 질문 기록 사이드바는 기본으로 열림
    composerHeight: null, // 동시 질문 바 높이 — null이면 내용에 맞춰 자동, 숫자면 사용자가 드래그로 정한 높이
    onboarded: false, // 처음 실행 안내를 봤는지
    settings: defaultSettings(),
  };
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v) => Number.isInteger(v);

function normalizeBounds(b, fallback) {
  if (!isObj(b)) return fallback;
  const out = {
    width: isInt(b.width) ? Math.min(Math.max(b.width, 640), 10000) : fallback.width,
    height: isInt(b.height) ? Math.min(Math.max(b.height, 420), 10000) : fallback.height,
  };
  if (isInt(b.x) && isInt(b.y)) { out.x = b.x; out.y = b.y; }
  return out;
}

// seenIds는 모든 서비스가 공유 — Hub가 계정 id 하나로 뷰를 찾기 때문에 서비스 간에도 겹치면 안 된다
function normalizeAccounts(serviceId, list, fallback, seenIds) {
  if (!Array.isArray(list)) return fallback;
  const seenPartitions = new Set();
  const out = [];
  for (const a of list) {
    if (!isObj(a) || typeof a.id !== 'string' || typeof a.partition !== 'string') continue;
    // 다른 서비스의 저장소를 가리키는 손상된 항목은 버린다
    const okPartition = a.partition === `persist:${serviceId}` || a.partition.startsWith(`persist:${serviceId}-`);
    if (!okPartition || seenIds.has(a.id) || seenPartitions.has(a.partition)) continue;
    seenIds.add(a.id);
    seenPartitions.add(a.partition);
    const label = typeof a.label === 'string' && a.label.trim() ? a.label.trim().slice(0, 30) : `계정 ${out.length + 1}`;
    out.push({ id: a.id, label, partition: a.partition });
  }
  if (out.length) return out;
  fallback.forEach((a) => seenIds.add(a.id));
  return fallback;
}

/** 예전 형식(문자열)도 받아서 { id, text, at, chats } 로 맞춘다 */
function normalizeHistoryEntry(h, accountIds) {
  if (typeof h === 'string') h = { text: h };
  if (!isObj(h) || typeof h.text !== 'string' || !h.text.trim()) return null;
  const chats = {};
  if (isObj(h.chats)) {
    for (const [sid, c] of Object.entries(h.chats)) {
      if (!SERVICE_IDS.includes(sid) || !isObj(c) || typeof c.url !== 'string' || !c.url.startsWith('https://')) continue;
      if (!accountIds.has(c.accountId)) continue; // 삭제된 계정의 대화는 열 수 없다
      chats[sid] = { accountId: c.accountId, url: c.url.slice(0, 2000) };
    }
  }
  return {
    id: typeof h.id === 'string' && h.id ? h.id.slice(0, 40) : Math.random().toString(36).slice(2),
    text: h.text.slice(0, HISTORY_TEXT_MAX),
    at: Number.isFinite(h.at) ? h.at : 0,
    chats,
    files: Array.isArray(h.files) ? h.files.filter((n) => typeof n === 'string').map((n) => n.slice(0, 200)).slice(0, 10) : [],
  };
}

/** 저장된 JSON을 신뢰하지 않고 필드마다 검증해 정상 상태로 만든다 */
function normalize(saved) {
  const base = defaults();
  if (!isObj(saved)) return base;

  const accounts = {};
  const activeAccount = {};
  const savedAccounts = isObj(saved.accounts) ? saved.accounts : {};
  const savedActive = isObj(saved.activeAccount) ? saved.activeAccount : {};
  const seenIds = new Set();
  for (const id of SERVICE_IDS) {
    accounts[id] = normalizeAccounts(id, savedAccounts[id], base.accounts[id], seenIds);
    const ids = accounts[id].map((a) => a.id);
    activeAccount[id] = ids.includes(savedActive[id]) ? savedActive[id] : ids[0];
  }

  const allAccountIds = new Set(Object.values(accounts).flat().map((a) => a.id));
  const zoom = {};
  if (isObj(saved.zoom)) {
    for (const [k, v] of Object.entries(saved.zoom)) {
      if (allAccountIds.has(k) && Number.isFinite(v) && v >= 0.25 && v <= 5) zoom[k] = v;
    }
  }

  const split = Array.isArray(saved.splitServices) ? SERVICE_IDS.filter((id) => saved.splitServices.includes(id)) : [];
  const targets = Array.isArray(saved.broadcastTargets) ? SERVICE_IDS.filter((id) => saved.broadcastTargets.includes(id)) : [];
  const history = Array.isArray(saved.history)
    ? saved.history.map((h) => normalizeHistoryEntry(h, allAccountIds)).filter(Boolean).slice(0, HISTORY_MAX)
    : [];
  // 순서는 모든 서비스를 정확히 한 번씩 포함해야 한다 (저장 이후 새 서비스가 생기면 뒤에 붙인다)
  const savedOrder = Array.isArray(saved.serviceOrder) ? saved.serviceOrder.filter((id, i, a) => SERVICE_IDS.includes(id) && a.indexOf(id) === i) : [];
  const serviceOrder = [...savedOrder, ...SERVICE_IDS.filter((id) => !savedOrder.includes(id))];

  return {
    bounds: normalizeBounds(saved.bounds, base.bounds),
    maximized: saved.maximized === true,
    activeService: SERVICE_IDS.includes(saved.activeService) ? saved.activeService : base.activeService,
    layout: saved.layout === 'split' ? 'split' : 'single',
    splitServices: split.length ? split : base.splitServices,
    broadcastOpen: saved.broadcastOpen === true,
    accounts,
    activeAccount,
    zoom,
    broadcastTargets: targets.length ? targets : base.broadcastTargets,
    history,
    serviceOrder,
    sidebarOpen: typeof saved.sidebarOpen === 'boolean' ? saved.sidebarOpen : base.sidebarOpen,
    composerHeight: isInt(saved.composerHeight) && saved.composerHeight >= 80 && saved.composerHeight <= 4000 ? saved.composerHeight : null,
    onboarded: saved.onboarded === true,
    settings: normalizeSettings(saved.settings),
  };
}

let state = null;
let saveTimer = null;

function load() {
  try {
    // 메모장 등으로 직접 고친 파일은 BOM이 붙어 있을 수 있다
    state = normalize(JSON.parse(fs.readFileSync(FILE(), 'utf8').replace(/^﻿/, '')));
  } catch {
    state = defaults();
  }
  return state;
}

function get() {
  return state || load();
}

/** 잦은 변경(창 이동 등)을 묶어서 0.5초 뒤 한 번만 기록 */
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 500);
}

function flush() {
  clearTimeout(saveTimer);
  if (!state) return;
  const file = FILE();
  const tmp = file + '.tmp';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, file); // 쓰는 도중 종료돼도 기존 파일이 깨지지 않게
  } catch (err) {
    console.error('[store] 설정 저장 실패:', err);
  }
}

module.exports = { get, save, flush, validateSetting, HOTKEYS, HISTORY_MAX, HISTORY_TEXT_MAX };
