package uz.tameer.hr;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import java.io.File;
import java.io.FileNotFoundException;

/** Grants the Android installer read access to exactly one private update file. */
public final class UpdateFileProvider extends ContentProvider {
    static final String AUTHORITY="uz.tameer.hr.updates";
    static final Uri URI=Uri.parse("content://"+AUTHORITY+"/manager-update.apk");
    static File file(android.content.Context context){return new File(new File(context.getFilesDir(),"updates"),"manager-update.apk");}
    private File checked(Uri uri)throws FileNotFoundException{if(!URI.equals(uri)||getContext()==null)throw new FileNotFoundException("Update unavailable");File f=file(getContext());if(!f.isFile())throw new FileNotFoundException("Update unavailable");return f;}
    @Override public boolean onCreate(){return true;}
    @Override public String getType(Uri uri){if(!URI.equals(uri))throw new IllegalArgumentException("Unknown file");return "application/vnd.android.package-archive";}
    @Override public ParcelFileDescriptor openFile(Uri uri,String mode)throws FileNotFoundException{if(!"r".equals(mode))throw new FileNotFoundException("Read only");return ParcelFileDescriptor.open(checked(uri),ParcelFileDescriptor.MODE_READ_ONLY);}
    @Override public Cursor query(Uri uri,String[] projection,String selection,String[] args,String order){
        try{File f=checked(uri);String[] requested=projection==null?new String[]{OpenableColumns.DISPLAY_NAME,OpenableColumns.SIZE}:projection;MatrixCursor out=new MatrixCursor(requested);Object[] row=new Object[requested.length];for(int i=0;i<requested.length;i++)row[i]=OpenableColumns.DISPLAY_NAME.equals(requested[i])?"TAMEER-HR-manager.apk":OpenableColumns.SIZE.equals(requested[i])?f.length():null;out.addRow(row);return out;}catch(FileNotFoundException e){return null;}
    }
    @Override public Uri insert(Uri u,ContentValues v){throw new UnsupportedOperationException("Read only");}
    @Override public int update(Uri u,ContentValues v,String s,String[] a){throw new UnsupportedOperationException("Read only");}
    @Override public int delete(Uri u,String s,String[] a){throw new UnsupportedOperationException("Read only");}
}
