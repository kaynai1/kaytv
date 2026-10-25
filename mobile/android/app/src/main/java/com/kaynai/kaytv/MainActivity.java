package com.kaynai.kaytv;

import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    private NativeBridge nativeBridge;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Bridge bridge = getBridge();
        WebView webView = bridge == null ? null : bridge.getWebView();
        if (webView != null) {
            nativeBridge = new NativeBridge();
            webView.addJavascriptInterface(nativeBridge, "kaytvNative");
        }
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        Bridge bridge = getBridge();
        if (nativeBridge != null && nativeBridge.backHandled && bridge != null) {
            bridge.eval("window.dispatchEvent(new Event('kaytv:back'))", null);
            return;
        }
        super.onBackPressed();
    }

    /** H5 直接控制常亮与返回兜底，省掉一个外部插件 */
    public final class NativeBridge {

        private volatile boolean backHandled = false;

        @JavascriptInterface
        public void setBackHandled(boolean handled) {
            this.backHandled = handled;
        }

        @JavascriptInterface
        public void setKeepAwake(final boolean keep) {
            runOnUiThread(
                new Runnable() {
                    @Override
                    public void run() {
                        if (keep) {
                            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                        } else {
                            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                        }
                    }
                }
            );
        }

        @JavascriptInterface
        public void minimize() {
            runOnUiThread(
                new Runnable() {
                    @Override
                    public void run() {
                        moveTaskToBack(true);
                    }
                }
            );
        }
    }
}
