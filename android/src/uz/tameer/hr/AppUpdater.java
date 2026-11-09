package uz.tameer.hr;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;
import org.json.JSONObject;

/** Foreground-only update checks. Installation always uses Android confirmation. */
final class AppUpdater {
    private static final int SOURCE_PERMISSION=821,INSTALL_UPDATE=822;
    private static final long CHECK_INTERVAL=30L*60*1000,POSTPONE_INTERVAL=6L*60*60*1000;
    private final Activity activity;
    private final SharedPreferences prefs;
    private final Handler handler=new Handler(Looper.getMainLooper());
    private volatile boolean destroyed,busy;
    private volatile HttpURLConnection connection;
    private volatile Thread worker;
    private boolean foreground,awaitingPermission,awaitingInstaller,dialogOpen,deferredInstall;
    private final java.util.ArrayList<AlertDialog> dialogs=new java.util.ArrayList<>();
    private final Runnable timer=new Runnable(){@Override public void run(){if(foreground&&!destroyed){check(false);schedule();}}};
    AppUpdater(Activity activity){this.activity=activity;prefs=activity.getSharedPreferences("tameer-app-updates",0);}
    private String tr(String ru,String uz){return "uz".equals(Locale.getDefault().getLanguage())?uz:ru;}
    private boolean live(){return !destroyed&&!activity.isFinishing()&&!activity.isDestroyed();}
    private void ui(Runnable action){handler.post(()->{if(live())action.run();});}
    private void toast(String text){ui(()->Toast.makeText(activity,text,Toast.LENGTH_LONG).show());}
    private long installedCode()throws Exception{PackageInfo p=activity.getPackageManager().getPackageInfo(UpdatePolicy.PACKAGE,0);return code(p);}
    private static long code(PackageInfo p){return Build.VERSION.SDK_INT>=28?p.getLongVersionCode():p.versionCode;}
    void onResume(){foreground=true;if(deferredInstall)performDeferredInstall();else if(!awaitingPermission&&!awaitingInstaller){UpdatePolicy.Manifest m=pending();if(m!=null&&UpdateFileProvider.file(activity).isFile()&&System.currentTimeMillis()>=prefs.getLong("postponeUntil",0)){launch(()->{try{verify(m,UpdateFileProvider.file(activity));ui(()->ready(m));}catch(Exception e){prefs.edit().remove("pendingManifest").apply();}});}else check(false);}schedule();}
    void onPause(){foreground=false;handler.removeCallbacks(timer);}
    void destroy(){destroyed=true;foreground=false;handler.removeCallbacksAndMessages(null);for(AlertDialog d:new java.util.ArrayList<>(dialogs))d.dismiss();dialogs.clear();HttpURLConnection c=connection;if(c!=null)c.disconnect();Thread t=worker;if(t!=null)t.interrupt();}
    private AlertDialog show(AlertDialog.Builder builder){AlertDialog d=builder.create();trackAndShow(d);return d;}
    private void trackAndShow(AlertDialog d){dialogOpen=true;dialogs.add(d);d.setOnDismissListener(ignored->{dialogs.remove(d);dialogOpen=false;});d.show();}
    private void schedule(){handler.removeCallbacks(timer);if(foreground&&prefs.getBoolean("autoCheck",true))handler.postDelayed(timer,CHECK_INTERVAL);}
    private void launch(Runnable action){if(busy||destroyed)return;busy=true;worker=new Thread(()->{try{action.run();}finally{worker=null;busy=false;}},"tameer-app-update");worker.start();}
    private static int integer(JSONObject j,String name)throws Exception{Object n=j.get(name);if(!(n instanceof Integer)&&!(n instanceof Long))throw new IllegalArgumentException("Invalid integer");long value=((Number)n).longValue();if(value<Integer.MIN_VALUE||value>Integer.MAX_VALUE)throw new IllegalArgumentException("Invalid integer");return(int)value;}
    private static String string(JSONObject j,String name)throws Exception{Object value=j.get(name);if(!(value instanceof String))throw new IllegalArgumentException("Invalid string");return(String)value;}
    private static UpdatePolicy.Manifest parse(String text)throws Exception{
        if(text==null||text.getBytes(StandardCharsets.UTF_8).length>UpdatePolicy.MAX_MANIFEST_BYTES)throw new IllegalArgumentException("Manifest too large");JSONObject j=new JSONObject(text),notes=j.getJSONObject("releaseNotes");Object size=j.get("size");if(!(size instanceof Integer)&&!(size instanceof Long))throw new IllegalArgumentException("Invalid size");
        return new UpdatePolicy.Manifest(integer(j,"schema"),string(j,"package"),integer(j,"versionCode"),string(j,"versionName"),integer(j,"minSdk"),string(j,"apkUrl"),string(j,"sha256"),((Number)size).longValue(),string(j,"signerSha256"),string(notes,"ru"),string(notes,"uz"));
    }
    private UpdatePolicy.Manifest pending(){try{return parse(prefs.getString("pendingManifest",null));}catch(Exception e){return null;}}
    private HttpURLConnection open(String url)throws Exception{
        if(!UpdatePolicy.MANIFEST_URL.equals(url)&&!UpdatePolicy.APK_URL.equals(url))throw new IllegalArgumentException("Unknown update URL");
        HttpURLConnection c=(HttpURLConnection)new URL(url).openConnection();connection=c;c.setInstanceFollowRedirects(false);c.setConnectTimeout(15000);c.setReadTimeout(20000);c.setUseCaches(false);c.setRequestMethod("GET");c.setRequestProperty("Accept",UpdatePolicy.MANIFEST_URL.equals(url)?"application/json":"application/vnd.android.package-archive");c.setRequestProperty("Cache-Control","no-cache");
        try{if(c.getResponseCode()!=200)throw new java.io.IOException("Update response rejected");return c;}catch(Exception e){c.disconnect();connection=null;throw e;}
    }
    private String readManifest()throws Exception{
        HttpURLConnection c=null;try{c=open(UpdatePolicy.MANIFEST_URL);String type=c.getContentType();if(type==null||!type.toLowerCase(Locale.ROOT).startsWith("application/json")||c.getContentLengthLong()>UpdatePolicy.MAX_MANIFEST_BYTES)throw new java.io.IOException("Manifest response rejected");try(InputStream in=c.getInputStream();ByteArrayOutputStream out=new ByteArrayOutputStream()){byte[] bytes=new byte[4096];int n,total=0;while((n=in.read(bytes))!=-1){total+=n;if(destroyed||Thread.currentThread().isInterrupted()||total>UpdatePolicy.MAX_MANIFEST_BYTES)throw new java.io.IOException("Manifest cancelled");out.write(bytes,0,n);}return new String(out.toByteArray(),StandardCharsets.UTF_8);}}finally{if(c!=null)c.disconnect();connection=null;}
    }
    void check(boolean manual){
        if(!live()||busy||awaitingPermission||awaitingInstaller||(!manual&&!prefs.getBoolean("autoCheck",true)))return;
        long now=System.currentTimeMillis(),last=prefs.getLong("lastCheck",0);if(!manual&&now>=last&&now-last<CHECK_INTERVAL)return;
        prefs.edit().putLong("lastCheck",now).apply();if(manual)toast(tr("Проверяем обновления…","Yangilanishlar tekshirilmoqda…"));
        launch(()->{try{
            String raw=readManifest();UpdatePolicy.Manifest m=parse(raw);long current=installedCode();
            if(!m.isUpdate(current,Build.VERSION.SDK_INT)){if(m.versionCode<=current){prefs.edit().remove("pendingManifest").apply();if(manual)toast(tr("Установлена актуальная версия.","Eng yangi versiya o‘rnatilgan."));}else if(manual)toast(tr("Для новой версии требуется более новый Android.","Yangi versiya uchun yangiroq Android kerak."));return;}
            File f=UpdateFileProvider.file(activity);UpdatePolicy.Manifest old=pending();
            if(old!=null&&old.versionCode==m.versionCode&&old.sha256.equals(m.sha256)&&f.isFile()){verify(m,f);if(manual||System.currentTimeMillis()>=prefs.getLong("postponeUntil",0))ui(()->ready(m));return;}
            if(prefs.getBoolean("autoDownload",true)){download(m,raw);if(manual||System.currentTimeMillis()>=prefs.getLong("postponeUntil",0))ui(()->ready(m));}
            else if(manual||System.currentTimeMillis()>=prefs.getLong("postponeUntil",0))ui(()->offer(m,raw));
        }catch(Exception e){if(manual)toast(tr("Не удалось проверить обновление. Проверьте интернет и повторите.","Yangilanish tekshirilmadi. Internetni tekshirib, qayta urining."));}});
    }
    private static String hex(byte[] bytes){StringBuilder out=new StringBuilder();for(byte b:bytes)out.append(String.format(Locale.ROOT,"%02x",b&255));return out.toString();}
    private static String hash(File f)throws Exception{MessageDigest digest=MessageDigest.getInstance("SHA-256");try(InputStream in=new FileInputStream(f)){byte[] bytes=new byte[16384];int n;while((n=in.read(bytes))!=-1){if(Thread.currentThread().isInterrupted())throw new java.io.IOException("Cancelled");digest.update(bytes,0,n);}}return hex(digest.digest());}
    private static String signer(PackageInfo p)throws Exception{
        Signature[] signatures=Build.VERSION.SDK_INT>=28&&p.signingInfo!=null?p.signingInfo.getApkContentsSigners():p.signatures;if(signatures==null||signatures.length!=1)throw new IllegalArgumentException("Unknown signer");return hex(MessageDigest.getInstance("SHA-256").digest(signatures[0].toByteArray()));
    }
    private void verify(UpdatePolicy.Manifest m,File file)throws Exception{
        if(!file.isFile()||file.length()!=m.size)throw new java.io.IOException("File size mismatch");PackageManager pm=activity.getPackageManager();int flags=Build.VERSION.SDK_INT>=28?PackageManager.GET_SIGNING_CERTIFICATES:PackageManager.GET_SIGNATURES;
        PackageInfo current=pm.getPackageInfo(UpdatePolicy.PACKAGE,flags),archive=pm.getPackageArchiveInfo(file.getAbsolutePath(),flags);if(archive==null||archive.applicationInfo==null)throw new java.io.IOException("Invalid archive");
        UpdatePolicy.verifyArchive(m,code(current),Build.VERSION.SDK_INT,file.length(),hash(file),archive.packageName,code(archive),archive.versionName,archive.applicationInfo.minSdkVersion,signer(current),signer(archive));
    }
    private void download(UpdatePolicy.Manifest m,String raw)throws Exception{
        File target=UpdateFileProvider.file(activity),dir=target.getParentFile();if(!dir.isDirectory()&&!dir.mkdirs())throw new java.io.IOException("Update folder unavailable");File partial=new File(dir,"manager-update.part.apk");HttpURLConnection c=null;boolean promoted=false;
        try{c=open(m.url);if(c.getContentLengthLong()!=m.size)throw new java.io.IOException("APK size header mismatch");String type=c.getContentType();if(type==null||!type.toLowerCase(Locale.ROOT).startsWith("application/vnd.android.package-archive"))throw new java.io.IOException("APK type mismatch");
            try(InputStream in=c.getInputStream();FileOutputStream out=new FileOutputStream(partial)){byte[] bytes=new byte[16384];int n;long total=0;while((n=in.read(bytes))!=-1){total+=n;if(destroyed||Thread.currentThread().isInterrupted()||total>m.size||total>UpdatePolicy.MAX_APK_BYTES)throw new java.io.IOException("APK cancelled");out.write(bytes,0,n);}out.flush();out.getFD().sync();if(total!=m.size)throw new java.io.IOException("APK incomplete");}
            verify(m,partial);if(destroyed)throw new java.io.IOException("Activity closed");if(target.exists()&&!target.delete())throw new java.io.IOException("Old update unavailable");if(!partial.renameTo(target))throw new java.io.IOException("Cannot promote update");promoted=true;prefs.edit().putString("pendingManifest",raw).apply();
        }finally{if(c!=null)c.disconnect();connection=null;if(!promoted)partial.delete();}
    }
    private String notes(UpdatePolicy.Manifest m){return tr(m.ru,m.uz);}
    private void offer(UpdatePolicy.Manifest m,String raw){
        if(!foreground||dialogOpen||!live())return;show(new AlertDialog.Builder(activity).setTitle(tr("Доступно обновление ","Yangilanish mavjud: ")+m.versionName).setMessage(notes(m)).setPositiveButton(tr("Загрузить","Yuklash"),(d,w)->{launch(()->{try{download(m,raw);ui(()->ready(m));}catch(Exception e){toast(tr("Не удалось загрузить обновление. Повторите проверку.","Yangilanish yuklanmadi. Qayta tekshiring."));}});}).setNegativeButton(tr("Позже","Keyinroq"),(d,w)->postpone()).setOnCancelListener(d->postpone()));
    }
    private void postpone(){prefs.edit().putLong("postponeUntil",System.currentTimeMillis()+POSTPONE_INTERVAL).apply();}
    private void ready(UpdatePolicy.Manifest m){
        if(!foreground||dialogOpen||!live())return;show(new AlertDialog.Builder(activity).setTitle(tr("Обновление готово: ","Yangilanish tayyor: ")+m.versionName).setMessage(notes(m)+"\n\n"+tr("Перед установкой сохраните изменения в открытых формах. Android попросит подтвердить установку.","O‘rnatishdan oldin ochiq shakllardagi o‘zgarishlarni saqlang. Android o‘rnatishni tasdiqlashingizni so‘raydi.")).setPositiveButton(tr("Установить","O‘rnatish"),(d,w)->install()).setNegativeButton(tr("Позже","Keyinroq"),(d,w)->postpone()).setOnCancelListener(d->postpone()));
    }
    private void install(){
        if(!live()||busy||awaitingPermission||awaitingInstaller)return;UpdatePolicy.Manifest m=pending();if(m==null){toast(tr("Сначала проверьте обновления.","Avval yangilanishni tekshiring."));return;}
        launch(()->{try{verify(m,UpdateFileProvider.file(activity));ui(()->installVerified());}catch(Exception e){prefs.edit().remove("pendingManifest").apply();toast(tr("Файл обновления не прошёл проверку. Загрузите его заново.","Yangilanish fayli tekshiruvdan o‘tmadi. Qayta yuklang."));}});
    }
    private void installVerified(){
        if(!foreground||!live())return;
        if(!activity.getPackageManager().canRequestPackageInstalls()){
            awaitingPermission=true;
            show(new AlertDialog.Builder(activity).setTitle(tr("Разрешение Android","Android ruxsati")).setMessage(tr("Разрешите TAMEER HR устанавливать обновления из этого источника. Затем Android отдельно попросит подтвердить обновление.","TAMEER HR uchun shu manbadan yangilanish o‘rnatishga ruxsat bering. Keyin Android yangilanishni alohida tasdiqlashni so‘raydi.")).setPositiveButton(tr("Настройки","Sozlamalar"),(d,w)->{try{activity.startActivityForResult(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,Uri.parse("package:"+UpdatePolicy.PACKAGE)),SOURCE_PERMISSION);}catch(Exception e){awaitingPermission=false;toast(tr("Откройте разрешение установки в настройках Android.","Android sozlamalarida o‘rnatishga ruxsat bering."));}}).setNegativeButton(tr("Отмена","Bekor qilish"),(d,w)->awaitingPermission=false).setOnCancelListener(d->awaitingPermission=false));return;
        }
        try{Intent intent=new Intent(Intent.ACTION_VIEW);intent.setDataAndType(UpdateFileProvider.URI,"application/vnd.android.package-archive");intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);awaitingInstaller=true;activity.startActivityForResult(intent,INSTALL_UPDATE);}catch(Exception e){awaitingInstaller=false;toast(tr("Не удалось открыть установщик Android.","Android o‘rnatuvchisi ochilmadi."));}
    }
    boolean onActivityResult(int request){
        if(request==SOURCE_PERMISSION){boolean requested=awaitingPermission;awaitingPermission=false;deferredInstall=requested&&activity.getPackageManager().canRequestPackageInstalls();if(requested&&!deferredInstall)postpone();handler.post(()->performDeferredInstall());return true;}
        if(request==INSTALL_UPDATE){awaitingInstaller=false;postpone();return true;}return false;
    }
    private void performDeferredInstall(){if(deferredInstall&&foreground&&!awaitingPermission&&!awaitingInstaller&&live()){deferredInstall=false;install();}}
    void showSettings(){
        if(!live()||dialogOpen)return;LinearLayout body=new LinearLayout(activity);body.setOrientation(LinearLayout.VERTICAL);int pad=(int)(20*activity.getResources().getDisplayMetrics().density);body.setPadding(pad,pad,pad,pad);
        TextView text=new TextView(activity);text.setText(tr("Проверка выполняется при открытом приложении, не чаще одного раза в 30 минут. Установка требует подтверждения Android. Данные сайта обновляются независимо от APK.","Tekshiruv ilova ochiq bo‘lganda, ko‘pi bilan har 30 daqiqada bajariladi. O‘rnatish Android tasdig‘ini talab qiladi. Sayt ma’lumotlari APKdan mustaqil yangilanadi."));body.addView(text);
        CheckBox check=new CheckBox(activity);check.setText(tr("Автоматически проверять новые версии","Yangi versiyalarni avtomatik tekshirish"));check.setChecked(prefs.getBoolean("autoCheck",true));check.setOnCheckedChangeListener((b,value)->{prefs.edit().putBoolean("autoCheck",value).apply();schedule();});body.addView(check);
        CheckBox download=new CheckBox(activity);download.setText(tr("Автоматически загружать проверенное обновление","Tekshirilgan yangilanishni avtomatik yuklash"));download.setChecked(prefs.getBoolean("autoDownload",true));download.setOnCheckedChangeListener((b,value)->prefs.edit().putBoolean("autoDownload",value).apply());body.addView(download);
        Button now=new Button(activity);now.setText(busy?tr("Загрузка / проверка…","Yuklash / tekshirish…"):tr("Проверить сейчас","Hozir tekshirish"));now.setEnabled(!busy);body.addView(now);
        Button install=new Button(activity);install.setText(tr("Установить загруженное обновление","Yuklangan yangilanishni o‘rnatish"));install.setEnabled(!busy&&pending()!=null&&UpdateFileProvider.file(activity).isFile());body.addView(install);
        dialogOpen=true;AlertDialog dialog=new AlertDialog.Builder(activity).setTitle(tr("Обновления TAMEER HR","TAMEER HR yangilanishlari")).setView(body).setPositiveButton(tr("Готово","Tayyor"),null).setOnDismissListener(d->dialogOpen=false).create();now.setOnClickListener(v->{dialog.dismiss();check(true);});install.setOnClickListener(v->{dialog.dismiss();install();});trackAndShow(dialog);
    }
}
