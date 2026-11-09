#!/usr/bin/env python3
"""Build the dependency-free Android client with official SDK tools; keep signing files private."""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path
import secrets
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parent

def run(args, **kwargs):
    result = subprocess.run([str(a) for a in args], text=True, errors='replace', capture_output=True, **kwargs)
    if result.returncode:
        raise RuntimeError(f"{Path(str(args[0])).name} failed ({result.returncode})\n{result.stdout}\n{result.stderr}")
    if result.stderr.strip():
        print(result.stderr.strip(), flush=True)
    return result.stdout

def server_host(value):
    host = value.lower()
    labels = host.split('.')
    if len(host) > 253 or len(labels) < 2 or any(not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', label) for label in labels):
        raise argparse.ArgumentTypeError('Enter a DNS hostname such as hr.example.com, without a scheme, port or path.')
    return host

def deployment_config(build, host, keytool, keystore, password_file):
    certificate = subprocess.run(
        [str(keytool), '-exportcert', '-alias', 'tameer-hr', '-keystore', str(keystore),
         '-storepass:file', str(password_file)],
        capture_output=True, check=True,
    ).stdout
    if not certificate:
        raise RuntimeError('The signing certificate was not exported.')
    signer = hashlib.sha256(certificate).hexdigest()
    config = build / 'deployment' / 'DeploymentConfig.java'
    config.parent.mkdir(parents=True, exist_ok=True)
    config.write_text(
        'package uz.tameer.hr;\n\n'
        'final class DeploymentConfig {\n'
        f'    static final String HOST = "{host}";\n'
        f'    static final String SIGNER = "{signer}";\n'
        '}\n',
        encoding='utf-8',
    )
    return config, signer

def check_source():
    import xml.etree.ElementTree as ET
    ns = '{http://schemas.android.com/apk/res/android}'
    doc = ET.parse(ROOT / 'AndroidManifest.xml').getroot()
    assert doc.attrib['package'] == 'uz.tameer.hr'
    assert [p.attrib[ns+'name'] for p in doc.findall('uses-permission')] == ['android.permission.INTERNET','android.permission.REQUEST_INSTALL_PACKAGES']
    assert doc.find('uses-sdk').attrib[ns+'minSdkVersion'] == '26'
    assert doc.find('uses-sdk').attrib[ns+'targetSdkVersion'] == '36'
    app = doc.find('application')
    for key in ['debuggable', 'allowBackup', 'usesCleartextTraffic']:
        assert app.attrib[ns+key] == 'false'
    provider=app.find('provider')
    assert provider.attrib[ns+'name']=='.UpdateFileProvider' and provider.attrib[ns+'authorities']=='uz.tameer.hr.updates'
    assert provider.attrib[ns+'exported']=='false' and provider.attrib[ns+'grantUriPermissions']=='true'
    java = (ROOT / 'src/uz/tameer/hr/MainActivity.java').read_text(encoding='utf-8')
    required = ['handler.cancel()', 'MIXED_CONTENT_NEVER_ALLOW', 'setAcceptThirdPartyCookies(web,false)',
        'setAllowFileAccess(false)', 'setAllowContentAccess(false)', 'setWebContentsDebuggingEnabled(false)',
        'setSafeBrowsingEnabled(true)', 'request.deny()', 'request.hasGesture()', 'OriginPolicy.isTrusted(u.toString())',
        'FLAG_SECURE', 'ACTION_OPEN_DOCUMENT', 'LOAD_NO_CACHE', 'workers.setServiceWorkerClient', 'workerSettings.setAllowFileAccess(false)',
        'web.evaluateJavascript(BACK_SCRIPT', '"true".equals(result)', 'backPending || isFinishing() || isDestroyed()',
        'window.tameerHRBack()===true', "document.querySelector('dialog[open]')"]
    assert all(x in java for x in required)
    assert 'addJavascriptInterface' not in java
    assert 'OriginPolicy.HOST' in java and '"/manager"' in java
    assert 'password=' not in java.lower()
    assert java.count('evaluateJavascript(')==1
    updater=(ROOT/'src/uz/tameer/hr/AppUpdater.java').read_text('utf-8')
    assert 'setInstanceFollowRedirects(false)' in updater and 'UpdatePolicy.verifyArchive(' in updater
    assert 'canRequestPackageInstalls()' in updater and 'FLAG_GRANT_READ_URI_PERMISSION' in updater
    assert 'CookieManager' not in updater and 'addJavascriptInterface' not in updater
    assert 'OriginPolicy.isUpdateSettings(u.toString())' in java
    return len(required) + 16

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--host', required=True, type=server_host, help='Trusted HTTPS server hostname on port 443.')
    p.add_argument('--sdk', required=True, type=Path)
    p.add_argument('--jdk', required=True, type=Path)
    p.add_argument('--keystore', required=True, type=Path)
    p.add_argument('--password-file', required=True, type=Path)
    p.add_argument('--out', required=True, type=Path)
    p.add_argument('--work', required=True, type=Path)
    p.add_argument('--node', type=Path, help='Optional Node.js executable for the fixed-script Android Back regression checks.')
    p.add_argument('--create-key', action='store_true', help='Create a new private signing key once; use the same key for every update.')
    args = p.parse_args()
    checks = check_source()
    sdk=args.sdk.resolve(); jdk=args.jdk.resolve(); build=args.work.resolve(); output=args.out.resolve()
    build.mkdir(parents=True, exist_ok=True); output.parent.mkdir(parents=True,exist_ok=True)
    tools=sdk/'build-tools/36.0.0'; platform=sdk/'platforms/android-36/android.jar'
    exe='.exe' if os.name=='nt' else ''
    java=jdk/('bin/java'+exe); javac=jdk/('bin/javac'+exe); keytool=jdk/('bin/keytool'+exe)
    aapt=tools/('aapt2'+exe); align=tools/('zipalign'+exe)
    for f in [java,javac,keytool,aapt,align,platform,tools/'lib/d8.jar',tools/'lib/apksigner.jar']:
        if not f.is_file(): raise RuntimeError(f'Missing tool: {f}')
    if args.create_key:
        if args.keystore.exists() or args.password_file.exists(): raise RuntimeError('Existing signing files must never be replaced.')
        args.keystore.parent.mkdir(parents=True,exist_ok=True); args.password_file.parent.mkdir(parents=True,exist_ok=True)
        args.password_file.write_text(secrets.token_urlsafe(48),encoding='utf-8')
        os.chmod(args.password_file,0o600)
        run([keytool,'-genkeypair','-noprompt','-alias','tameer-hr','-keystore',args.keystore,
             '-storetype','PKCS12','-keyalg','RSA','-keysize','3072','-validity','10000',
             '-storepass:file',args.password_file,'-keypass:file',args.password_file,
             '-dname','CN=TAMEER HR, OU=Application, O=TAMEER, L=Tashkent, C=UZ'])
        os.chmod(args.keystore,0o600)
    if not args.keystore.is_file() or not args.password_file.is_file(): raise RuntimeError('Private signing files are required.')
    config, expected_signer = deployment_config(build, args.host, keytool, args.keystore, args.password_file)
    testclasses=build/'policy-tests'; testclasses.mkdir(parents=True,exist_ok=True)
    run([javac,'-encoding','UTF-8','-d',testclasses,config,ROOT/'src/uz/tameer/hr/OriginPolicy.java',ROOT/'tests/OriginPolicyTest.java'])
    policy_test=run([java,'-cp',testclasses,'uz.tameer.hr.OriginPolicyTest'])
    print(policy_test.strip(),flush=True)
    run([javac,'-encoding','UTF-8','-d',testclasses,config,ROOT/'src/uz/tameer/hr/UpdatePolicy.java',ROOT/'tests/UpdatePolicyTest.java'])
    update_test=run([java,'-cp',testclasses,'uz.tameer.hr.UpdatePolicyTest'])
    print(update_test.strip(),flush=True)
    back_test=run([args.node,ROOT/'tests/web-back.test.mjs']).strip() if args.node else 'Not run: pass --node to execute the fixed-script Back regression checks.'
    print(back_test,flush=True)
    print('Compiling Android resources',flush=True)
    compiled=build/'resources.zip'; generated=build/'generated'; classes=build/'classes'; dex=build/'dex'
    for folder in [generated,classes,dex]: folder.mkdir(parents=True,exist_ok=True)
    run([aapt,'compile','--dir',ROOT/'res','-o',compiled])
    base=build/'resources.apk'
    run([aapt,'link','-o',base,'-I',platform,'--manifest',ROOT/'AndroidManifest.xml','--java',generated,
         '--min-sdk-version','26','--target-sdk-version','36',compiled])
    sources=[config,*sorted((ROOT/'src').rglob('*.java')),*sorted(generated.rglob('*.java'))]
    print('Compiling Java and DEX',flush=True)
    run([javac,'-encoding','UTF-8','-source','8','-target','8','-classpath',platform,'-d',classes,*sources])
    classjar=build/'classes.jar'
    with zipfile.ZipFile(classjar,'w',zipfile.ZIP_DEFLATED) as z:
        for f in classes.rglob('*.class'): z.write(f,f.relative_to(classes).as_posix())
    run([java,'-Xmx256m','-cp',tools/'lib/d8.jar','com.android.tools.r8.D8','--release','--min-api','26','--lib',platform,'--output',dex,classjar])
    unsigned=build/'unsigned.apk'
    with zipfile.ZipFile(base) as original, zipfile.ZipFile(unsigned,'w') as z:
        for info in original.infolist(): z.writestr(info,original.read(info.filename))
        for f in dex.glob('*.dex'): z.write(f,f.name,compress_type=zipfile.ZIP_DEFLATED)
    aligned=build/'aligned.apk'
    run([align,'-f','-p','4',unsigned,aligned])
    print('Signing release APK',flush=True)
    sign=[java,'-Xmx128m','-jar',tools/'lib/apksigner.jar']
    run(sign+['sign','--ks',args.keystore,'--ks-key-alias','tameer-hr','--ks-pass','file:'+str(args.password_file),
        '--min-sdk-version','26','--v1-signing-enabled','false',
        '--v2-signing-enabled','true','--v3-signing-enabled','true','--out',output,aligned])
    verified=run(sign+['verify','--verbose','--print-certs',output])
    run([align,'-c','-p','4',output])
    badging=run([tools/('aapt'+exe),'dump','badging',output])
    permissions=run([tools/('aapt'+exe),'dump','permissions',output])
    xmltree=run([tools/('aapt'+exe),'dump','xmltree',output,'AndroidManifest.xml'])
    assert "package: name='uz.tameer.hr'" in badging
    assert "sdkVersion:'26'" in badging and "targetSdkVersion:'36'" in badging
    assert "launchable-activity: name='uz.tameer.hr.MainActivity'" in badging
    assert permissions.count('uses-permission:')==2 and 'android.permission.INTERNET' in permissions and 'android.permission.REQUEST_INSTALL_PACKAGES' in permissions
    assert 'Verified using v2 scheme (APK Signature Scheme v2): true' in verified
    assert 'Verified using v3 scheme (APK Signature Scheme v3): true' in verified
    signer=re.search(r'Signer #1 certificate SHA-256 digest: ([0-9a-f]{64})',verified).group(1)
    assert signer==expected_signer,'APK signing certificate differs from build configuration'
    for attribute in ['debuggable','allowBackup','usesCleartextTraffic']:
        assert re.search(r'android:'+attribute+r'\([^\n]+\)=\(type 0x12\)0x0(?:\s|$)',xmltree), 'Compiled flag is not false: '+attribute
    digest=hashlib.sha256(output.read_bytes()).hexdigest()
    output.with_suffix('.apk.sha256').write_text(f'{digest}  {output.name}\n',encoding='utf-8')
    import xml.etree.ElementTree as ET
    ns='{http://schemas.android.com/apk/res/android}';manifest=ET.parse(ROOT/'AndroidManifest.xml').getroot();version=manifest.attrib[ns+'versionName'];version_code=int(manifest.attrib[ns+'versionCode'])
    assert f"versionCode='{version_code}'" in badging and f"versionName='{version}'" in badging
    report={'package':'uz.tameer.hr','name':'TAMEER HR','version':version,'versionCode':version_code,'minSdk':26,'targetSdk':36,
        'permission':['android.permission.INTERNET','android.permission.REQUEST_INSTALL_PACKAGES'],'apkBytes':output.stat().st_size,'sha256':digest,
        'signatureVerification':verified,'compiledManifest':badging,'compiledManifestTree':xmltree,'permissionsDump':permissions,'staticChecks':checks,
        'originPolicyTest':policy_test.strip(),'updatePolicyTest':update_test.strip(),'androidBackScriptTest':back_test,'verificationLimits':'No Android phone or emulator was connected; installation, unknown-source permission and native lifecycle were not device-tested.'}
    (build/'BUILD-VERIFICATION.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    update={'schema':1,'package':'uz.tameer.hr','versionCode':version_code,'versionName':version,'minSdk':26,
        'apkUrl':f'https://{args.host}/downloads/TAMEER-HR-manager.apk','sha256':digest,'size':output.stat().st_size,'signerSha256':signer,
        'releaseNotes':{'ru':'Автоматическая проверка и загрузка обновлений APK. Установка после подтверждения Android. Настройки обновлений в кабинете руководителя.',
            'uz':'APK yangilanishlarini avtomatik tekshirish va yuklash. O‘rnatish Android tasdig‘idan keyin bajariladi. Yangilanish sozlamalari rahbar kabinetida.'}}
    output.with_suffix('.update.json').write_text(json.dumps(update,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({k:report[k] for k in ['package','version','apkBytes','sha256','minSdk','targetSdk','staticChecks']},ensure_ascii=False),flush=True)

if __name__=='__main__': main()
