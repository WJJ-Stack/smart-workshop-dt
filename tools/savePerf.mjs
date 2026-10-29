#!/usr/bin/env node
/**
 * 把页面内基准结果落盘。
 *
 * 流程：
 *   1. 启动 dev server（若未启动）
 *   2. 通过浏览器执行 window.__bench()
 *   3. 把 JSON 写入 perf.json
 *
 * 这里不直接连 CDP（浏览器的调试端口不对外），而是让操作者
 * 在页面的 devtools console 里跑 `copy(await window.__bench())`，
 * 或者用 `npm run perf:watch` + 手动粘贴。
 *
 * 为了自动化，提供 --stdin 模式：从标准输入读 JSON。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const useStdin = args.includes('--stdin');
const out = (() => {
  const i = args.indexOf('--out');
  return i >= 0 && args[i + 1] ? args[i + 1] : 'perf.json';
})();

if (!useStdin) {
  console.log(`用法：
  # 方式一（推荐，手动）：在页面 console 执行
  copy(await window.__bench())
  # 然后粘贴到文件：
  npm run perf:save -- --stdin < bench.json

  # 方式二：直接指定已有文件
  node tools/savePerf.mjs --from bench.json
`);
  const fromIdx = args.indexOf('--from');
  if (fromIdx >= 0 && args[fromIdx + 1]) {
    const src = readFileSync(args[fromIdx + 1], 'utf8');
    const parsed = JSON.parse(src);
    writeFileSync(out, JSON.stringify(enrich(parsed), null, 2), 'utf8');
    console.log(`[perf] 已写入 ${out}`);
  }
  process.exit(0);
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  // console 里 copy() 出来的字符串可能带引号或转义
  let text = input.trim();
  if (text.startsWith('"') && text.endsWith('"')) {
    text = JSON.parse(text);
  }
  const parsed = JSON.parse(text);
  writeFileSync(out, JSON.stringify(enrich(parsed), null, 2), 'utf8');
  console.log(`[perf] 已写入 ${out}`);
});

function enrich(r) {
  return {
    generatedAt: new Date().toISOString(),
    node: process.version,
    ...r,
  };
}
