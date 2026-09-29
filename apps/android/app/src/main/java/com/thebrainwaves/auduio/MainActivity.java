package com.thebrainwaves.auduio;

import android.media.AudioManager;
import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.WebSettings;

import com.getcapacitor.BridgeActivity;

/**
 * Auduio runs entirely in the WebView (Web Audio). Microphone access: the page calls getUserMedia,
 * Capacitor's BridgeWebChromeClient.onPermissionRequest asks for the RECORD_AUDIO runtime permission
 * and then grants the WebView request.
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WebSettings settings = getBridge().getWebView().getSettings();
        // clips, previews and the metronome start from taps inside the app; don't block them
        settings.setMediaPlaybackRequiresUserGesture(false);
        // hardware volume keys control playback volume, not the ringer
        setVolumeControlStream(AudioManager.STREAM_MUSIC);
        // Android pauses the WebView (and a running recording) when the screen turns off:
        // keep the screen on while Auduio is in front.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }
}
