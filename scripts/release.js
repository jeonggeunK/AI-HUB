'use strict';
/**
 * 새 버전 배포: npm run release
 *
 * 1. 버전 끝자리를 하나 올린다 (0.1.3 → 0.1.4). 큰 변경이면 `npm run release -- minor` (0.1.3 → 0.2.0)
 * 2. 설치 파일을 만들어 GitHub(jeonggeunK/AI-HUB)의 Releases에 올린다
 * 3. 설치해 둔 앱들은 켤 때(또는 4시간마다) 새 버전을 발견해 자동으로 업데이트한다
 *
 * 필요한 것: GitHub 토큰을 환경변수 GH_TOKEN에 한 번 저장 (README의 "배포" 참고)
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkgFile = path.join(root, 'package.json');

if (!process.env.GH_TOKEN) {
  console.error([
    '',
    '  GH_TOKEN 환경변수가 없습니다. GitHub 토큰을 한 번 저장해 주세요:',
    '',
    '  1) https://github.com/settings/personal-access-tokens/new 에서 토큰 만들기',
    '     - Repository access: Only select repositories → AI-HUB',
    '     - Permissions → Repository permissions → Contents: Read and write',
    '  2) PowerShell에서:  setx GH_TOKEN "발급받은_토큰"',
    '  3) 터미널(VS Code)을 완전히 껐다가 다시 열고 npm run release',
    '',
  ].join('\n'));
  process.exit(1);
}

// 1. 버전 올리기 (package.json을 UTF-8로 직접 읽고 써서 한글 설명이 깨지지 않게)
const bump = ['major', 'minor', 'patch'].includes(process.argv[2]) ? process.argv[2] : 'patch';
const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
const [major, minor, patch] = pkg.version.split('.').map(Number);
const next = bump === 'major' ? `${major + 1}.0.0` : bump === 'minor' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
pkg.version = next;
fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
console.log(`\n  버전 ${major}.${minor}.${patch} → ${next}\n`);

// 2. 빌드 + GitHub에 올리기 (셸을 거치지 않고 프로젝트의 electron-builder를 직접 실행)
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // VS Code 터미널에서 실행해도 빌드가 정상 동작하도록
const cli = path.join(root, 'node_modules', 'electron-builder', 'cli.js');
const publish = () => spawnSync(process.execPath, [cli, '--win', 'nsis', '--publish', 'always'], {
  cwd: root,
  stdio: 'inherit',
  env,
});
let result = publish();
if (result.status !== 0) {
  // GitHub에 릴리스를 만드는 요청이 동시에 겹쳐 한쪽만 실패하는 경우가 있다.
  // 같은 버전으로 한 번 더 올리면 이미 만들어진 릴리스에 빠진 파일을 채워 넣는다.
  console.log('\n  업로드 중 오류가 나서 같은 버전으로 한 번 더 시도합니다…\n');
  result = publish();
}

if (result.status !== 0) {
  // 버전은 되돌리지 않는다 — 실패 전에 GitHub에 일부가 올라갔을 수 있어서, 같은 번호로 다시 올리면 충돌한다.
  // 그냥 다시 npm run release 하면 다음 번호로 올라간다(번호 하나 건너뛰는 건 문제없음).
  console.error([
    '',
    `  배포에 실패했습니다 (버전은 ${next}로 둡니다).`,
    '  위의 오류를 확인한 뒤 다시 npm run release 하면 다음 버전으로 올라갑니다.',
    `  GitHub Releases에 ${next}가 반쯤 올라가 있으면 지워 주세요: https://github.com/jeonggeunK/AI-HUB/releases`,
    '',
  ].join('\n'));
  process.exit(result.status || 1);
}

console.log([
  '',
  `  배포 완료: ${next}`,
  '  https://github.com/jeonggeunK/AI-HUB/releases',
  '  설치해 둔 앱들은 다음에 켤 때(또는 4시간 안에) 자동으로 업데이트됩니다.',
  '',
].join('\n'));
