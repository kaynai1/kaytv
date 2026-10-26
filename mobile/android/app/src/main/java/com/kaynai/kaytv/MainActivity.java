package com.kaynai.kaytv;

import android.content.Context;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.database.ContentObserver;
import android.media.AudioManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
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
        if (nativeBridge != null) {
            nativeBridge.observeSystemVolume();
        }
    }

    @Override
    public void onDestroy() {
        if (nativeBridge != null) {
            nativeBridge.stopObserving();
        }
        super.onDestroy();
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

    /** H5 直接控制常亮、系统音量、投屏面板与返回兜底，省掉外部插件 */
    public final class NativeBridge {

        private volatile boolean backHandled = false;
        private ContentObserver volumeObserver;

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

        /** 全屏播放时由 H5 调 Activity 级方向锁，WebView 的 screen.orientation.lock 在安卓上不可靠 */
        @JavascriptInterface
        public void setOrientation(final String value) {
            runOnUiThread(
                new Runnable() {
                    @Override
                    public void run() {
                        int target;
                        if ("landscape".equals(value)) {
                            target = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE;
                        } else if ("portrait".equals(value)) {
                            target = ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT;
                        } else {
                            target = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;
                        }
                        try {
                            setRequestedOrientation(target);
                        } catch (Exception ignored) {
                            /* 个别 ROM 会拒绝，保持当前方向 */
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

        /* ---------- 系统媒体音量：让应用内音量条和音量键是同一个东西 ---------- */

        private AudioManager audio() {
            return (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        }

        @JavascriptInterface
        public int getSystemVolume() {
            AudioManager manager = audio();
            if (manager == null) return -1;
            int max = manager.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
            if (max <= 0) return -1;
            return (int) Math.round(manager.getStreamVolume(AudioManager.STREAM_MUSIC) * 100f / max);
        }

        @JavascriptInterface
        public void setSystemVolume(final int percent) {
            runOnUiThread(
                new Runnable() {
                    @Override
                    public void run() {
                        AudioManager manager = audio();
                        if (manager == null) return;
                        int max = manager.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
                        if (max <= 0) return;
                        int clamped = percent < 0 ? 0 : (percent > 100 ? 100 : percent);
                        int target = (int) Math.round(clamped * max / 100f);
                        if (target == manager.getStreamVolume(AudioManager.STREAM_MUSIC)) return;
                        try {
                            manager.setStreamVolume(AudioManager.STREAM_MUSIC, target, 0);
                        } catch (SecurityException ignored) {
                            /* 个别定制 ROM 会拦，忽略即可，音量条退回软件音量 */
                        }
                    }
                }
            );
        }

        /** 按音量键、通知栏滑块改音量时回推给 H5 */
        void observeSystemVolume() {
            Handler handler = new Handler(Looper.getMainLooper());
            volumeObserver =
                new ContentObserver(handler) {
                    @Override
                    public void onChange(boolean selfChange) {
                        reportSystemVolume();
                    }
                };
            try {
                getContentResolver().registerContentObserver(Settings.System.CONTENT_URI, true, volumeObserver);
            } catch (Exception ignored) {
                volumeObserver = null;
            }
            reportSystemVolume();
        }

        void stopObserving() {
            if (volumeObserver == null) return;
            try {
                getContentResolver().unregisterContentObserver(volumeObserver);
            } catch (Exception ignored) {
                /* ignore */
            }
            volumeObserver = null;
        }

        private void reportSystemVolume() {
            final int percent = getSystemVolume();
            if (percent < 0) return;
            runOnUiThread(
                new Runnable() {
                    @Override
                    public void run() {
                        WebView view = getBridge() == null ? null : getBridge().getWebView();
                        if (view == null) return;
                        view.evaluateJavascript(
                            "window.dispatchEvent(new CustomEvent('kaytv:volume',{detail:" + percent + "}))",
                            null
                        );
                    }
                }
            );
        }

        /* ---------- 投屏：拉起系统的无线投屏 / 多屏互动面板 ---------- */

        @JavascriptInterface
        public boolean openCastPanel() {
            String[] actions = new String[] {
                "android.settings.panel.action.WIFI_DISPLAY",
                "android.settings.DISPLAY_CASTING_SETTINGS",
                "android.settings.WIFI_DISPLAY_SETTINGS"
            };
            for (String action : actions) {
                if (startPanel(action)) return true;
            }
            return false;
        }

        private boolean startPanel(String action) {
            Intent intent = new Intent(action);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try {
                startActivity(intent);
                return true;
            } catch (Exception ignored) {
                return false;
            }
        }
    }
}
