import SwiftUI
import WebKit

/// WKWebView 封装：注入 JS 捕获运行时错误（window.onerror / console.error / 资源加载失败）
struct WebView: UIViewRepresentable {
    let url: URL
    let onRuntimeError: (String) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onRuntimeError: onRuntimeError)
    }

    func makeUIView(context: Context) -> WKWebView {
        let userContentController = WKUserContentController()
        userContentController.add(context.coordinator, name: "pagemake")
        userContentController.addUserScript(Self.runtimeErrorScript)

        let configuration = WKWebViewConfiguration()
        configuration.userContentController = userContentController

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        if webView.url != url {
            webView.load(URLRequest(url: url))
        }
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "pagemake")
    }

    /// 运行时错误捕获脚本（atDocumentStart 注入）
    static let runtimeErrorScript = WKUserScript(source: """
    (function () {
      function post(msg) {
        try { window.webkit.messageHandlers.pagemake.postMessage(msg); } catch (e) {}
      }
      window.onerror = function (message, source, lineno, colno, error) {
        post({ type: 'error', message: String(message), source: source ? String(source) : '', line: lineno });
        return false;
      };
      var originalConsoleError = console.error;
      console.error = function () {
        var args = Array.prototype.slice.call(arguments).map(function (a) {
          try { return String(a); } catch (e) { return '[unserializable]'; }
        }).join(' ');
        post({ type: 'console', level: 'error', message: args });
        originalConsoleError.apply(console, arguments);
      };
      document.addEventListener('error', function (event) {
        var target = event.target;
        if (target && (target.tagName === 'IMG' || target.tagName === 'SCRIPT' ||
                       target.tagName === 'LINK' || target.tagName === 'AUDIO' ||
                       target.tagName === 'VIDEO' || target.tagName === 'SOURCE')) {
          post({
            type: 'resource',
            message: 'Failed to load resource: ' + (target.src || target.href ||
                     target.getAttribute('src') || target.getAttribute('href') || 'unknown'),
            tag: target.tagName
          });
        }
      }, true);
    })();
    """, injectionTime: .atDocumentStart, forMainFrameOnly: false)

    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        var onRuntimeError: (String) -> Void

        init(onRuntimeError: @escaping (String) -> Void) {
            self.onRuntimeError = onRuntimeError
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "pagemake",
                  let dict = message.body as? [String: Any],
                  let type = dict["type"] as? String else { return }

            switch type {
            case "error":
                let line = dict["line"] as? Int ?? 0
                let text = String(format: NSLocalizedString("runtime_js_error", comment: ""),
                                  dict["message"] as? String ?? "", line)
                onRuntimeError(text)
            case "console":
                onRuntimeError("console.error：" + (dict["message"] as? String ?? ""))
            case "resource":
                onRuntimeError(dict["message"] as? String ?? "")
            default:
                break
            }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            onRuntimeError("Navigation failed: \(error.localizedDescription)")
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            onRuntimeError("Navigation failed: \(error.localizedDescription)")
        }
    }
}
