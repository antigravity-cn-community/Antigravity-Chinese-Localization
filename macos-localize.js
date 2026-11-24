'use strict';

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { execFileSync } = require('child_process');
const { readAsarHeader, readAsarPackageVersion } = require('./asar-version');
const { httpError } = require('./src/http-security');

const GOOGLE_REQUIREMENT = 'identifier "com.google.antigravity" and anchor apple generic and certificate leaf[subject.OU] = "EQHXZ8M8AV"';
const ASAR = 'Contents/Resources/app.asar';
const PLIST = 'Contents/Info.plist';
const INTEGRITY = ':ElectronAsarIntegrity:Resources/app.asar';
const UNPACKED = 'node_modules/chrome-devtools-mcp';

function bundleAt(appDir) {
  const bundle = path.dirname(appDir);
  if (path.basename(appDir) !== 'Contents' || !bundle.endsWith('.app') ||
      fs.realpathSync(bundle) !== path.join(fs.realpathSync(path.dirname(bundle)), path.basename(bundle)) ||
      !fs.lstatSync(appDir).isDirectory()) {
    throw httpError('请选择 Antigravity 的 .app 应用包。', 400);
  }
  return fs.realpathSync(bundle);
}

function macBackupPath(appDir, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || path.basename(appDir) !== 'Contents') return null;
  const bundle = path.dirname(appDir);
  return bundle.endsWith('.app') ? `${bundle}.google-${version}.backup` : null;
}

function run(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    throw new Error(`${path.basename(command)} 执行失败: ${(error.stderr || error.stdout || error.message).trim()}`);
  }
}

function macBundleRunning(bundle) {
  const executables = run('/bin/ps', ['-ww', '-axo', 'comm=']);
  const prefix = `${fs.realpathSync(bundle)}/Contents/`;
  return executables.split('\n').some(line => {
    const executable = line.trimStart();
    return executable.startsWith(prefix) || executable.startsWith('/System/Volumes/Data' + prefix);
  });
}

function assertStopped(bundle) {
  if (macBundleRunning(bundle)) {
    throw httpError('请保存工作并从菜单正常退出目标 Antigravity，再重新执行。', 409);
  }
}

function verifyGoogle(bundle) {
  if (!fs.lstatSync(bundle).isDirectory()) throw new Error('官方应用备份必须是实际目录。');
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R=' + GOOGLE_REQUIREMENT, bundle]);
}

function readArchive(archive) {
  const fd = fs.openSync(archive, 'r');
  try {
    const { json } = readAsarHeader(fd);
    return { hash: createHash('sha256').update(json).digest('hex'), tree: JSON.parse(json) };
  } finally {
    fs.closeSync(fd);
  }
}

function archiveLayout(tree, prefix = '') {
  return Object.keys(tree.files).sort().flatMap(name => {
    const entry = tree.files[name];
    const relative = prefix + name;
    return [
      [relative, entry.unpacked === true, entry.link || null, Boolean(entry.files)],
      ...(entry.files ? archiveLayout(entry, relative + '/') : []),
    ];
  });
}

function bundleVersion(bundle) {
  return run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(bundle, PLIST)]).trim();
}

function installMacLocalization(appDir, { versions, applyTranslations, runAsarCli, log }) {
  const bundle = bundleAt(appDir);
  assertStopped(bundle);
  verifyGoogle(bundle);
  if (run('/usr/bin/xattr', [bundle]).split('\n').includes('com.apple.quarantine')) {
    throw httpError('请先用访达正常打开 Google 官方应用并退出，再重新执行汉化。', 409);
  }
  const version = bundleVersion(bundle);
  if (!versions.includes(version) || readAsarPackageVersion(path.join(bundle, ASAR)) !== version) {
    throw httpError(`当前 macOS 客户端 ${version} 版本不匹配或暂未适配。支持版本：${versions.join('、')}。`, 409);
  }

  const identities = run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']);
  const identity = identities.match(/^\s*\d+\)\s+([0-9A-F]{40})\s+"Apple Development: /m)?.[1];
  if (!identity) {
    throw httpError('需要钥匙串中有效的 Apple Development 证书与私钥。请在 Xcode 的 Accounts 中创建签名身份后重试。', 400);
  }
  const backup = macBackupPath(path.join(bundle, 'Contents'), version);
  assertBackupAbsent(backup);
  const transaction = prepareTransaction(bundle);
  const staged = path.join(transaction, path.basename(bundle));
  try {
    log('正在复制并验签 Google 官方应用…');
    run('/usr/bin/ditto', [bundle, staged]);
    verifyGoogle(staged);
    const archive = path.join(staged, ASAR);
    const plist = path.join(staged, PLIST);
    const original = readArchive(archive);
    const algorithm = run('/usr/libexec/PlistBuddy', ['-c', 'Print ' + INTEGRITY + ':algorithm', plist]).trim();
    const originalHash = run('/usr/libexec/PlistBuddy', ['-c', 'Print ' + INTEGRITY + ':hash', plist]).trim();
    if (algorithm !== 'SHA256' || originalHash !== original.hash) throw new Error('官方 ASAR 完整性校验失败。');

    const extracted = path.join(transaction, 'extracted');
    const repacked = path.join(transaction, 'app.asar');
    log('正在从同版本官方 ASAR 构建汉化…');
    runAsarCli(['extract', archive, extracted]);
    applyTranslations(extracted);
    runAsarCli(['pack', extracted, repacked, '--unpack', path.join(extracted, UNPACKED, '**')]);
    const updated = readArchive(repacked);
    if (readAsarPackageVersion(repacked) !== version ||
        JSON.stringify(archiveLayout(original.tree)) !== JSON.stringify(archiveLayout(updated.tree))) {
      throw new Error('重新打包后的 ASAR 版本或解包布局发生变化。');
    }
    run('/usr/bin/diff', ['-qr', archive + '.unpacked', repacked + '.unpacked']);
    fs.renameSync(repacked, archive);
    run('/usr/libexec/PlistBuddy', ['-c', 'Set ' + INTEGRITY + ':hash ' + updated.hash, plist]);

    log('正在用本机 Apple Development 身份签名并校验整包…');
    const sign = ['--force', '--sign', identity, '--timestamp=none', '--preserve-metadata=identifier,entitlements,flags,runtime'];
    const libraries = path.join(staged, 'Contents/Frameworks/Electron Framework.framework/Versions/Current/Libraries');
    // --deep does not sign these framework libraries, which must match the app's team.
    for (const file of fs.readdirSync(libraries).filter(name => name.endsWith('.dylib'))) {
      run('/usr/bin/codesign', [...sign, path.join(libraries, file)]);
    }
    run('/usr/bin/codesign', [...sign, '--deep', staged]);
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', staged]);

    assertStopped(bundle);
    verifyGoogle(bundle);
    if (readArchive(path.join(bundle, ASAR)).hash !== original.hash || bundleVersion(bundle) !== version) {
      throw new Error('官方应用在汉化准备期间发生变化，请重新执行。');
    }
    swapBundles(bundle, staged, backup);
    log(`汉化安装完成。Google 原版整包备份：${backup}`);
  } finally {
    fs.rmSync(transaction, { recursive: true, force: true });
  }
}

function assertBackupAbsent(destination) {
  if (fs.lstatSync(destination, { throwIfNoEntry: false })) {
    throw httpError(`备份路径已存在，请先将原备份移到安全位置：${destination}`, 409);
  }
}

function prepareTransaction(bundle) {
  const transaction = bundle + '.localization-work';
  try {
    fs.mkdirSync(transaction, { mode: 0o700 });
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw httpError(`已有安装或恢复目录，请确认任务已结束并检查其中的应用备份：${transaction}`, 409);
    }
    throw error;
  }
  return transaction;
}

function swapBundles(bundle, staged, saved) {
  assertBackupAbsent(saved);
  fs.renameSync(bundle, saved);
  try {
    fs.renameSync(staged, bundle);
  } catch (error) {
    try {
      fs.renameSync(saved, bundle);
    } catch (_) {
      throw new Error(`应用交换失败。切换前的整包仍保存在：${saved}`);
    }
    throw error;
  }
}

function restoreMacLocalization(appDir, log) {
  const bundle = bundleAt(appDir);
  assertStopped(bundle);
  const version = bundleVersion(bundle);
  const backup = macBackupPath(path.join(bundle, 'Contents'), version);
  if (!backup || !fs.lstatSync(backup, { throwIfNoEntry: false })) {
    throw httpError('缺少当前版本的 Google 整包备份。请使用 Google 官方安装包恢复。', 400);
  }
  verifyGoogle(backup);
  if (readAsarPackageVersion(path.join(backup, ASAR)) !== version || bundleVersion(backup) !== version) {
    throw httpError('Google 整包备份的版本不匹配。', 409);
  }

  const transaction = prepareTransaction(bundle);
  const saved = path.join(transaction, 'localized.backup');
  try {
    assertStopped(bundle);
    swapBundles(bundle, backup, saved);
    fs.rmSync(saved, { recursive: true });
    log('已恢复 Google 签名的官方应用。');
  } finally {
    // If rollback failed, preserve the saved bundle and its path from the error.
    if (!fs.lstatSync(saved, { throwIfNoEntry: false })) fs.rmdirSync(transaction);
  }
}

module.exports = { installMacLocalization, macBackupPath, macBundleRunning, restoreMacLocalization };
