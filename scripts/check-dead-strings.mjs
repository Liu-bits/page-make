// 找出 Localizable.strings 里没有任何 Swift 引用的死键。
// 死文案会随 IPA 一起提交，既可能暴露已下线功能的描述，也让提审材料与
// 实际能力不符（用户要求如实披露）。清理死键属于提审整改的一部分。
//
// 注意：有些键是通过字符串插值动态生成的（如 ProjectStatus.titleKey 的
// "status_\(rawValue)"），字面量匹配查不到，会误报成死键。这类键单独列出来
// 交人工确认，不直接算死键。
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const stringsFiles = [
  'ios/PageMake/Resources/zh-Hans.lproj/Localizable.strings',
  'ios/PageMake/Resources/en.lproj/Localizable.strings',
];

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

// 覆盖 App 与测试两个 target：测试里引用的键同样是活的
let swift = '';
for (const dir of ['ios/PageMake', 'ios/PageMakeTests']) {
  const full = path.join(root, dir);
  if (!fs.existsSync(full)) continue;
  for (const file of walk(full)) {
    if (file.endsWith('.swift')) swift += fs.readFileSync(file, 'utf8') + '\n';
  }
}

// 前缀动态拼接的键：源码里形如 "<prefix>\(rawValue)" / "<prefix>\(...)"
const DYNAMIC_PREFIXES = ['status_', 'account_', 'template_', 'project_kind_', 'ban_level_'];
const isDynamic = (key) => DYNAMIC_PREFIXES.some(
  (prefix) => key.startsWith(prefix)
    && swift.includes(`"${prefix}`)
);

const dead = [];
const dynamic = [];
const seen = new Set();
for (const file of stringsFiles) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  for (const m of text.matchAll(/^"([^"]+)"\s*=/gm)) {
    const key = m[1];
    if (seen.has(key)) continue;
    seen.add(key);
    if (swift.includes(`"${key}"`)) continue;
    if (isDynamic(key)) {
      dynamic.push(key);
      continue;
    }
    dead.push(key);
  }
}

if (dynamic.length) {
  console.log(`动态引用（前缀拼接，需人工确认，未计入死键）：${dynamic.join(', ')}`);
}
if (dead.length === 0) {
  console.log('没有死键');
} else {
  console.log(`发现 ${dead.length} 个无引用的键：`);
  for (const key of dead) console.log('  ' + key);
}
