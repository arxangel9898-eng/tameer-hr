package uz.tameer.hr;

import java.net.URI;
import java.net.URISyntaxException;

/** Exact origin comparison without prefix or suffix matching. Used for every WebView navigation. */
final class OriginPolicy {
    static final String HOST=DeploymentConfig.HOST;
    static boolean isUpdateSettings(String url) {
        if(!isTrusted(url))return false;
        try{URI u=new URI(url);return "/android-app-updates".equals(u.getRawPath())&&u.getRawQuery()==null&&u.getRawFragment()==null;}
        catch(URISyntaxException ex){return false;}
    }
    static boolean isReportExport(String url) {
        if (!isTrusted(url)) return false;
        try { URI u=new URI(url);return "/api/reports/attendance.xlsx".equals(u.getRawPath()) && u.getRawFragment()==null; }
        catch (URISyntaxException ex) { return false; }
    }
    static boolean isTrusted(String url) {
        if (url==null || url.length()>16384) return false;
        try {
            URI u=new URI(url);
            return "https".equalsIgnoreCase(u.getScheme()) && HOST.equalsIgnoreCase(u.getHost())
                && (u.getPort()==-1 || u.getPort()==443) && u.getRawUserInfo()==null;
        } catch (URISyntaxException e) { return false; }
    }
}
