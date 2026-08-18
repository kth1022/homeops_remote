package com.homeops.remote;

import android.app.Activity;
import android.graphics.Color;
import android.net.http.SslError;
import android.os.Bundle;
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

public class MainActivity extends Activity {
    private static final String PRIMARY_URL = "https://kevin-pc.taile05f72.ts.net/";
    private static final String SERVE_HTTP_URL = "http://kevin-pc.taile05f72.ts.net:8080/";
    private static final String TAILSCALE_IP_URL = "http://100.97.88.6:8787/";
    private static final String LAN_URL = "http://192.168.1.86:8787/";

    private WebView webView;
    private TextView statusText;
    private String currentUrl = PRIMARY_URL;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.rgb(245, 247, 251));

        LinearLayout toolbar = new LinearLayout(this);
        toolbar.setOrientation(LinearLayout.HORIZONTAL);
        toolbar.setGravity(Gravity.CENTER_VERTICAL);
        toolbar.setPadding(8, 8, 8, 8);
        toolbar.setBackgroundColor(Color.rgb(17, 24, 39));
        root.addView(toolbar, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));

        toolbar.addView(makeButton("HTTPS", PRIMARY_URL));
        toolbar.addView(makeButton("8080", SERVE_HTTP_URL));
        toolbar.addView(makeButton("100.x", TAILSCALE_IP_URL));
        toolbar.addView(makeButton("LAN", LAN_URL));

        Button reload = new Button(this);
        reload.setText("Reload");
        reload.setAllCaps(false);
        reload.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                webView.reload();
            }
        });
        toolbar.addView(reload, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

        statusText = new TextView(this);
        statusText.setTextColor(Color.rgb(203, 213, 225));
        statusText.setText(PRIMARY_URL);
        statusText.setPadding(12, 4, 12, 8);
        statusText.setSingleLine(true);
        statusText.setBackgroundColor(Color.rgb(17, 24, 39));
        root.addView(statusText, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));

        webView = new WebView(this);
        configureWebView(webView);
        root.addView(webView, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                0,
                1f));

        setContentView(root);
        webView.loadUrl(currentUrl);
    }

    private Button makeButton(String label, final String url) {
        Button button = new Button(this);
        button.setText(label);
        button.setAllCaps(false);
        button.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                currentUrl = url;
                statusText.setText(url);
                webView.loadUrl(url);
            }
        });
        toolbarButtonStyle(button);
        return button;
    }

    private void toolbarButtonStyle(Button button) {
        button.setTextColor(Color.rgb(31, 41, 55));
        button.setMinHeight(42);
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
                    statusText.setText("Load failed. Try 8080, 100.x, or LAN.");
                }
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                statusText.setText("TLS error. Check Tailscale and MagicDNS.");
                handler.cancel();
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                currentUrl = url;
                statusText.setText(url);
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
