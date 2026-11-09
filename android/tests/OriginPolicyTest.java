package uz.tameer.hr;

public final class OriginPolicyTest {
    public static void main(String[] args) {
        String host=OriginPolicy.HOST;
        String[] allowed={"https://"+host+"/manager","https://"+host+":443/#hrcenter","https://"+host+"/api/hr-workflows/attachment?id=abc","HTTPS://"+host.toUpperCase()+"/", "https://"+host+"/?return=https://outside.example"};
        String[] denied={null,"", "http://"+host+"/manager", "https://"+host+".evil.example/", "https://evil.example/"+host,
            "https://"+host+"@evil.example/", "https://user@"+host+"/", "https://"+host+":8443/", "https://"+host+":abc/",
            "https://"+host+"./", "https://"+host+"\\@evil.example/", "https://"+host.replaceFirst("\\.", "%2E")+"/", "file:///manager", "content://manager",
            "javascript:alert(1)", "intent://"+host+"/", "data:text/html,x", "//"+host+"/manager", "https://"+host+"/\nfoo"};
        for (String value:allowed) if (!OriginPolicy.isTrusted(value)) throw new AssertionError("Allowed URL blocked: "+value);
        for (String value:denied) if (OriginPolicy.isTrusted(value)) throw new AssertionError("Unsafe URL allowed: "+value);
        if(!OriginPolicy.isReportExport("https://"+host+"/api/reports/attendance.xlsx?from=2026-01-01&to=2026-12-31"))throw new AssertionError("Report blocked");
        for(String value:denied)if(OriginPolicy.isReportExport(value))throw new AssertionError("Unsafe report allowed");
        for(String value:new String[]{"https://"+host+"/api/reports/attendance.xlsx.evil","https://"+host+"/api/reports/%61ttendance.xlsx","https://"+host+"/api/reports/attendance.xlsx#x","https://"+host+"/api/payroll"})if(OriginPolicy.isReportExport(value))throw new AssertionError("Unexpected path allowed");
        if(!OriginPolicy.isUpdateSettings("https://"+host+"/android-app-updates"))throw new AssertionError("Update settings blocked");
        for(String value:denied)if(OriginPolicy.isUpdateSettings(value))throw new AssertionError("Unsafe settings URL");
        for(String value:new String[]{"https://"+host+"/android-app-updates?x=1","https://"+host+"/android-app-updates#x","https://"+host+"/%61ndroid-app-updates","https://"+host+"/android-app-updates/"})if(OriginPolicy.isUpdateSettings(value))throw new AssertionError("Unexpected settings path allowed");
        System.out.println("Origin policy: "+(allowed.length+denied.length)+" cases passed");
    }
}
