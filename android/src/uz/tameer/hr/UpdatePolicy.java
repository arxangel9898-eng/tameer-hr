package uz.tameer.hr;

/** Platform-independent validation shared by the updater and release tests. */
final class UpdatePolicy {
    static final String PACKAGE="uz.tameer.hr";
    static final String MANIFEST_URL="https://"+DeploymentConfig.HOST+"/downloads/android-update.json";
    static final String APK_URL="https://"+DeploymentConfig.HOST+"/downloads/TAMEER-HR-manager.apk";
    static final String SIGNER=DeploymentConfig.SIGNER;
    static final long MAX_APK_BYTES=20L*1024*1024;
    static final int MAX_MANIFEST_BYTES=32768;
    static final class Manifest {
        final int schema,versionCode,minSdk;
        final String packageName,versionName,url,sha256,signer,ru,uz;
        final long size;
        Manifest(int schema,String pkg,int code,String version,int minSdk,String url,String sha,long size,String signer,String ru,String uz) {
            if(schema!=1||!PACKAGE.equals(pkg)||code<=0||version==null||!version.matches("[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?")||version.length()>48
                ||minSdk<26||minSdk>10000||!APK_URL.equals(url)||sha==null||!sha.matches("[0-9a-f]{64}")
                ||size<=0||size>MAX_APK_BYTES||!SIGNER.equals(signer)||ru==null||uz==null||ru.length()>2000||uz.length()>2000)throw new IllegalArgumentException("Invalid update manifest");
            this.schema=schema;packageName=pkg;versionCode=code;versionName=version;this.minSdk=minSdk;this.url=url;sha256=sha;this.size=size;this.signer=signer;this.ru=ru;this.uz=uz;
        }
        boolean isUpdate(long installedCode,int deviceSdk){return versionCode>installedCode&&minSdk<=deviceSdk;}
    }
    static void verifyArchive(Manifest m,long installedCode,int deviceSdk,long actualSize,String actualHash,String archivePackage,long archiveCode,String archiveVersion,int archiveMinSdk,String installedSigner,String archiveSigner) {
        if(!m.isUpdate(installedCode,deviceSdk)||actualSize!=m.size||!m.sha256.equals(actualHash)||!PACKAGE.equals(archivePackage)||archiveCode!=m.versionCode
            ||!m.versionName.equals(archiveVersion)||archiveMinSdk!=m.minSdk||archiveMinSdk>deviceSdk||!SIGNER.equals(installedSigner)||!installedSigner.equals(archiveSigner))throw new IllegalArgumentException("Update validation failed");
    }
}
