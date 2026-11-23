import { spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const children = [];
let stopping = false;

function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
  }
  process.exitCode = exitCode;
  const hardStop = setTimeout(() => {
    for (const child of children) {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }, 3000);
  hardStop.unref();
}

function run(label, args) {
  const child = spawn(process.execPath, args, {
    cwd: root, stdio: 'inherit',
    env: { ...process.env, HOST: '127.0.0.1', PORT: '8787', NODE_ENV: 'development' },
  });
  children.push(child);
  child.on('error', (error) => {
    console.error(`[${label}] 无法启动：${error.message}`);
    stop(1);
  });
  child.on('exit', (code, signal) => {
    if (!stopping) {
      console.error(`[${label}] 已退出${signal ? `（${signal}）` : `，状态 ${code}`}`);
      stop(code || 1);
    }
  });
  return child;
}

async function waitFor(url, label) {
  const deadline = Date.now() + 20000;
  while (!stopping && Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1200) });
      if (response.ok) return;
    } catch { /* process is still starting */ }
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(`${label} 启动检查未通过：${url}`);
}

process.once('SIGINT', () => stop());
process.once('SIGTERM', () => stop());
process.once('exit', () => {
  for (const child of children) if (child.exitCode === null && !child.killed) child.kill();
});

run('API', ['--env-file-if-exists=.env', 'server/index.mjs']);
run('Web', [resolve(root, 'node_modules/vite/bin/vite.js'), '--host', '0.0.0.0']);

try {
  await Promise.all([
    waitFor('http://127.0.0.1:8787/api/config', 'API'),
    waitFor('http://127.0.0.1:5173/', 'Web'),
  ]);
  if (!stopping) {
    console.log('\nPalmChat已启动： http://localhost:5173');
    const addresses = [...new Set(Object.values(networkInterfaces()).flat()
      .filter((item) => item && !item.internal && item.family === 'IPv4')
      .map((item) => item.address))];
    for (const address of addresses) console.log(`同一局域网手机： http://${address}:5173`);
    console.log('局域网 HTTP 可聊天；添加到主屏与离线壳需 HTTPS（或本机 localhost）。\n');
  }
} catch (error) {
  if (!stopping) console.error(error.message);
  stop(1);
}
