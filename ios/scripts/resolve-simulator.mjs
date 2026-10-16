#!/usr/bin/env node
// =============================================================================
// 解析 CI 可用的 iOS 模拟器，输出 SIM_DEST=... 供 GitHub Actions 使用
// 优先级：优先 iOS 27.0.1 → iOS 27.x → 已安装的最新 iOS 运行时
// 设备：优先 iPhone 17 Pro → iPhone 17 → 任意 iPhone；没有则创建一台
// 用法：node ios/scripts/resolve-simulator.mjs [27.0.1]
// 输出：stdout 打印一行 SIM_DEST=platform=iOS Simulator,id=<udid>
//       stderr 打印人类可读信息
// =============================================================================
import { execFileSync } from 'node:child_process';

const PREFERRED_OS = process.argv[2] || process.env.SIM_OS_VERSION || '27.0.1';

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function json(cmd, args) {
  return JSON.parse(run(cmd, args));
}

try {
  const runtimes = json('xcrun', ['simctl', 'list', 'runtimes', '-j']).runtimes
    .filter(r => r.platform === 'iOS' && r.isAvailable)
    .sort((a, b) => parseFloat(b.version) - parseFloat(a.version));

  const pickRuntime =
    runtimes.find(r => r.version === PREFERRED_OS) ||
    runtimes.find(r => r.version.startsWith(PREFERRED_OS.split('.').slice(0, 2).join('.'))) ||
    runtimes[0];

  if (!pickRuntime) {
    console.error('未找到可用的 iOS 模拟器运行时');
    process.exit(1);
  }

  const devices = json('xcrun', ['simctl', 'list', 'devices', 'available', '-j']).devices;
  let pool = devices[pickRuntime.identifier] || [];
  let device =
    pool.find(d => d.name.includes('iPhone 17 Pro')) ||
    pool.find(d => d.name.includes('iPhone 17')) ||
    pool.find(d => d.name.includes('iPhone'));

  if (!device) {
    // 运行时下没有可用设备：选最新机型创建一台
    const types = json('xcrun', ['simctl', 'list', 'devicetypes', '-j']).devicetypes
      .filter(t => t.name.includes('iPhone'))
      .map(t => t.name.replace('iPhone ', ''))
      .map(v => parseInt(v, 10))
      .filter(v => !Number.isNaN(v));
    const best = types.length ? Math.max(...types) : 16;
    const typeId = `com.apple.CoreSimulator.SimDeviceType.iPhone-${best}`;
    const udid = run('xcrun', ['simctl', 'create', `iPhone ${best}`, typeId, pickRuntime.identifier]).trim();
    device = { udid, name: `iPhone ${best}` };
  }

  console.error(`使用模拟器：${device.name}（runtime ${pickRuntime.version}）`);
  process.stdout.write(`SIM_DEST=platform=iOS Simulator,id=${device.udid}\n`);
} catch (error) {
  console.error(`解析模拟器失败：${error.message}`);
  process.exit(1);
}
