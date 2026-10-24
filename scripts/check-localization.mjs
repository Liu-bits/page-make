import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const paths = [
  'ios/PageMake/Resources/zh-Hans.lproj/Localizable.strings',
  'ios/PageMake/Resources/en.lproj/Localizable.strings',
];
const sets = [];
for (const file of paths) {
  const text = fs.readFileSync(file, 'utf8');
  const keys = [...text.matchAll(/^"([^"]+)"\s*=/gm)].map((m) => m[1]);
  const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index);
  console.log(`${file}: ${keys.length} keys, ${duplicates.length} duplicates`);
  if (duplicates.length) throw new Error(`${file} 重复 key: ${[...new Set(duplicates)].join(', ')}`);
  sets.push(new Set(keys));
}
const missingEn = [...sets[0]].filter((key) => !sets[1].has(key));
const missingZh = [...sets[1]].filter((key) => !sets[0].has(key));
if (missingEn.length || missingZh.length) {
  throw new Error(`语言 key 不一致：en 缺 ${missingEn.join(', ')}；zh 缺 ${missingZh.join(', ')}`);
}
console.log('Localization key sets match.');

// 仅比较中英 key 集合不够：Swift 引用了不存在的 key 时，App 会直接显示空字符
// （曾导致项目模式“构建”按钮文案消失）。这里静态扫描所有用户可见文案入口。
const swiftFiles = walk(path.join(root, 'ios', 'PageMake')).filter((file) => file.endsWith('.swift'));
const referenced = new Set();
const callPatterns = [
  /\bL10n\.(?:string|format)\(\s*"([^"\\]+)"/g,
  /\bNSLocalizedString\(\s*"([^"\\]+)"/g,
];
for (const file of swiftFiles) {
  const text = fs.readFileSync(file, 'utf8');
  for (const pattern of callPatterns) {
    for (const match of text.matchAll(pattern)) referenced.add(match[1]);
  }
}

const available = sets[0];
const missingReferences = [...referenced].filter((key) => !available.has(key)).sort();
if (missingReferences.length) {
  throw new Error(`Swift 引用了不存在的本地化 key：${missingReferences.join(', ')}`);
}
console.log(`Swift localization references: ${referenced.size}, all present.`);

// App 审核文案不应暴露开源仓库、第三方部署平台或基础设施细节。
// 只检查随 App 分发的字符串与文档；Swift 注释里的工程说明不参与审核展示。
const userVisibleFiles = walk(path.join(root, 'ios', 'PageMake', 'Resources'))
  .filter((file) => /\.(txt|strings)$/.test(file));
const forbidden = [
  /ModelScope/i,
  /GitHub/i,
  /self-hosted/i,
  /自托管/,
  /开源/,
  /open\s+source/i,
];
const violations = [];
for (const file of userVisibleFiles) {
  const text = fs.readFileSync(file, 'utf8');
  for (const rule of forbidden) {
    if (rule.test(text)) violations.push(`${path.relative(root, file)} (${rule})`);
  }
}
if (violations.length) {
  throw new Error(`App 可见文案包含审核无关的内部信息：\n${violations.join('\n')}`);
}
console.log('App-visible copy contains no internal platform/repository references.');
