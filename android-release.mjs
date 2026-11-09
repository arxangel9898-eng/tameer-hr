import {readFileSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

export const ANDROID_APK_PATH='/downloads/TAMEER-HR-manager.apk';
const unavailable=()=>{throw Object.assign(Error('Обновление приложения временно недоступно. Повторите позже.'),{status:503})};
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// The publisher stages these two files together; clients independently verify the APK signature.
export function readAndroidRelease(directory,{origin,signer}={}){
 try{
  if(!origin||new URL(origin).protocol!=='https:'||new URL(origin).origin!==origin||!/^[0-9a-f]{64}$/.test(signer||''))unavailable();
  const jsonPath=join(directory,'android-update.json'),apkPath=join(directory,'TAMEER-HR-manager.apk');
  if(statSync(jsonPath).size>32768)unavailable();
  const m=JSON.parse(readFileSync(jsonPath,'utf8'));
  if(m?.schema!==1||m.package!=='uz.tameer.hr'||!Number.isSafeInteger(m.versionCode)||m.versionCode<3||m.versionCode>2147483647||typeof m.versionName!=='string'||!/^\d+\.\d+\.\d+(?:[.-][A-Za-z0-9]+)?$/.test(m.versionName)||m.versionName.length>40||!Number.isSafeInteger(m.minSdk)||m.minSdk<26||m.minSdk>100||m.apkUrl!==origin+ANDROID_APK_PATH||!/^[0-9a-f]{64}$/.test(m.sha256)||m.signerSha256!==signer||!Number.isSafeInteger(m.size)||m.size<=0||m.size>20*1024*1024)unavailable();
  if(!m.releaseNotes||['ru','uz'].some(k=>typeof m.releaseNotes[k]!=='string'||!m.releaseNotes[k].trim()||m.releaseNotes[k].length>1000))unavailable();
  const size=statSync(apkPath).size;if(size!==m.size)unavailable();const apk=readFileSync(apkPath);if(apk.length!==m.size||createHash('sha256').update(apk).digest('hex')!==m.sha256)unavailable();
  const manifest={schema:1,package:m.package,versionCode:m.versionCode,versionName:m.versionName,minSdk:m.minSdk,apkUrl:m.apkUrl,sha256:m.sha256,size:m.size,signerSha256:m.signerSha256,releaseNotes:{ru:m.releaseNotes.ru,uz:m.releaseNotes.uz}};
  return {manifest,apk,sha256:m.sha256+'  TAMEER-HR-manager.apk\n'};
 }catch{unavailable();}
}

export function androidUpdatesPage(release){
 const m=release.manifest;
 return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TAMEER HR — обновления</title><link rel="stylesheet" href="/manager.css"></head><body><main class="content shell"><a href="/manager">← TAMEER HR</a><h1>Обновления приложения / Ilova yangilanishlari</h1><section class="card"><h2>TAMEER HR ${escape(m.versionName)}</h2><p>${escape(m.releaseNotes.ru)}</p><p>Установите эту версию поверх прежней. После этого APK будет автоматически проверять обновления при открытии и загружать новые версии. Установку подтверждает пользователь в системном окне Android.</p><p>Настройки: профиль → «Обновления приложения». Проверку и загрузку можно отключить. Интерфейс с сайта обновляется без переустановки APK; открытая форма при проверке версии сохраняется.</p><a class="button" href="${ANDROID_APK_PATH}">Скачать APK ${escape(m.versionName)}</a></section><section class="card" lang="uz"><h2>Ilovani yangilash</h2><p>${escape(m.releaseNotes.uz)}</p><p>Yangi APK faylni eski ilova ustiga o‘rnating. Keyingi versiyalar ilova ochilganda avtomatik tekshiriladi va yuklanadi. O‘rnatish Android tizim oynasida tasdiqlanadi.</p><p>Sozlamalar: profil → «Ilova yangilanishlari». Avtomatik tekshirish va yuklashni o‘chirishingiz mumkin. Sayt interfeysidagi o‘zgarishlar APK faylni qayta o‘rnatmasdan keladi.</p><a class="button" href="${ANDROID_APK_PATH}">APK ${escape(m.versionName)} yuklab olish</a></section><p class="muted">Android 8.0+ · ${(m.size/1024).toFixed(0)} KB</p></main></body></html>`;
}
