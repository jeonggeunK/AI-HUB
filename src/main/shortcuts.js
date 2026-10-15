'use strict';
/**
 * 앱 안 단축키 — 사용자가 설정에서 바꿀 수 있다.
 *
 * 조합은 "Ctrl+Shift+KeyB"처럼 수식키(Ctrl·Alt·Shift 순) + KeyboardEvent.code 로 적는다.
 * key 대신 code를 쓰는 이유: 한글 입력 중에도(ㅠ 대신 KeyB), Shift를 눌러도(! 대신 Digit1) 같은 값이 나온다.
 * 설정에는 기본값에서 바꾼 것만 저장한다 — 나중에 기본값을 고쳐도 바꾸지 않은 사람에게 그대로 반영되게.
 */

const ACTIONS = [
  { id: 'broadcast', label: '동시 질문 열기/닫기', key: 'Ctrl+Shift+KeyB' },
  { id: 'split', label: '분할 화면', key: 'Ctrl+Backslash' },
  { id: 'settings', label: '설정', key: 'Ctrl+Comma' },
  { id: 'sidebar', label: '질문 기록', key: 'Ctrl+KeyH' },
  { id: 'newChat', label: '선택한 탭 새 대화', key: 'Ctrl+KeyN' },
  { id: 'newChatAll', label: '전체 탭 새 대화', key: 'Ctrl+Shift+KeyN' },
  { id: 'nextTab', label: '다음 탭', key: 'Ctrl+Tab' },
  { id: 'prevTab', label: '이전 탭', key: 'Ctrl+Shift+Tab' },
  { id: 'back', label: '뒤로', key: 'Alt+ArrowLeft' },
  { id: 'forward', label: '앞으로', key: 'Alt+ArrowRight' },
  { id: 'reload', label: '새로고침', key: 'Ctrl+KeyR' },
  { id: 'hardReload', label: '새로고침 (캐시 무시)', key: 'Ctrl+Shift+KeyR' },
  { id: 'zoomIn', label: '확대', key: 'Ctrl+Equal' },
  { id: 'zoomOut', label: '축소', key: 'Ctrl+Minus' },
  { id: 'zoomReset', label: '원래 크기', key: 'Ctrl+Digit0' },
  { id: 'help', label: '사용 안내', key: 'F1' },
];
const byId = Object.fromEntries(ACTIONS.map((a) => [a.id, a]));

const MODS = ['Ctrl', 'Alt', 'Shift'];
const CODE_RE = /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-2])|Numpad[0-9]|Numpad(Add|Subtract|Multiply|Divide|Decimal)|Backslash|Comma|Period|Slash|Semicolon|Quote|BracketLeft|BracketRight|Minus|Equal|Backquote|Arrow(Left|Right|Up|Down)|Tab|Space|Enter|Backspace|Delete|Insert|Home|End|PageUp|PageDown)$/;

// 글 편집·탭 번호(Ctrl+1~9)·전송(Ctrl+Enter)처럼 이미 정해진 동작과 겹치는 조합
const RESERVED = new Set([
  'Ctrl+KeyA', 'Ctrl+KeyC', 'Ctrl+KeyV', 'Ctrl+KeyX', 'Ctrl+KeyZ', 'Ctrl+KeyY', 'Ctrl+Shift+KeyZ',
  'Ctrl+Enter', 'Alt+F4', 'Ctrl+Backspace', 'Ctrl+Delete',
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `Ctrl+Digit${n}`),
]);

/** Electron before-input-event의 input → 조합 문자열 (수식키만 눌렀으면 null) */
function comboFromInput(input) {
  const code = input.code;
  if (!code || /^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/.test(code)) return null;
  const mods = [];
  if (input.control || input.meta) mods.push('Ctrl');
  if (input.alt) mods.push('Alt');
  if (input.shift) mods.push('Shift');
  return [...mods, code].join('+');
}

/** 단축키로 쓸 수 없는 조합이면 이유를, 쓸 수 있으면 null */
function problem(combo) {
  const parts = String(combo).split('+');
  const code = parts.pop();
  const mods = parts;
  if (!CODE_RE.test(code)) return '이 키는 단축키로 쓸 수 없습니다.';
  const ordered = MODS.filter((m) => mods.includes(m));
  if (mods.length !== ordered.length || mods.some((m, i) => m !== ordered[i])) return '잘못된 조합입니다.';
  // 수식키 없이 글자를 쓰면 입력창에서 타이핑이 막힌다 — F키만 단독으로 허용
  if (!mods.includes('Ctrl') && !mods.includes('Alt') && !/^F\d+$/.test(code)) return 'Ctrl이나 Alt를 함께 눌러 주세요 (F1~F12는 단독으로 가능).';
  if (RESERVED.has(combo)) return '복사·붙여넣기, 탭 번호(Ctrl+1~9)처럼 이미 쓰는 조합이라 지정할 수 없습니다.';
  return null;
}

/** 저장된 바꾼 값 { actionId: 조합 | '' } 을 검증 — 모르는 동작·잘못된 조합은 버린다 ('' = 사용 안 함) */
function normalizeOverrides(v) {
  const out = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [id, combo] of Object.entries(v)) {
    if (!byId[id] || typeof combo !== 'string') continue;
    if (combo === '' || !problem(combo)) out[id] = combo;
  }
  return out;
}

/** 실제로 적용되는 조합 → 동작 id. 겹치면 목록에서 앞선 동작이 이긴다 */
function bindings(overrides) {
  const map = new Map();
  for (const a of ACTIONS) {
    const combo = a.id in overrides ? overrides[a.id] : a.key;
    if (combo && !map.has(combo)) map.set(combo, a.id);
  }
  return map;
}

module.exports = { ACTIONS, byId, comboFromInput, problem, normalizeOverrides, bindings };
