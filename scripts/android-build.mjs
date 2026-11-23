import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const help = `PalmChat Android 构建

  node scripts/android-build.mjs                         # 通用调试包，首次启动填写服务端
  node scripts/android-build.mjs --api-url https://你的服务端域名
  node scripts/android-build.mjs --release --api-url https://你的服务端域名 --version-code 15 --version-name 0.4.0
  添加 --unsigned 可生成待签名 APK，添加 --evaluation 可用本地测试证书签署 release 验收包。
  node scripts/android-build.mjs --api-url http://电脑局域网IP:8787 --allow-http
  node scripts/android-build.mjs --api-url http://电脑局域网IP:8787 --allow-http --skip-web-build

首次需已有 Android SDK 36 / build-tools 36.0.0 与 Java 21。
默认使用本项目 .android-sdk 和 .gradle-user-home，不修改系统环境。
构建本地 assets；禁止 Capacitor server.url。HTTP 仅用于明确标记的 debug 包。
--skip-web-build 只供已经使用相同 API 参数构建好 dist 的联调流程。
正式签名从进程环境读取 PALM_KEYSTORE、PALM_KEY_ALIAS、PALM_STORE_PASSWORD、PALM_KEY_PASSWORD。
所有包和校验信息位于 artifacts/。`;

if (args.includes('--help') || args.includes('-h')) {
  console.log(help);
  process.exit(0);
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

function run(executable, argumentsList, options = {}) {
  return new Promise((done, reject) => {
    const child = spawn(executable, argumentsList, { cwd: root, stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? done() : reject(new Error(`构建命令退出状态 ${code}。`)));
  });
}

function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(name + ' 缺少参数。');
  return value;
}

function inspect(executable, argumentsList) {
  const result = spawnSync(executable, argumentsList, {encoding: 'utf8'});
  if (result.status !== 0) throw new Error(result.stderr || '无法读取 APK 信息。');
  return result.stdout;
}

function findJavaHome() {
  if (process.env.JAVA_HOME) return process.env.JAVA_HOME;
  const found = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['java'], { encoding: 'utf8' });
  const executable = found.stdout?.split(/\r?\n/).find(Boolean);
  if (!executable) throw new Error('未找到 Java。请为本次进程设置 JAVA_HOME 指向 Java 21。');
  return resolve(dirname(executable), '..');
}

try {
  const production = args.includes('--release');
  const unsigned = args.includes('--unsigned');
  const evaluation = args.includes('--evaluation');
  if ((unsigned || evaluation) && !production || unsigned && evaluation) throw new Error('请在 --release 下选择一种签名方式。');
  const urlPosition = args.indexOf('--api-url');
  const rawUrl = urlPosition >= 0 ? args[urlPosition + 1] : process.env.VITE_API_BASE_URL;
  if (production && !rawUrl) throw new Error(`正式构建必须指定 HTTPS 服务端地址。\n${help}`);
  const apiUrl = rawUrl ? new URL(rawUrl) : null;
  const apiBase64 = apiUrl ? Buffer.from(apiUrl.href.replace(/\/$/, '')).toString('base64') : '';
  const versioned = args.includes('--version-code');
  const versionCode = Number(option('--version-code', '1'));
  const versionName = option('--version-name', '0.1.0');
  if (production && (!apiUrl || apiUrl.protocol !== 'https:' || !versioned || !args.includes('--version-name') ||
      ['--allow-http', '--skip-web-build'].some(flag => args.includes(flag))))
    throw new Error('release 构建需要 HTTPS、显式版本号和版本名称，并重新编译前端。');
  let releaseKey;
  if (production && !unsigned && !evaluation) {
    if (!['PALM_KEYSTORE', 'PALM_KEY_ALIAS', 'PALM_STORE_PASSWORD', 'PALM_KEY_PASSWORD'].every(key => process.env[key]))
      throw new Error('正式签名需要 PALM_KEYSTORE、PALM_KEY_ALIAS、PALM_STORE_PASSWORD、PALM_KEY_PASSWORD。待签名构建请使用 --unsigned。');
    releaseKey = resolve(process.env.PALM_KEYSTORE);
    if (!(await exists(releaseKey))) throw new Error('指定的发布密钥库不存在。');
  }
  if (!Number.isSafeInteger(versionCode) || versionCode < 1 || versionCode > 2100000000 ||
      !/^[0-9][A-Za-z0-9.-]{0,47}$/.test(versionName)) throw new Error('安卓版本号或版本名称无效。');
  if (apiUrl && (!['https:', 'http:'].includes(apiUrl.protocol) || apiUrl.username || apiUrl.password || apiUrl.search || apiUrl.hash || !['', '/', '/api', '/api/'].includes(apiUrl.pathname))) {
    throw new Error('API 地址只能是没有凭据或查询参数的 HTTP(S) 站点地址，可选 /api 路径。');
  }
  if (apiUrl && ['localhost', '127.0.0.1', '[::1]'].includes(apiUrl.hostname)) {
    throw new Error('手机上的 localhost 指向手机本身，请使用电脑局域网 IP 或可访问的 HTTPS 域名。');
  }
  if (apiUrl?.protocol === 'http:' && !args.includes('--allow-http')) {
    throw new Error('HTTP 仅供局域网调试；确认是调试地址后显式添加 --allow-http。');
  }
  const config = JSON.parse(await readFile(resolve(root, 'capacitor.config.json'), 'utf8'));
  if (config.server?.url) throw new Error('请移除 Capacitor server.url；安装包必须携带本地界面。');
  if (config.android?.allowMixedContent !== false) throw new Error('基础 Capacitor 配置必须保持 allowMixedContent=false，HTTP 仅由 debug 原生代码放行。');
  const sdk = resolve(process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || resolve(root, '.android-sdk'));
  const javaHome = findJavaHome();
  const java = join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  const keytool = join(javaHome, 'bin', process.platform === 'win32' ? 'keytool.exe' : 'keytool');
  const apksigner = join(sdk, 'build-tools', '36.0.0', 'lib', 'apksigner.jar');
  for (const file of [java, apksigner, join(sdk, 'platforms', 'android-36', 'android.jar')]) {
    if (!(await exists(file))) throw new Error(`缺少构建工具：${file}`);
  }
  const env = {
    ...process.env, JAVA_HOME: javaHome, ANDROID_HOME: sdk,
    GRADLE_USER_HOME: process.env.GRADLE_USER_HOME || resolve(root, '.gradle-user-home'),
    VITE_API_BASE_URL: '',
    VITE_API_BASE64: apiBase64,
    PALM_VERSION_CODE: String(versionCode), PALM_VERSION_NAME: versionName,
    VITE_NATIVE_DEBUG: !apiUrl || apiUrl.protocol === 'http:' ? 'true' : 'false',
    VITE_DEBUG_BUILD: production ? 'false' : 'true',
  };
  if (!args.includes('--skip-web-build')) {
    await run(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), 'build'], { env });
    await run(process.execPath, [resolve(root, 'scripts/finalize-pwa.mjs')], { env });
  }
  const html = await readFile(resolve(root, 'dist/index.html'), 'utf8');
  const bundles = [...html.matchAll(/src="\/?(assets\/[^"?]+\.js)"/g)].map((match) => match[1]);
  const bundleSource = (await Promise.all(bundles.map((path) => readFile(resolve(root, 'dist', path), 'utf8')))).join('\n');
  if (apiBase64 && !bundleSource.includes(apiBase64)) throw new Error('dist 未包含指定 API 来源；不能将旧构建误打成该地址的安装包。请去掉 --skip-web-build 重建。');

  await mkdir(resolve(root, '.android-sdk'), { recursive: true });
  const debugKey = resolve(root, '.android-sdk/debug.keystore');
  if ((!production || evaluation) && !(await exists(debugKey))) await run(keytool, ['-genkeypair', '-keystore', debugKey,
    '-storepass', 'android', '-keypass', 'android', '-alias', 'androiddebugkey',
    '-dname', 'CN=Android Debug,O=Android,C=US', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000', '-noprompt'], { env });
  await writeFile(resolve(root, 'android/local.properties'), `sdk.dir=${sdk.replaceAll('\\', '/')}\n`);
  await run(process.execPath, [resolve(root, 'node_modules/@capacitor/cli/bin/capacitor'), 'sync', 'android'], { env });
  const gradleTask = production ? 'assembleRelease' : 'assembleDebug';
  if (process.platform === 'win32') {
    // NoDefaultCurrentDirectoryInExePath may be set on hardened Windows hosts, so
    // name the wrapper with an explicit relative path instead of relying on PATH.
    await run(process.env.ComSpec || 'cmd.exe', ['/d', '/c', '.\\gradlew.bat ' + gradleTask + ' --no-daemon --console=plain'], { cwd: resolve(root, 'android'), env });
  } else {
    await run(resolve(root, 'android/gradlew'), [gradleTask, '--no-daemon', '--console=plain'], { cwd: resolve(root, 'android'), env });
  }
  const unsignedApk = resolve(root, 'android/app/build/outputs/apk/release/app-release-unsigned.apk');
  let builtApk = production ? unsignedApk : resolve(root, 'android/app/build/outputs/apk/debug/app-debug.apk');
  if (production && !unsigned) {
    builtApk = resolve(dirname(unsignedApk), 'app-locally-signed.apk');
    await run(java, ['-jar', apksigner, 'sign', '--ks', evaluation ? debugKey : releaseKey,
      '--ks-key-alias', evaluation ? 'androiddebugkey' : process.env.PALM_KEY_ALIAS,
      '--ks-pass', evaluation ? 'pass:android' : 'env:PALM_STORE_PASSWORD',
      '--key-pass', evaluation ? 'pass:android' : 'env:PALM_KEY_PASSWORD',
      '--out', builtApk, unsignedApk], {env});
  }
  const signing = unsigned ? '' : inspect(java, ['-jar', apksigner, 'verify', '--verbose', '--print-certs', builtApk]);
  const signerSha256 = /Signer #1 certificate SHA-256 digest: ([a-f0-9]{64})/i.exec(signing)?.[1] ?? null;
  if (production && !evaluation && /certificate DN:.*CN=Android Debug/i.test(signing))
    throw new Error('Android 调试证书只能用于显式 --evaluation 验收包。');
  const aapt = join(sdk, 'build-tools', '36.0.0', process.platform === 'win32' ? 'aapt.exe' : 'aapt');
  const metadata = inspect(aapt, ['dump', 'badging', builtApk]);
  const installedName = production ? versionName : versionName + '-debug';
  if ((!unsigned && !signerSha256) || (production && metadata.includes('application-debuggable')) ||
      !metadata.includes(`package: name='${config.appId}' versionCode='${versionCode}' versionName='${installedName}'`))
    throw new Error('APK 的签名或实际版本与预期不一致。');
  if (production) {
    const manifest = inspect(aapt, ['dump', 'xmltree', builtApk, 'AndroidManifest.xml']);
    if (!/android:usesCleartextTraffic[^\n]*\(type 0x12\)0x0\s/.test(manifest))
      throw new Error('release APK 的网络策略校验失败。');
  }
  const zip = unzipSync(await readFile(builtApk));
  const packagedConfig = JSON.parse(strFromU8(zip['assets/capacitor.config.json']));
  if (packagedConfig.server?.url) throw new Error('APK 中发现远程页面地址，打包验证未通过。');
  if (!zip['assets/public/index.html']) throw new Error('APK 未包含本地界面。');
  const apiPresent = apiBase64 && Object.entries(zip).some(([name, bytes]) => name.startsWith('assets/public/assets/') && name.endsWith('.js') && strFromU8(bytes).includes(apiBase64));
  if (apiBase64 && !apiPresent) throw new Error('APK 内未找到指定的 API 来源。');
  const localStorePresent = Object.entries(zip).some(([name, bytes]) => /^classes\d*\.dex$/.test(name) && Buffer.from(bytes).includes(Buffer.from('LocalChatStorePlugin')));
  if (!localStorePresent) throw new Error('APK 未包含本地加密聊天插件。');
  await mkdir(resolve(root, 'artifacts'), { recursive: true });
  const variant = evaluation ? 'evaluation' : unsigned ? 'release-unsigned' : 'release';
  const stem = production ? `palmchat-${versionCode}-${variant}` : versioned ? `palmchat-${versionCode}` : 'palmchat-debug';
  const artifact = resolve(root, 'artifacts', stem + '.apk');
  await copyFile(builtApk, artifact);
  const apkBytes = await readFile(artifact);
  const sha256 = createHash('sha256').update(apkBytes).digest('hex');
  await writeFile(`${artifact}.sha256`, `${sha256}  ${stem}.apk\n`);
  const release = { applicationId: config.appId, versionCode, versionName: installedName, signerSha256, sha256, apiOrigin: apiUrl?.origin || '' };
  const infoName = versioned ? stem + '-build-info.json' : 'android-build-info.json';
  await writeFile(resolve(root, 'artifacts', infoName), `${JSON.stringify({
    ...release, version: installedName, debug: !production, signing: production ? variant : 'debug',
    sizeBytes: apkBytes.length, sha256, localAssets: true, remotePage: false,
    chatStorage: 'Per-account AndroidKeystore AES-GCM; private atomic files',
    signatureVerified: Boolean(signerSha256), deviceTested: false, builtAt: new Date().toISOString(),
  }, null, 2)}\n`);
  console.log(`\n已生成 ${production ? variant : 'debug'} APK：${artifact}`);
  console.log(`SHA-256：${sha256}`);
  console.log(apiUrl ? `服务端来源：${apiUrl.origin}` : '服务端来源：未预置（首次启动在应用内填写）');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
