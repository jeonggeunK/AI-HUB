# AI Hub

Claude, ChatGPT, Gemini를 한 창에서 쓰려고 만든 Windows 앱입니다.
탭으로 왔다 갔다 하거나 화면을 나눠서 같이 볼 수 있고, 질문 하나를 세 곳에 한 번에 보낼 수도 있습니다.

## 설치

[Releases](https://github.com/jeonggeunK/AI-HUB/releases)에서 `AI Hub Setup x.x.x.exe`를 받아 설치하면 됩니다.
코드 서명이 없어서 처음에 "Windows의 PC 보호" 창이 뜨는데, "추가 정보 → 실행"을 누르면 됩니다.

한 번 설치하면 이후 버전은 앱이 알아서 받아서 업데이트합니다.

## 주요 기능

- 서비스별 탭, 분할 화면 (`Ctrl+\`)
- 동시 질문: 아래 입력창에 쓰고 Enter (`Ctrl+Shift+B`로 열고 닫기)
  - 파일/이미지 첨부 가능 (클립, 드래그, 붙여넣기)
  - "새 대화로"를 체크하면 각 서비스에서 새 대화로 시작
- 질문 기록 (`Ctrl+H`): 보냈던 질문을 누르면 그때 대화들을 다시 열어 줌
- 서비스마다 계정 여러 개 등록해서 전환
- 새 대화: 탭의 `+`는 그 서비스만, "전체 새 대화"(`Ctrl+Shift+N`)는 전부
- 탭 순서는 드래그로 변경
- 어디서든 `Ctrl+Shift+Space`로 불러와서 바로 질문

단축키 전체 목록은 설정(`Ctrl+,`) → 단축키에 있습니다.

## 로그인

Google 로그인은 앱 안에서 막히는 경우가 많아서, 로그인 버튼을 누르면 Chrome 창이 따로 열립니다.
거기서 로그인하고 **Chrome 창을 닫으면** 앱으로 로그인이 넘어옵니다. (Chrome이 없으면 Edge)

평소 쓰는 Chrome 프로필은 건드리지 않고, 로그인용으로 잠깐 만든 프로필은 끝나면 지웁니다.

## 개발

```
npm install
npm start          # 실행
npm run dev        # F12로 각 탭 개발자 도구
npm run dist       # 설치 파일만 만들기 (dist/)
npm run release    # 버전 올리고 GitHub Releases에 배포
```

VS Code 터미널에서 창이 안 뜨면 `ELECTRON_RUN_AS_NODE` 환경변수 때문이니 지우고 실행하세요.

### 배포

`npm run release`는 GitHub 토큰이 필요합니다. 처음에 한 번만 설정하면 됩니다.

1. [토큰 만들기](https://github.com/settings/personal-access-tokens/new) — 저장소는 AI-HUB만, Contents 권한 Read and write
2. `setx GH_TOKEN "토큰"` 실행 후 터미널 다시 열기

이후엔 `npm run release`만 하면 버전 끝자리가 하나 올라가고 Releases에 올라갑니다. 크게 바뀌었으면 `npm run release -- minor`.

### 구조

```
src/main/
  main.js          시작, 창, IPC, 트레이, 전역 단축키
  hub.js           탭/레이아웃/계정/기록 관리
  services.js      서비스별 주소와 입력창 셀렉터
  broadcast.js     동시 질문 전송
  attach.js        파일 첨부
  browserLogin.js  Chrome으로 로그인
  security.js      세션, 권한, 팝업 처리
  store.js         설정 저장
  updater.js       자동 업데이트
src/preload/ui.js
src/renderer/      상단바, 입력창, 설정 화면
```

사이트 화면이 바뀌어서 동시 질문이 "입력창을 찾지 못했습니다"로 실패하면 `services.js`의 셀렉터를 고치면 됩니다.

## 참고

- 설정과 로그인 정보는 `%APPDATA%\AI Hub`에 저장됩니다.
- Claude Cowork나 ChatGPT 앱의 Codex처럼 데스크톱 앱에만 있는 기능은 쓸 수 없습니다. 필요하면 탭 메뉴(▾)의 "데스크톱 앱으로 열기"로 원래 앱을 띄우세요.
