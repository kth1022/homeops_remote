package com.homeops.remote;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.net.http.SslError;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;

public class MainActivity extends Activity {
    private static final String PRIMARY_URL = "https://kevin-pc.taile05f72.ts.net/";
    private static final String SERVE_HTTP_URL = "http://kevin-pc.taile05f72.ts.net:8080/";
    private static final String TAILSCALE_IP_URL = "http://100.97.88.6:8787/";
    private static final String LAN_URL = "http://192.168.1.86:8787/";

    /* Nocturne tokens, matching remote-app/app/styles.css */
    private static final int BG = Color.parseColor("#161826");
    private static final int SURFACE = Color.parseColor("#1C1E2C");
    private static final int EDGE = Color.parseColor("#3F424D");
    private static final int MUTED = Color.parseColor("#9397AB");
    private static final int MUTED_2 = Color.parseColor("#75798C");
    private static final int ACCENT = Color.parseColor("#9184D9");
    private static final int ACCENT_400 = Color.parseColor("#B5ABFC");
    private static final int ACCENT_TINT = Color.parseColor("#2B2741");

    private WebView webView;
    private TextView statusText;
    private LinearLayout toolbar;
    private String currentUrl = PRIMARY_URL;

    private final List<Button> endpointButtons = new ArrayList<>();
    private final List<String> endpointUrls = new ArrayList<>();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(BG);

        toolbar = new LinearLayout(this);
        toolbar.setOrientation(LinearLayout.HORIZONTAL);
        toolbar.setGravity(Gravity.CENTER_VERTICAL);
        toolbar.setBackgroundColor(BG);
        toolbar.setPadding(dp(8), dp(8), dp(8), dp(4));
        root.addView(toolbar, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));

        toolbar.addView(makeEndpointButton("HTTPS", PRIMARY_URL));
        toolbar.addView(makeEndpointButton("8080", SERVE_HTTP_URL));
        toolbar.addView(makeEndpointButton("100.x", TAILSCALE_IP_URL));
        toolbar.addView(makeEndpointButton("LAN", LAN_URL));

        Button reload = new Button(this);
        reload.setText("Reload");
        reload.setAllCaps(false);
        styleButton(reload, true);
        reload.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                webView.reload();
            }
        });
        LinearLayout.LayoutParams reloadParams = new LinearLayout.LayoutParams(
                0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        reloadParams.setMargins(dp(3), 0, dp(3), 0);
        toolbar.addView(reload, reloadParams);

        statusText = new TextView(this);
        statusText.setTextColor(MUTED_2);
        statusText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f);
        statusText.setText(PRIMARY_URL);
        statusText.setPadding(dp(12), 0, dp(12), dp(8));
        statusText.setSingleLine(true);
        statusText.setBackgroundColor(BG);
        root.addView(statusText, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));

        View hairline = new View(this);
        hairline.setBackgroundColor(EDGE);
        root.addView(hairline, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, Math.max(1, dp(1) / 2)));

        webView = new WebView(this);
        webView.setBackgroundColor(BG);
        configureWebView(webView);
        root.addView(webView, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                0,
                1f));

        setContentView(root);
        webView.loadUrl(currentUrl);
        markActiveEndpoint(currentUrl);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private Button makeEndpointButton(String label, final String url) {
        Button button = new Button(this);
        button.setText(label);
        button.setAllCaps(false);
        styleButton(button, false);
        button.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                currentUrl = url;
                statusText.setText(url);
                webView.loadUrl(url);
                markActiveEndpoint(url);
            }
        });
        endpointButtons.add(button);
        endpointUrls.add(url);

        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        params.setMargins(dp(3), 0, dp(3), 0);
        button.setLayoutParams(params);
        return button;
    }

    /* Outlined on transparent - the same treatment the web UI gives its buttons. */
    private void styleButton(Button button, boolean accented) {
        GradientDrawable shape = new GradientDrawable();
        shape.setShape(GradientDrawable.RECTANGLE);
        shape.setCornerRadius(dp(8));
        shape.setColor(accented ? ACCENT_TINT : Color.TRANSPARENT);
        shape.setStroke(Math.max(1, dp(1)), accented ? ACCENT : EDGE);
        button.setBackground(shape);
        button.setTextColor(accented ? ACCENT_400 : MUTED);
        button.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f);
        button.setMinHeight(dp(44));
        button.setMinimumHeight(dp(44));
        button.setMinWidth(0);
        button.setMinimumWidth(0);
        button.setPadding(dp(6), 0, dp(6), 0);
        button.setStateListAnimator(null);
    }

    private void markActiveEndpoint(String url) {
        String needle = url == null ? "" : url;
        for (int i = 0; i < endpointButtons.size(); i++) {
            boolean active = needle.startsWith(endpointUrls.get(i))
                    || endpointUrls.get(i).startsWith(needle);
            Button button = endpointButtons.get(i);
            LinearLayout.LayoutParams params = (LinearLayout.LayoutParams) button.getLayoutParams();
            styleButton(button, active);
            button.setLayoutParams(params);
        }
    }

    private void configureWebView(WebView view) {
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.LOLLIPOP) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        }
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            settings.setAlgorithmicDarkeningAllowed(true);
        }

        view.setWebChromeClient(new WebChromeClient());
        view.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                view.loadUrl(request.getUrl().toString());
                return true;
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                view.loadUrl(url);
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                super.onReceivedError(view, request, error);
                if (request == null || request.isForMainFrame()) {
                    statusText.setTextColor(Color.parseColor("#CF7A70"));
                    statusText.setText("Load failed. Try 8080, 100.x, or LAN.");
                }
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                statusText.setTextColor(Color.parseColor("#CF7A70"));
                statusText.setText("TLS error. Check Tailscale and MagicDNS.");
                handler.cancel();
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                currentUrl = url;
                statusText.setTextColor(MUTED_2);
                statusText.setText(url);
                markActiveEndpoint(url);
            }
        });
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
