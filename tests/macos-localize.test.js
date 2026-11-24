'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

test('macOS 拒绝正在运行的安装目标，且不创建备份或准备目录', t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'antigravity-mac-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundle = path.join(root, 'Antigravity Test.app');
  const contents = path.join(bundle, 'Contents');
  fs.mkdirSync(contents, { recursive: true });

  const mocked = t.mock.method(childProcess, 'execFileSync', (command, args) => {
    assert.equal(command, '/bin/ps');
    assert.deepEqual(args, ['-ww', '-axo', 'comm=']);
    return `  ${bundle}/Contents/Frameworks/Antigravity Helper.app/Contents/MacOS/Antigravity Helper\n`;
  });
  const { installMacLocalization, restoreMacLocalization } = require('../macos-localize');
  for (const operation of [installMacLocalization, restoreMacLocalization]) {
    assert.throws(() => operation(contents, {}), error =>
      error.statusCode === 409 && error.message.includes('正常退出')
    );
  }
  assert.equal(mocked.mock.callCount(), 2);
  assert.deepEqual(fs.readdirSync(root), ['Antigravity Test.app']);
});
