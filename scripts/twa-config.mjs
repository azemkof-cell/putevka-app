// Writes android/twa-manifest.json for Bubblewrap: the Android app (TWA) that opens the PWA without a browser bar.
// Usage: DOMAIN=putevka.example.ru node scripts/twa-config.mjs   (see README «Приложение для RuStore»)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_PACKAGE = 'ru.putevka.app';

export function twaManifest({ domain, packageId = DEFAULT_PACKAGE, versionName = '1.0.0', versionCode = 1 }) {
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain || '')) throw new Error('Укажите домен сайта: DOMAIN=putevka.example.ru');
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(packageId)) throw new Error(`Неверное имя пакета: ${packageId}`);
  const web = JSON.parse(fs.readFileSync(path.join(root, 'public', 'manifest.webmanifest'), 'utf8'));
  const url = (p) => `https://${domain}${p}`;
  const icon = (purpose) => web.icons.find((i) => (i.purpose || 'any') === purpose && i.sizes === '512x512')?.src;
  return {
    packageId,
    host: domain,
    name: web.name,
    launcherName: web.short_name,
    display: web.display,
    orientation: web.orientation,
    themeColor: web.theme_color,
    navigationColor: web.theme_color,
    navigationColorDark: web.theme_color,
    navigationDividerColor: web.theme_color,
    navigationDividerColorDark: web.theme_color,
    backgroundColor: web.background_color,
    // Web Push of the site is shown as the app's own notifications
    enableNotifications: true,
    startUrl: web.start_url,
    iconUrl: url(icon('any')),
    maskableIconUrl: url(icon('maskable')),
    monochromeIconUrl: url(icon('monochrome')),
    splashScreenFadeOutDuration: 300,
    signingKey: { path: './android.keystore', alias: 'putevka' },
    appVersionName: String(versionName),
    appVersionCode: Number(versionCode),
    shortcuts: [],
    generatorApp: 'bubblewrap-cli',
    webManifestUrl: url('/manifest.webmanifest'),
    // Many phones from RuStore have no Chrome: open the app in a WebView instead of a browser tab
    fallbackType: 'webview',
    features: {},
    alphaDependencies: { enabled: false },
    enableSiteSettingsShortcut: false,
    isChromeOSOnly: false,
    minSdkVersion: 21
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const m = twaManifest({ domain: process.env.DOMAIN, packageId: process.env.TWA_PACKAGE || DEFAULT_PACKAGE, versionName: process.env.TWA_VERSION || '1.0.0', versionCode: Number(process.env.TWA_VERSION_CODE) || 1 });
    const out = path.join(root, 'android', 'twa-manifest.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(m, null, 2) + '\n');
    console.log(`Записано: ${out}\nПакет ${m.packageId}, сайт https://${m.host}, версия ${m.appVersionName} (${m.appVersionCode}).`);
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
