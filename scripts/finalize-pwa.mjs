import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const templatePath = resolve(projectRoot, 'public/sw.js');
const BUILD_MARKER = /\/\* PALM_BUILD_START \*\/[\s\S]*?\/\* PALM_BUILD_END \*\//;
const REQUIRED_FILES = [
  'index.html', 'manifest.webmanifest', 'icons/pet.png',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

async function walkFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(path));
    else if (entry.isFile() && !entry.name.endsWith('.map')) files.push(path);
    else if (entry.isSymbolicLink()) throw new Error(`PWA 静态目录不接受符号链接：${entry.name}`);
  }
  return files;
}

export async function finalizePwa(distPath = resolve(projectRoot, 'dist')) {
  const directory = resolve(distPath);
  const template = await readFile(templatePath, 'utf8');
  if (!BUILD_MARKER.test(template)) throw new Error('Service Worker 缺少构建标记。');
  const paths = [
    ...REQUIRED_FILES.map((name) => resolve(directory, name)),
    ...await walkFiles(resolve(directory, 'assets')),
  ];
  const entries = [];
  const versionHash = createHash('sha256').update(template);
  for (const path of [...new Set(paths)].sort()) {
    const localPath = relative(directory, path).split(sep).join('/');
    if (localPath.startsWith('../') || !/^[A-Za-z0-9_./-]+$/.test(localPath)) {
      throw new Error('PWA 构建产物路径无法安全缓存。');
    }
    const data = await readFile(path);
    const route = `/${localPath}`;
    const integrity = `sha256-${createHash('sha256').update(data).digest('base64')}`;
    entries.push({ path: route, integrity });
    versionHash.update(route).update('\0').update(data).update('\0');
  }
  const version = versionHash.digest('hex').slice(0, 20);
  const worker = template.replace(BUILD_MARKER,
    `/* PALM_BUILD_START */ ${JSON.stringify({ version, files: entries })} /* PALM_BUILD_END */`);
  await writeFile(resolve(directory, 'sw.js'), worker);
  return { version, files: entries.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await finalizePwa();
    console.log(`PWA 离线版本 ${result.version}：已预缓存声明 ${result.files} 个静态文件。`);
  } catch (error) {
    console.error(`PWA 构建失败：${error.message}`);
    process.exitCode = 1;
  }
}
