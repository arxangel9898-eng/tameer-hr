package uz.tameer.hr;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.ServiceWorkerClient;
import android.webkit.ServiceWorkerController;
import android.webkit.ServiceWorkerWebSettings;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import java.io.ByteArrayInputStream;
import java.util.Locale;
import java.net.HttpURLConnection;
import java.net.URL;
import java.io.BufferedInputStream;
import java.io.OutputStream;
import android.widget.Toast;

/** Thin trusted-origin client. Every account and access check is enforced on the server. */
public final class MainActivity extends Activity {
    private static final String TRUSTED_HOST = OriginPolicy.HOST;
    private static final String START_URL = "https://" + TRUSTED_HOST + "/manager";
    private static final String BACK_SCRIPT = "(function(){try{if(typeof window.tameerHRBack==='function' && window.tameerHRBack()===true)return true;}catch(e){}try{var dialog=document.querySelector('dialog[open]');if(dialog){dialog.close();return true;}}catch(e){}return false;})()";
    private static final int CHOOSE_FILE = 401;
    private static final int SAVE_EXCEL = 402;
    private static final String XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    private String pendingExcel;
    private volatile HttpURLConnection exportConnection;
    private volatile boolean exporting;
    private WebView web;
    private FrameLayout shell;
    private LinearLayout splash;
    private ProgressBar progress;
    private ValueCallback<Uri[]> fileCallback;
    private boolean loadFailed;
    private String retryUrl = START_URL;
    private String language;
    private boolean backPending;
    private AppUpdater updater;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        language = Locale.getDefault().getLanguage();
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        shell = new FrameLayout(this);
        shell.setBackgroundColor(Color.rgb(244,247,252));
        web = new WebView(this);
        web.setBackgroundColor(Color.rgb(244,247,252));
        if (Build.VERSION.SDK_INT >= 26) web.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        shell.addView(web, new FrameLayout.LayoutParams(-1,-1));
        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setMax(100);
        FrameLayout.LayoutParams bar = new FrameLayout.LayoutParams(-1,dp(3),Gravity.TOP);
        shell.addView(progress,bar);
        setContentView(shell);
        if (Build.VERSION.SDK_INT >= 30) {
            shell.setOnApplyWindowInsetsListener((v,insets) -> {
                android.graphics.Insets system = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                v.setPadding(system.left,system.top,system.right,system.bottom);
                return insets;
            });
        } else {
            shell.setFitsSystemWindows(true);
        }
        configureWebView();
        updater = new AppUpdater(this);
        showPanel(false);
        web.loadUrl(START_URL);
    }

    private void configureWebView() {
        WebView.setWebContentsDebuggingEnabled(false);
        WebSettings s=web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setSafeBrowsingEnabled(true);
        s.setSaveFormData(false);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSupportMultipleWindows(false);
        s.setGeolocationEnabled(false);
        s.setBuiltInZoomControls(false);
        s.setSupportZoom(false);
        s.setUserAgentString(s.getUserAgentString()+" TAMEERHRAndroid/1.2.0");
        CookieManager cookies=CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(web,false);
        ServiceWorkerController workers=ServiceWorkerController.getInstance();
        ServiceWorkerWebSettings workerSettings=workers.getServiceWorkerWebSettings();
        workerSettings.setAllowFileAccess(false);
        workerSettings.setAllowContentAccess(false);
        workerSettings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        workers.setServiceWorkerClient(new ServiceWorkerClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
                if (isTrusted(request.getUrl())) return null;
                return blockedResponse();
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest request) {
                Uri u=request.getUrl();
                if(request.isForMainFrame()&&request.hasGesture()&&OriginPolicy.isUpdateSettings(u.toString())){if(updater!=null)updater.showSettings();return true;}
                if (isTrusted(u)) return false;
                if (request.isForMainFrame() && request.hasGesture() && "blob".equals(u.getScheme())) { showExportHelp(); return true; }
                if (request.isForMainFrame() && request.hasGesture() && externalAllowed(u)) confirmExternal(u,false);
                return true;
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view,String url) {
                // Deprecated callback lacks proof of a user gesture: fail closed for external destinations.
                return !isTrusted(Uri.parse(url));
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view,WebResourceRequest request) {
                Uri u=request.getUrl(); String scheme=u.getScheme();
                if (isTrusted(u) || "data".equals(scheme) || "blob".equals(scheme) || "about".equals(scheme)) return null;
                return blockedResponse();
            }
            @Override public void onPageStarted(WebView view,String url,android.graphics.Bitmap icon) {
                loadFailed=false;
                if (isTrusted(Uri.parse(url))) retryUrl=url;
                progress.setVisibility(View.VISIBLE);
            }
            @Override public void onPageFinished(WebView view,String url) {
                if (!loadFailed && isTrusted(Uri.parse(url))) removePanel();
                progress.setVisibility(View.GONE);
                CookieManager.getInstance().flush();
            }
            @Override public void onReceivedError(WebView view,WebResourceRequest request,WebResourceError error) {
                if (request.isForMainFrame()) { loadFailed=true; showPanel(true); }
            }
            @Override public void onReceivedHttpError(WebView view,WebResourceRequest request,WebResourceResponse error) {
                if (request.isForMainFrame() && error.getStatusCode()>=500) { loadFailed=true; showPanel(true); }
            }
            @Override public void onReceivedSslError(WebView view,SslErrorHandler handler,SslError error) {
                handler.cancel(); loadFailed=true; showPanel(true);
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onProgressChanged(WebView view,int p) { progress.setProgress(p); }
            @Override public void onPermissionRequest(PermissionRequest request) { request.deny(); }
            @Override public void onGeolocationPermissionsShowPrompt(String origin,GeolocationPermissions.Callback callback) { callback.invoke(origin,false,false); }
            @Override public boolean onShowFileChooser(WebView view,ValueCallback<Uri[]> callback,FileChooserParams params) {
                if (!isTrusted(Uri.parse(view.getUrl()==null?"":view.getUrl()))) { callback.onReceiveValue(null); return true; }
                if (fileCallback!=null) fileCallback.onReceiveValue(null);
                fileCallback=callback;
                Intent chooser=new Intent(Intent.ACTION_OPEN_DOCUMENT);
                chooser.addCategory(Intent.CATEGORY_OPENABLE);
                chooser.setType("*/*");
                chooser.putExtra(Intent.EXTRA_MIME_TYPES,new String[]{"image/jpeg","image/png","application/pdf","text/csv","application/vnd.ms-excel","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
                chooser.putExtra(Intent.EXTRA_ALLOW_MULTIPLE,params.getMode()==FileChooserParams.MODE_OPEN_MULTIPLE);
                try { startActivityForResult(Intent.createChooser(chooser,tr("Выберите документ","Hujjatni tanlang","Ҳуҷҷатро интихоб кунед")),CHOOSE_FILE); }
                catch (ActivityNotFoundException e) { fileCallback.onReceiveValue(null); fileCallback=null; }
                return true;
            }
        });
        web.setDownloadListener((url,userAgent,disposition,mime,length) -> {
            Uri u=Uri.parse(url);
            if (OriginPolicy.isReportExport(url)) saveExcel(u);
            else if (isTrusted(u)) confirmExternal(u,true);
            else showExportHelp();
        });
        if (Build.VERSION.SDK_INT>=33) getOnBackInvokedDispatcher().registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT,()->goBack());
    }

    static boolean isTrusted(Uri u) {
        return u!=null && OriginPolicy.isTrusted(u.toString());
    }
    static boolean externalAllowed(Uri u) {
        if (u==null || u.getScheme()==null) return false;
        String scheme=u.getScheme().toLowerCase(Locale.ROOT);
        return ("https".equals(scheme) && u.getHost()!=null && u.getUserInfo()==null && (u.getPort()==-1 || u.getPort()==443)) || "tel".equals(scheme) || "mailto".equals(scheme);
    }
    private static WebResourceResponse blockedResponse() {
        return new WebResourceResponse("text/plain","UTF-8",403,"Blocked",java.util.Collections.emptyMap(),new ByteArrayInputStream(new byte[0]));
    }
    private void saveExcel(Uri uri) {
        if (!OriginPolicy.isReportExport(uri.toString()) || pendingExcel!=null || exporting || isFinishing() || isDestroyed()) return;
        pendingExcel=uri.toString();
        Intent intent=new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE); intent.setType(XLSX);
        intent.putExtra(Intent.EXTRA_TITLE,"TAMEER-attendance-period.xlsx");
        try { startActivityForResult(intent,SAVE_EXCEL); }
        catch (ActivityNotFoundException ex) { pendingExcel=null; showExportHelp(); }
    }
    private void writeExcel(String url,Uri destination) {
        if (!OriginPolicy.isReportExport(url) || destination==null || !"content".equals(destination.getScheme())) return;
        final String cookie=CookieManager.getInstance().getCookie(url);
        exporting=true;
        new Thread(()->{
            HttpURLConnection connection=null; boolean success=false;
            try {
                connection=(HttpURLConnection)new URL(url).openConnection(); exportConnection=connection;
                connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(20000); connection.setReadTimeout(60000);
                connection.setRequestProperty("Accept",XLSX); if (cookie!=null) connection.setRequestProperty("Cookie",cookie);
                int status=connection.getResponseCode(); String type=connection.getContentType();
                if (status!=200 || type==null || !type.toLowerCase(Locale.ROOT).startsWith(XLSX) || connection.getContentLengthLong()>25*1024*1024) throw new java.io.IOException("Report response rejected");
                try (BufferedInputStream input=new BufferedInputStream(connection.getInputStream())) {
                    input.mark(4); if(input.read()!=80 || input.read()!=75) throw new java.io.IOException("Invalid report"); input.reset();
                    try (OutputStream output=getContentResolver().openOutputStream(destination,"w")) {
                        if(output==null) throw new java.io.IOException("Destination unavailable");
                        byte[] bytes=new byte[16384]; int count,total=0;
                        while((count=input.read(bytes))!=-1){total+=count;if(total>25*1024*1024 || isDestroyed()) throw new java.io.IOException("Report cancelled");output.write(bytes,0,count);}
                        output.flush(); success=true;
                    }
                }
            } catch (Exception ex) { /* Session and server details stay out of device logs. */ }
            finally { if(connection!=null)connection.disconnect();exportConnection=null;exporting=false; }
            final boolean saved=success;
            runOnUiThread(()->{if(!isFinishing()&&!isDestroyed())Toast.makeText(this,saved?tr("Excel сохранён","Excel saqlandi","Excel сабт шуд"):tr("Не удалось скачать Excel. Проверьте вход и доступ к отчётам, затем повторите.","Excel yuklanmadi. Tizimga kirish va hisobotlar ruxsatini tekshirib, qayta urining.","Excel боргирӣ нашуд. Воридшавӣ ва иҷозати ҳисоботро санҷед."),Toast.LENGTH_LONG).show();});
        },"tameer-excel").start();
    }
    private void confirmExternal(Uri uri,boolean download) {
        String msg=download
            ? tr("Документ откроется в браузере. При необходимости войдите там в свой аккаунт. Сессия приложения не передаётся другим программам.","Hujjat brauzerda ochiladi. Zarur bo‘lsa, u yerda akkauntingizga kiring. Ilova seansi boshqa dasturlarga berilmaydi.","Ҳуҷҷат дар браузер кушода мешавад. Агар лозим бошад, ворид шавед. Сеанси барнома ба дигар барномаҳо дода намешавад.")
            : tr("Открыть ссылку в другом приложении?","Havolani boshqa ilovada ochilsinmi?","Истинод дар барномаи дигар кушода шавад?");
        String destination="https".equals(uri.getScheme()) ? uri.getHost() : uri.getScheme();
        new AlertDialog.Builder(this).setTitle(tr("Открыть ссылку","Havolani ochish","Кушодани истинод"))
            .setMessage(msg+"\n\n"+destination)
            .setPositiveButton(tr("Открыть","Ochish","Кушодан"),(dialog,which)->openExternal(uri))
            .setNegativeButton(tr("Отмена","Bekor qilish","Бекор кардан"),null).show();
    }
    private void openExternal(Uri uri) {
        if (!externalAllowed(uri)) return;
        try { startActivity(new Intent(Intent.ACTION_VIEW,uri)); }
        catch (ActivityNotFoundException e) { new AlertDialog.Builder(this).setMessage(tr("Подходящее приложение не найдено.","Mos ilova topilmadi.","Барномаи мувофиқ ёфт нашуд.")).setPositiveButton("OK",null).show(); }
    }
    private void showExportHelp() {
        new AlertDialog.Builder(this).setTitle(tr("Экспорт файла","Fayl eksporti","Содироти файл"))
            .setMessage(tr("Для этого экспорта откройте кабинет в браузере и войдите в свой аккаунт.","Ushbu eksport uchun kabinetni brauzerda ochib, akkauntingizga kiring.","Барои ин содирот кабинетро дар браузер кушоед ва ворид шавед."))
            .setPositiveButton(tr("Открыть браузер","Brauzerni ochish","Кушодани браузер"),(d,w)->openExternal(Uri.parse(START_URL)))
            .setNegativeButton(tr("Отмена","Bekor qilish","Бекор кардан"),null).show();
    }
    private void showPanel(boolean failed) {
        removePanel();
        splash=new LinearLayout(this); splash.setOrientation(LinearLayout.VERTICAL); splash.setGravity(Gravity.CENTER);
        splash.setPadding(dp(28),dp(28),dp(28),dp(28)); splash.setBackgroundColor(Color.rgb(244,247,252));
        ImageView logo=new ImageView(this); logo.setImageResource(R.mipmap.ic_launcher); splash.addView(logo,new LinearLayout.LayoutParams(dp(112),dp(112)));
        TextView name=new TextView(this); name.setText("TAMEER HR"); name.setTextSize(28); name.setTextColor(Color.rgb(7,31,60)); name.setGravity(Gravity.CENTER); name.setTypeface(null,android.graphics.Typeface.BOLD);
        LinearLayout.LayoutParams label=new LinearLayout.LayoutParams(-1,-2); label.topMargin=dp(20); splash.addView(name,label);
        TextView desc=new TextView(this); desc.setTextSize(16); desc.setTextColor(Color.rgb(104,121,149)); desc.setGravity(Gravity.CENTER);
        desc.setText(failed ? tr("Не удалось открыть кабинет. Проверьте интернет и попробуйте ещё раз.","Kabinet ochilmadi. Internetni tekshirib, qayta urinib ko‘ring.","Кабинет кушода нашуд. Интернетро санҷед ва бори дигар кӯшиш кунед.") : tr("Кабинет руководителя\nЗагружаем рабочее пространство…","Rahbar kabineti\nIsh maydoni yuklanmoqda…","Кабинети роҳбар\nМуҳити корӣ бор карда мешавад…"));
        LinearLayout.LayoutParams text=new LinearLayout.LayoutParams(-1,-2); text.topMargin=dp(12); splash.addView(desc,text);
        if (failed) {
            Button retry=new Button(this); retry.setText(tr("Повторить","Qayta urinish","Такрор кардан")); retry.setOnClickListener(v->{showPanel(false); web.loadUrl(isTrusted(Uri.parse(retryUrl))?retryUrl:START_URL);});
            LinearLayout.LayoutParams button=new LinearLayout.LayoutParams(-1,dp(52)); button.topMargin=dp(24); splash.addView(retry,button);
            Button browser=new Button(this); browser.setText(tr("Открыть в браузере","Brauzerda ochish","Дар браузер кушодан")); browser.setOnClickListener(v->openExternal(Uri.parse(START_URL))); splash.addView(browser,new LinearLayout.LayoutParams(-1,dp(52)));
        } else { ProgressBar spin=new ProgressBar(this); LinearLayout.LayoutParams spinner=new LinearLayout.LayoutParams(dp(36),dp(36)); spinner.topMargin=dp(24); splash.addView(spin,spinner); }
        shell.addView(splash,new FrameLayout.LayoutParams(-1,-1));
    }
    private void removePanel() { if (splash!=null) { shell.removeView(splash); splash=null; } }
    private int dp(int n) { return Math.round(n*getResources().getDisplayMetrics().density); }
    private String tr(String ru,String uz,String tj) { return "uz".equals(language)?uz:"tg".equals(language)?tj:ru; }
    private void goBack() {
        if (backPending || isFinishing() || isDestroyed()) return;
        if (web==null || !isTrusted(Uri.parse(web.getUrl()==null?"":web.getUrl()))) { nativeBack(); return; }
        backPending=true;
        try {
            web.evaluateJavascript(BACK_SCRIPT,result->{
                backPending=false;
                if (isFinishing() || isDestroyed()) return;
                if ("true".equals(result)) return;
                nativeBack();
            });
        } catch (RuntimeException e) { backPending=false; nativeBack(); }
    }
    private void nativeBack() {
        if (isFinishing() || isDestroyed()) return;
        if (web!=null && web.canGoBack()) web.goBack(); else finish();
    }
    @Override public void onBackPressed() { goBack(); }
    @Override protected void onActivityResult(int request,int result,Intent data) {
        super.onActivityResult(request,result,data);
        if(updater!=null&&updater.onActivityResult(request))return;
        if(request==SAVE_EXCEL){String url=pendingExcel;pendingExcel=null;if(result==RESULT_OK&&data!=null&&url!=null)writeExcel(url,data.getData());return;}
        if (request!=CHOOSE_FILE || fileCallback==null) return;
        Uri[] selected=null;
        if (result==RESULT_OK && data!=null) {
            java.util.ArrayList<Uri> valid=new java.util.ArrayList<>();
            if (data.getClipData()!=null) for (int i=0;i<Math.min(data.getClipData().getItemCount(),20);i++) { Uri u=data.getClipData().getItemAt(i).getUri(); if (u!=null && "content".equals(u.getScheme())) valid.add(u); }
            else if (data.getData()!=null && "content".equals(data.getData().getScheme())) valid.add(data.getData());
            if (!valid.isEmpty()) selected=valid.toArray(new Uri[0]);
        }
        fileCallback.onReceiveValue(selected); fileCallback=null;
    }
    @Override protected void onPause() { super.onPause(); if(updater!=null)updater.onPause();web.onPause(); CookieManager.getInstance().flush(); }
    @Override protected void onResume() { super.onResume(); if (web!=null) web.onResume();if(updater!=null)updater.onResume(); }
    @Override protected void onDestroy() { if(updater!=null)updater.destroy();pendingExcel=null; if(exportConnection!=null)exportConnection.disconnect(); if (fileCallback!=null) fileCallback.onReceiveValue(null); if (web!=null) { web.stopLoading(); web.clearCache(true); web.destroy(); } super.onDestroy(); }
}
