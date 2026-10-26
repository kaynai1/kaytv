package com.kaynai.kaytv;

import android.content.Context;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.res.Configuration;
import android.database.ContentObserver;
import android.media.AudioManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import java.util.Locale;

public class MainActivity extends BridgeActivity {

    private NativeBridge nativeBridge;
    private volatile boolean playerImmersive = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().getDecorView().setBackgroundColor(0xFF08090C);
        applyWindowInsets();
        drawUnderCutout();
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

    /** 挖孔/刘海屏横屏时让画面延伸到挖孔一侧，否则全屏左边会留一条系统灰边 */
    private void drawUnderCutout() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O_MR1) return;
        try {
            WindowManager.LayoutParams attrs = getWindow().getAttributes();
            attrs.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(attrs);
        } catch (Exception ignored) {
            /* 个别 ROM 不支持，保持默认 */
        }
    }

    /**
     * Capacitor 的 SystemBars 在旧 WebView 上会给 decor 加安全区 padding，横屏时挖孔一侧会留白。
     * 这里自己接管 insets：普通页面照旧让开系统栏，全屏播放时 padding 归零，画面一直铺到挖孔区。
     */
    private void applyWindowInsets() {
        View decor = getWindow().getDecorView();
        ViewCompat.setOnApplyWindowInsetsListener(
            decor,
            (view, insets) -> {
                Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
                Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
                boolean keyboard = insets.isVisible(WindowInsetsCompat.Type.ime());
                if (playerImmersive) {
                    view.setPadding(0, 0, 0, keyboard ? ime.bottom : 0);
                } else {
                    view.setPadding(bars.left, bars.top, bars.right, keyboard ? ime.bottom : bars.bottom);
                }
                applySafeAreaCss(bars);
                // 交给 WebView 处理会再缩一次，这里消费掉
                return new WindowInsetsCompat.Builder(insets)
                    .setInsets(
                        WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout(),
                        Insets.of(0, 0, 0, 0)
                    )
                    .build();
            }
        );
    }

    /** 播放器按钮条要按挖孔宽度避开摄像头，旧内核的 env() 不可靠，这里直接下发 CSS 变量 */
    private void applySafeAreaCss(Insets bars) {
        Bridge bridge = getBridge();
        WebView webView = bridge == null ? null : bridge.getWebView();
        if (webView == null) return;
        float density = getResources().getDisplayMetrics().density;
        if (density <= 0f) density = 1f;
        String script = String.format(
            Locale.US,
            "document.documentElement.style.setProperty('--kaytv-safe-top','%.2fpx');"
                + "document.documentElement.style.setProperty('--kaytv-safe-right','%.2fpx');"
                + "document.documentElement.style.setProperty('--kaytv-safe-bottom','%.2fpx');"
                + "document.documentElement.style.setProperty('--kaytv-safe-left','%.2fpx');",
            bars.top / density,
            bars.right / density,
            bars.bottom / density,
            bars.left / density
        );
        webView.evaluateJavascript(script, null);
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        // SystemBars 转屏时会用主题的 windowBackground 重刷 decor 底色，这里压回深色，避免边缘泛白
        getWindow().getDecorView().setBackgroundColor(0xFF08090C);
        getWindow().getDecorView().requestApplyInsets();
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

    /** 电视遥控器的播放/暂停/上下曲键 WebView 默认收不到，先转给 H5 播放器 */
    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0) {
            String action = mediaAction(event.getKeyCode());
            Bridge bridge = getBridge();
            if (action != null && bridge != null) {
                bridge.eval("window.dispatchEvent(new CustomEvent('kaytv:media',{detail:'" + action + "'}))", null);
                return true;
            }
        }
        return super.dispatchKeyEvent(event);
    }

    private String mediaAction(int keyCode) {
        switch (keyCode) {
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
            case KeyEvent.KEYCODE_HEADSETHOOK:
                return "play-pause";
            case KeyEvent.KEYCODE_MEDIA_PLAY:
                return "play";
            case KeyEvent.KEYCODE_MEDIA_PAUSE:
                return "pause";
            case KeyEvent.KEYCODE_MEDIA_NEXT:
                return "next";
            case KeyEvent.KEYCODE_MEDIA_PREVIOUS:
                return "previous";
            default:
                return null;
        }
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

        /** 全屏播放：隐藏系统栏并把窗口 padding 归零，让画面铺进挖孔区；退出时还原 */
        @JavascriptInterface
        public void setImmersive(final boolean enable) {
            runOnUiThread(
                new Runnable() {
                    @Override
                    public void run() {
                        playerImmersive = enable;
                        View decor = getWindow().getDecorView();
                        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(getWindow(), decor);
                        controller.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                        if (enable) {
                            controller.hide(WindowInsetsCompat.Type.systemBars());
                        } else {
                            controller.show(WindowInsetsCompat.Type.systemBars());
                        }
                        decor.requestApplyInsets();
                        decor.postDelayed(decor::requestApplyInsets, 300);
                    }
                }
            );
        }

        /** 只调本窗口的亮度：不需要 WRITE_SETTINGS 权限，退出播放后传 -1 交还系统 */
        @JavascriptInterface
        public void setWindowBrightness(final int percent) {
            runOnUiThread(
                new Runnable() {
                    @Override
                    public void run() {
                        try {
                            WindowManager.LayoutParams attrs = getWindow().getAttributes();
                            if (percent < 0) {
                                attrs.screenBrightness = -1f;
                            } else {
                                float value = percent / 100f;
                                if (value < 0.02f) value = 0.02f;
                                if (value > 1f) value = 1f;
                                attrs.screenBrightness = value;
                            }
                            getWindow().setAttributes(attrs);
                        } catch (Exception ignored) {
                            /* 窗口已销毁时忽略 */
                        }
                    }
                }
            );
        }

        /** 系统亮度作为播放内亮度条的起点；自动亮度或读不到时返回 -1，H5 从 100% 起算 */
        @JavascriptInterface
        public int getSystemBrightness() {
            try {
                int mode = Settings.System.getInt(getContentResolver(), Settings.System.SCREEN_BRIGHTNESS_MODE);
                if (mode == Settings.System.SCREEN_BRIGHTNESS_MODE_AUTOMATIC) return -1;
                int value = Settings.System.getInt(getContentResolver(), Settings.System.SCREEN_BRIGHTNESS);
                if (value < 0) return -1;
                return Math.max(0, Math.min(100, Math.round(value * 100f / 255f)));
            } catch (Exception ignored) {
                return -1;
            }
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
