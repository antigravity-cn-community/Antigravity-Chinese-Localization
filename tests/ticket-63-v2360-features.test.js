'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { readAsarPackageVersion } = require('../asar-version');
const { loadTranslatorSandbox } = require('./helpers/translator-loader');
const { dictionary } = require('../src/dictionary');

console.log('=== 开始 Ticket-63 Antigravity 2.36.0 版本适配专项测试 ===\n');

const ROOT = path.resolve(__dirname, '..');
let passed = 0;
let total = 0;

function check(desc, actual, expected) {
  total++;
  try {
    assert.deepStrictEqual(actual, expected);
    console.log(`PASS [${total}]: ${desc}`);
    passed++;
  } catch (err) {
    console.error(`FAIL [${total}]: ${desc}`);
    console.error('   期望:', expected);
    console.error('   实际:', actual);
  }
}

// -----------------------------------------------------------------------------
// 1. v2.36.0 版本号与文档元数据一致性
// -----------------------------------------------------------------------------
console.log('--- 1. v2.36.0 版本号与元数据校验 ---');
const localizeSource = fs.readFileSync(path.join(ROOT, 'localize.js'), 'utf-8');
const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
const extractedPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'extracted', 'package.json'), 'utf-8'));
const indexSource = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf-8');
const readmeZh = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf-8');
const readmeEn = fs.readFileSync(path.join(ROOT, 'README.en.md'), 'utf-8');
const archZh = fs.readFileSync(path.join(ROOT, 'docs', 'architecture.md'), 'utf-8');
const archEn = fs.readFileSync(path.join(ROOT, 'docs', 'architecture.en.md'), 'utf-8');
const changelogZh = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf-8');
const changelogEn = fs.readFileSync(path.join(ROOT, 'CHANGELOG.en.md'), 'utf-8');

const cv = (localizeSource.match(/const CURRENT_VERSION = ['"]([^'"]+)['"];/) || [])[1];
const rv = (localizeSource.match(/const RELEASE_VERSION = ['"]([^'"]+)['"];/) || [])[1];
check('localize.js CURRENT_VERSION = 2.36.0', cv, '2.36.0');
check('localize.js RELEASE_VERSION = 2.36.0', rv, '2.36.0');
check('package.json version = 2.36.0', rootPkg.version, '2.36.0');
check('extracted/package.json version = 2.36.0', extractedPkg.version, '2.36.0');
check('index.html 控制中心版本标识 = v2.36.0', indexSource.includes('控制中心 v2.36.0'), true);
check('README.md 标注 Antigravity v2.36.0+', readmeZh.includes('Antigravity v2.36.0+'), true);
check('README.en.md 标注 Antigravity v2.36.0+', readmeEn.includes('Antigravity v2.36.0+'), true);
check('CHANGELOG.md 含 v2.36.0 章节', changelogZh.includes('## v2.36.0'), true);
check('CHANGELOG.en.md 含 v2.36.0 章节', changelogEn.includes('## v2.36.0'), true);
check('architecture.md 含 v2.36.0 瘦身基准', archZh.includes('v2.36.0 约 7.69 MiB'), true);
check('architecture.en.md 含 v2.36.0 瘦身基准', archEn.includes('7.69 MiB on v2.36.0'), true);

// -----------------------------------------------------------------------------
// 2. app.asar.ready 预编译包规格
// -----------------------------------------------------------------------------
console.log('\n--- 2. app.asar.ready 规格校验 ---');
const readyAsarPath = path.join(ROOT, 'app.asar.ready');
check('app.asar.ready 存在', fs.existsSync(readyAsarPath), true);
check('app.asar.ready 归档版本 = 2.36.0', readAsarPackageVersion(readyAsarPath), '2.36.0');
const readySize = fs.statSync(readyAsarPath).size;
check('app.asar.ready 体积符合轻量规范 (3–10 MiB)', readySize > 3 * 1024 * 1024 && readySize < 10 * 1024 * 1024, true);

// -----------------------------------------------------------------------------
// 3. 词典与运行时引擎：2.36.0 新增词条
// -----------------------------------------------------------------------------
console.log('\n--- 3. 2.36.0 新增词条翻译校验 ---');
check('词典规模 >= 5300 键', Object.keys(dictionary).length >= 5300, true);
const engine = loadTranslatorSandbox();
const t = (s) => engine.translateString(s);
const samples = {
  'Search settings': '搜索设置',
  'Network secrets': '网络机密',
  'Feeds': '信息流',
  "You're all caught up": '已全部读完',
  'Approve & proceed': '批准并继续',
  'Environment variables': '环境变量',
  'Organization prepaid wallet is empty': '组织预付钱包余额为空',
  'Your organization has run out of Antigravity funds. Prompt generation is paused until your administrator adds funds.': '你的组织 Antigravity 资金已用尽。在管理员充值前，提示词生成已暂停。'
};
for (const [en, zh] of Object.entries(samples)) {
  check(`新词条 "${en.slice(0, 40)}"`, t(en), zh);
}
check('品牌名 Orchestrator 保持原生', t('Orchestrator'), 'Orchestrator');
check('品牌名 Swarm 保持原生', t('Swarm'), 'Swarm');

// -----------------------------------------------------------------------------
// 4. 实装产物 extracted preload.js / wizardPreload.js
// -----------------------------------------------------------------------------
console.log('\n--- 4. 实装产物注入校验 ---');
const preloadStr = fs.readFileSync(path.join(ROOT, 'extracted', 'dist', 'preload.js'), 'utf-8');
const wizardStr = fs.readFileSync(path.join(ROOT, 'extracted', 'dist', 'ideInstall', 'wizardPreload.js'), 'utf-8');
check('extracted preload.js 含汉化引擎注入标记', preloadStr.includes('// Antigravity 2.0 Chinese Localization Engine'), true);
check('extracted wizardPreload.js 含汉化引擎注入标记', wizardStr.includes('// Antigravity 2.0 Chinese Localization Engine'), true);
check('extracted preload.js 实装 2.36 新词条（搜索设置）', preloadStr.includes('"Search settings": "搜索设置"'), true);
check('extracted preload.js 实装 2.36 新词条（网络机密）', preloadStr.includes('"Network secrets": "网络机密"'), true);

console.log(`\n========== 测试完成: ${passed}/${total} 全部通过 ==========`);
if (passed !== total) process.exit(1);
