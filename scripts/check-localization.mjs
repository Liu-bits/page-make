import fs from 'node:fs';

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
