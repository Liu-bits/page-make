// 扫描 Swift 源码中同一作用域内的属性包装器同名重复声明。
//
// 为什么需要：本地只有 swiftc -parse（Windows 工具链无 iOS SDK，-typecheck 会报
// no such module 'SwiftUI'）。-parse 不建符号表，`invalid redeclaration` 这类语义
// 错误本地全绿、CI 才炸（iOS job exit 65，ipa 与 deploy 连带失败/跳过）。
// 2026-10-25 实测踩到：给 SettingsView 加刷新按钮时重复声明 showVIPApplication。
//
// 跨 struct/class/enum 同名属性是合法 Swift，所以必须按作用域分组，不能全局去重。
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
// 必须同时覆盖 PageMakeTests：CI 的 iOS job 编译 App + 测试两个 target，
// 只扫 App 会漏掉测试里的编译错误（2026-10-25 实测：删 HostProvider.cloudflare
// 后 App 与 IPA job 都通过，只有测试 target 炸，白跑一轮 macOS runner）。
const srcRoots = [
  path.join(root, 'ios', 'PageMake'),
  path.join(root, 'ios', 'PageMakeTests'),
].filter((dir) => fs.existsSync(dir));

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const WRAPPERS = [
  'State', 'Published', 'AppStorage', 'EnvironmentObject', 'ObservedObject',
  'StateObject', 'Environment', 'FocusState', 'Namespace', 'SceneStorage',
];
const declRe = new RegExp(
  `^\\s*@(?:${WRAPPERS.join('|')})\\s+(?:private\\s+)?var\\s+(\\w+)`
);
const scopeRe = /^(?:private\s+|fileprivate\s+|public\s+|internal\s+)*(?:final\s+)?(?:struct|class|enum|actor|extension)\s+(\w+)/;

let problems = 0;
let files = 0;

for (const srcRoot of srcRoots) {
  for (const file of walk(srcRoot)) {
  if (!file.endsWith('.swift')) continue;
  files += 1;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  let scope = '<file>';
  const seen = new Map();
  lines.forEach((line, index) => {
    const scopeMatch = line.match(scopeRe);
    if (scopeMatch) {
      scope = scopeMatch[1];
      seen.clear();
      return;
    }
    const decl = line.match(declRe);
    if (!decl) return;
    const name = decl[1];
    const first = seen.get(name);
    if (first) {
      problems += 1;
      console.error(
        `${path.relative(root, file)}:${index + 1}: 重复声明 '${name}'（首次出现在第 ${first} 行，作用域 ${scope}）`
      );
    } else {
      seen.set(name, index + 1);
    }
  });
  }
}

console.log(`扫描 ${files} 个 Swift 文件`);
if (problems > 0) {
  console.error(`发现 ${problems} 处同作用域重复声明`);
  process.exit(1);
}
console.log('未发现同作用域重复的属性包装器声明');
