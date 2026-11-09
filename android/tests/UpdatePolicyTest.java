package uz.tameer.hr;

public final class UpdatePolicyTest {
    private static int cases;
    private static final String HASH="abababababababababababababababababababababababababababababababab";
    private static UpdatePolicy.Manifest make(int schema,String pkg,int code,String version,int min,String url,String sha,long size,String signer,String ru){return new UpdatePolicy.Manifest(schema,pkg,code,version,min,url,sha,size,signer,ru,"Yangilanish");}
    private static UpdatePolicy.Manifest valid(){return make(1,UpdatePolicy.PACKAGE,3,"1.2.0",26,UpdatePolicy.APK_URL,HASH,80000,UpdatePolicy.SIGNER,"Обновление");}
    private static void rejected(Runnable f){cases++;try{f.run();}catch(IllegalArgumentException expected){return;}throw new AssertionError("Unsafe update accepted");}
    private static void yes(boolean value){cases++;if(!value)throw new AssertionError("Expected true");}
    private static void verify(UpdatePolicy.Manifest m,long installed,int sdk,long bytes,String hash,String pkg,long code,String version,int min,String installedSigner,String signer){UpdatePolicy.verifyArchive(m,installed,sdk,bytes,hash,pkg,code,version,min,installedSigner,signer);}
    public static void main(String[] args){
        UpdatePolicy.Manifest m=valid();yes(m.isUpdate(2,26));yes(!m.isUpdate(3,36));yes(!m.isUpdate(4,36));yes(!m.isUpdate(2,25));
        rejected(()->make(2,UpdatePolicy.PACKAGE,3,"1.2.0",26,UpdatePolicy.APK_URL,HASH,80000,UpdatePolicy.SIGNER,""));
        rejected(()->make(1,"foreign.app",3,"1.2.0",26,UpdatePolicy.APK_URL,HASH,80000,UpdatePolicy.SIGNER,""));
        rejected(()->make(1,UpdatePolicy.PACKAGE,0,"1.2.0",26,UpdatePolicy.APK_URL,HASH,80000,UpdatePolicy.SIGNER,""));
        for(String version:new String[]{null,"","v1.2.0","1.2",new String(new char[60]).replace('\0','1')})rejected(()->make(1,UpdatePolicy.PACKAGE,3,version,26,UpdatePolicy.APK_URL,HASH,80000,UpdatePolicy.SIGNER,""));
        for(String url:new String[]{UpdatePolicy.APK_URL.replaceFirst("^https:", "http:"),UpdatePolicy.APK_URL+"?host=evil","https://evil.example/TAMEER-HR-manager.apk","https://"+DeploymentConfig.HOST+".evil.example/downloads/TAMEER-HR-manager.apk",UpdatePolicy.MANIFEST_URL})rejected(()->make(1,UpdatePolicy.PACKAGE,3,"1.2.0",26,url,HASH,80000,UpdatePolicy.SIGNER,""));
        for(String sha:new String[]{null,"",HASH.toUpperCase(),HASH.substring(1),HASH.replace('a','g')})rejected(()->make(1,UpdatePolicy.PACKAGE,3,"1.2.0",26,UpdatePolicy.APK_URL,sha,80000,UpdatePolicy.SIGNER,""));
        for(long bytes:new long[]{0,-1,UpdatePolicy.MAX_APK_BYTES+1})rejected(()->make(1,UpdatePolicy.PACKAGE,3,"1.2.0",26,UpdatePolicy.APK_URL,HASH,bytes,UpdatePolicy.SIGNER,""));
        rejected(()->make(1,UpdatePolicy.PACKAGE,3,"1.2.0",25,UpdatePolicy.APK_URL,HASH,80000,UpdatePolicy.SIGNER,""));
        rejected(()->make(1,UpdatePolicy.PACKAGE,3,"1.2.0",26,UpdatePolicy.APK_URL,HASH,80000,HASH,""));
        rejected(()->make(1,UpdatePolicy.PACKAGE,3,"1.2.0",26,UpdatePolicy.APK_URL,HASH,80000,UpdatePolicy.SIGNER,new String(new char[2001])));
        verify(m,2,36,80000,HASH,UpdatePolicy.PACKAGE,3,"1.2.0",26,UpdatePolicy.SIGNER,UpdatePolicy.SIGNER);cases++;
        rejected(()->verify(m,3,36,80000,HASH,UpdatePolicy.PACKAGE,3,"1.2.0",26,UpdatePolicy.SIGNER,UpdatePolicy.SIGNER));
        rejected(()->verify(m,2,25,80000,HASH,UpdatePolicy.PACKAGE,3,"1.2.0",26,UpdatePolicy.SIGNER,UpdatePolicy.SIGNER));
        rejected(()->verify(m,2,36,79999,HASH,UpdatePolicy.PACKAGE,3,"1.2.0",26,UpdatePolicy.SIGNER,UpdatePolicy.SIGNER));
        rejected(()->verify(m,2,36,80000,HASH.replace('a','c'),UpdatePolicy.PACKAGE,3,"1.2.0",26,UpdatePolicy.SIGNER,UpdatePolicy.SIGNER));
        rejected(()->verify(m,2,36,80000,HASH,"other.package",3,"1.2.0",26,UpdatePolicy.SIGNER,UpdatePolicy.SIGNER));
        rejected(()->verify(m,2,36,80000,HASH,UpdatePolicy.PACKAGE,4,"1.2.0",26,UpdatePolicy.SIGNER,UpdatePolicy.SIGNER));
        rejected(()->verify(m,2,36,80000,HASH,UpdatePolicy.PACKAGE,3,"1.1.0",26,UpdatePolicy.SIGNER,UpdatePolicy.SIGNER));
        rejected(()->verify(m,2,36,80000,HASH,UpdatePolicy.PACKAGE,3,"1.2.0",27,UpdatePolicy.SIGNER,UpdatePolicy.SIGNER));
        rejected(()->verify(m,2,36,80000,HASH,UpdatePolicy.PACKAGE,3,"1.2.0",26,HASH,UpdatePolicy.SIGNER));
        rejected(()->verify(m,2,36,80000,HASH,UpdatePolicy.PACKAGE,3,"1.2.0",26,UpdatePolicy.SIGNER,HASH));
        System.out.println("Update policy: "+cases+" cases passed");
    }
}
