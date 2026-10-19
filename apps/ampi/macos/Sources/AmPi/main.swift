import AppKit
import CryptoKit
import UserNotifications
import WebKit

// AmPi.app: one window onto the local AmPi hub (http://127.0.0.1:<port>/). The app starts the hub when none is
// listening, stops only the hub it started, and never stops nodes: agents keep working after the window closes.

let ampiHome = ProcessInfo.processInfo.environment["AMPI_HOME"].map { URL(fileURLWithPath: $0) }
	?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".ampi")
let hubLogURL = ampiHome.appendingPathComponent("hub.log")

/// A file in `<AMPI_HOME>` (default `~/.ampi`), trimmed; empty when missing.
func ampiFile(_ name: String) -> String {
	return (try? String(contentsOf: ampiHome.appendingPathComponent(name), encoding: .utf8))?
		.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
}

/// AMPI_HUB_PORT, else the port the last `ampi hub` used (`hub.port`), else 7878: the same order as `ampi open`.
let port = Int(ProcessInfo.processInfo.environment["AMPI_HUB_PORT"] ?? "") ?? Int(ampiFile("hub.port")) ?? 7878
let hubURL = URL(string: "http://127.0.0.1:\(port)/")!

/// The hub's access key (`<AMPI_HOME>/hub.token`, 0600). The first page load hands it to the hub, which keeps it in a cookie.
func hubToken() -> String { ampiFile("hub.token") }

/// The proof a real hub shows on /api/health: sha256("ampi-hub:" + key), first 32 hex digits.
func hubProof(_ token: String) -> String {
	let digest = SHA256.hash(data: Data("ampi-hub:\(token)".utf8))
	return String(digest.map { String(format: "%02x", $0) }.joined().prefix(32))
}

/// Opt-in launch trace in the hub's trace format (src/trace.ts): `AMPI_TRACE=<dir>` appends instants to
/// `<dir>/trace-<pid>-1.json`, timestamps in Unix-epoch microseconds, so the perf report merges the app with the hub.
enum AppTrace {
	static let file: URL? = ProcessInfo.processInfo.environment["AMPI_TRACE"].flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: $0) }
		.map { $0.appendingPathComponent("trace-\(getpid())-1.json") }
	static var enabled: Bool { file != nil }
	private static var written = false
	private static let lock = NSLock()

	static func nowUs() -> Int64 { Int64((Date().timeIntervalSince1970 * 1_000_000).rounded()) }

	/// The kernel's start time for this process: the earliest launch moment the app can see.
	static func processStartUs() -> Int64? {
		var info = kinfo_proc()
		var size = MemoryLayout<kinfo_proc>.stride
		var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
		guard sysctl(&mib, 4, &info, &size, nil, 0) == 0 else { return nil }
		let start = info.kp_proc.p_un.__p_starttime
		return Int64(start.tv_sec) * 1_000_000 + Int64(start.tv_usec)
	}

	static func instant(_ name: String, ts: Int64? = nil, args: [String: Any] = [:]) {
		var event: [String: Any] = ["pid": Int(getpid()), "tid": 1, "ph": "i", "s": "t", "name": name, "cat": "startup", "ts": ts ?? nowUs()]
		if !args.isEmpty { event["args"] = args }
		write(event)
	}

	static func write(_ event: [String: Any]) {
		guard let file, let json = try? JSONSerialization.data(withJSONObject: event) else { return }
		lock.lock(); defer { lock.unlock() }
		var chunk = Data((written ? "," : "[").utf8)
		chunk.append(json)
		chunk.append(Data("\n".utf8))
		if !written {
			try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
			FileManager.default.createFile(atPath: file.path, contents: nil)
		}
		guard let handle = try? FileHandle(forWritingTo: file) else { return }
		handle.seekToEndOfFile()
		handle.write(chunk)
		try? handle.close()
		written = true
	}

	/// Runs in the page at document start and reports first paint and the first painted Session row.
	static let pageScript = """
	(() => {
		const post = (name, startTime) => window.webkit.messageHandlers.ampi.postMessage({ type: "trace", name, ts: Math.round((performance.timeOrigin + startTime) * 1000), url: location.pathname });
		post("page-time-origin", 0);
		try { new PerformanceObserver((list) => { for (const e of list.getEntries()) post(e.name, e.startTime); }).observe({ type: "paint", buffered: true }); } catch {}
		const seen = () => document.querySelector("[data-thread], .row:not(.group-row)");
		const painted = () => requestAnimationFrame(() => setTimeout(() => post("first-session-row-painted", performance.now()), 0));
		if (seen()) { painted(); return; }
		const watch = new MutationObserver(() => { if (seen()) { watch.disconnect(); painted(); } });
		const start = () => watch.observe(document.documentElement, { childList: true, subtree: true });
		if (document.documentElement) start(); else document.addEventListener("DOMContentLoaded", start);
	})();
	"""
}

enum Health { case none, foreign, hub(proof: String) }

final class HubProcess {
	private(set) var process: Process?
	private(set) var lastError: String?
	private var logStart: UInt64 = 0

	var exitDescription: String? {
		guard let process, !process.isRunning else { return nil }
		return process.terminationReason == .uncaughtSignal
			? "Hub stopped by signal \(process.terminationStatus)"
			: "Hub exited with status \(process.terminationStatus)"
	}

	func logTail() -> String {
		guard let file = try? FileHandle(forReadingFrom: hubLogURL) else { return "" }
		defer { try? file.close() }
		let end = file.seekToEndOfFile()
		file.seek(toFileOffset: max(logStart, end > 4096 ? end - 4096 : 0))
		let text = String(decoding: file.readDataToEndOfFile(), as: UTF8.self)
		return text.split(separator: "\n", omittingEmptySubsequences: false).suffix(12).joined(separator: "\n")
	}

	/// Is a hub already answering on the port, and which key does it prove it holds?
	static func health() async -> Health {
		var request = URLRequest(url: hubURL.appendingPathComponent("api/health"))
		request.timeoutInterval = 1.5
		request.cachePolicy = .reloadIgnoringLocalCacheData
		// A health probe must not send a key left in the shared cookie store by an earlier hub.
		request.httpShouldHandleCookies = false
		guard let (data, response) = try? await URLSession.shared.data(for: request) else { return .none }
		guard (response as? HTTPURLResponse)?.statusCode == 200,
			let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
			let proof = body["proof"] as? String
		else { return .foreign }
		return .hub(proof: proof)
	}

	/// Start `ampi hub` through an interactive login shell, so the user's full PATH (Homebrew node, nvm, fnm,
	/// ~/.local/bin) applies. A plain login shell skips ~/.zshrc, and the hub's agents then fail with exit 127.
	func start() {
		guard process?.isRunning != true else { return }
		lastError = nil
		let command = ProcessInfo.processInfo.environment["AMPI_BIN"].map { "exec '\($0.replacingOccurrences(of: "'", with: "'\\''"))' hub --port \(port)" }
			?? "exec ampi hub --port \(port)"
		let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
		let process = Process()
		process.executableURL = URL(fileURLWithPath: shell)
		process.arguments = ["-ilc", command]
		try? FileManager.default.createDirectory(at: ampiHome, withIntermediateDirectories: true)
		// The log is owner-only, like hub.token: an older hub printed its access key into it.
		if !FileManager.default.fileExists(atPath: hubLogURL.path) {
			FileManager.default.createFile(atPath: hubLogURL.path, contents: nil, attributes: [.posixPermissions: 0o600])
		} else {
			try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: hubLogURL.path)
		}
		if let log = try? FileHandle(forWritingTo: hubLogURL) {
			logStart = log.seekToEndOfFile()
			process.standardOutput = log
			process.standardError = log
		}
		do {
			try process.run()
			self.process = process
		} catch {
			lastError = "Could not start `ampi hub`: \(error.localizedDescription)"
		}
	}

	func stop() {
		guard let process, process.isRunning else { return }
		process.terminate()
	}
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate, UNUserNotificationCenterDelegate {
	private var window: NSWindow!
	private var webView: WKWebView!
	private let hub = HubProcess()
	private var connection: Task<Void, Never>?

	func applicationDidFinishLaunching(_ notification: Notification) {
		if AppTrace.enabled {
			AppTrace.write(["pid": Int(getpid()), "tid": 1, "ph": "M", "name": "process_name", "args": ["name": "AmPi.app"]])
			if let start = AppTrace.processStartUs() { AppTrace.instant("app-process-start", ts: start) }
			AppTrace.instant("did-finish-launching")
		}
		buildMenu()
		let controller = WKUserContentController()
		controller.add(self, name: "ampi")
		if AppTrace.enabled {
			controller.addUserScript(WKUserScript(source: AppTrace.pageScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
		}
		let config = WKWebViewConfiguration()
		config.userContentController = controller
		config.preferences.setValue(true, forKey: "developerExtrasEnabled")
		webView = WKWebView(frame: .zero, configuration: config)
		webView.navigationDelegate = self
		webView.allowsBackForwardNavigationGestures = false
		window = NSWindow(
			contentRect: NSRect(x: 0, y: 0, width: 1360, height: 860),
			styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
			backing: .buffered,
			defer: false
		)
		window.title = "AmPi"
		window.titlebarAppearsTransparent = false
		window.contentView = webView
		window.setFrameAutosaveName("AmPiMain")
		if window.frame.origin == .zero { window.center() }
		window.makeKeyAndOrderFront(nil)
		if AppTrace.enabled {
			AppTrace.instant("window-ordered-front")
			DispatchQueue.main.async { AppTrace.instant("window-shown") }
		}
		UNUserNotificationCenter.current().delegate = self
		// A traced launch is a measurement run; it must not raise the system permission prompt.
		if !AppTrace.enabled {
			UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
		}
		showStatus("Starting AmPi…", detail: "Connecting to the hub on port \(port).")
		reconnect()
	}

	@MainActor private func reconnect() {
		connection?.cancel()
		connection = Task { await connect() }
	}

	@MainActor private func loadHub(_ health: Health) -> Bool {
		if case .none = health { return false }
		let token = hubToken()
		// Hand the key only to the hub that proves it holds the same key.
		if case .hub(let proof) = health, !token.isEmpty, proof == hubProof(token) {
			if AppTrace.enabled { AppTrace.instant("hub-page-load-start") }
			webView.load(URLRequest(url: URL(string: "http://127.0.0.1:\(port)/?k=\(token)")!))
		} else {
			showStatus("Port \(port) is not this AmPi hub", detail: "Another server answers on 127.0.0.1:\(port) without the key in \(ampiHome.appendingPathComponent("hub.token").path). Stop that server, or set AMPI_HUB_PORT, then choose View › Reload. Log: \(hubLogURL.path)")
		}
		return true
	}

	@MainActor private func connect() async {
		let initial = await HubProcess.health()
		guard !Task.isCancelled else { return }
		if loadHub(initial) { return }
		hub.start()
		if let error = hub.lastError {
			showStatus("Could not start the hub", detail: "\(error) Check SHELL and AMPI_BIN, then choose View › Reload. Log: \(hubLogURL.path)")
			return
		}
		let start = Date()
		var displayedSecond = -1
		while !Task.isCancelled {
			if let exit = hub.exitDescription {
				let advice = hub.process?.terminationStatus == 127
					? "Check the hub command, AMPI_BIN, and your shell's PATH."
					: "Check the log, then choose View › Reload to try again."
				showStatus(exit, detail: "\(advice)\nLog: \(hubLogURL.path)\n\(hub.logTail())")
				return
			}
			let seconds = Int(Date().timeIntervalSince(start))
			if seconds >= 180 {
				showStatus("The hub is still starting after \(seconds) s", detail: "The process is still running. Check \(hubLogURL.path), then choose View › Reload to wait again.")
				return
			}
			if displayedSecond != seconds {
				displayedSecond = seconds
				showStatus("Starting the hub… \(seconds) s", detail: "Waiting for 127.0.0.1:\(port). Log: \(hubLogURL.path)")
			}
			let health = await HubProcess.health()
			guard !Task.isCancelled else { return }
			if loadHub(health) { return }
			try? await Task.sleep(nanoseconds: 250_000_000)
		}
	}

	private func showStatus(_ title: String, detail: String) {
		let html = """
		<html><body style="font: 14px -apple-system; color: #444; display: flex; height: 100vh; margin: 0; align-items: center; justify-content: center; background: #fafaf9">
		<div style="max-width: 640px; overflow-wrap: anywhere"><h2 style="font-weight: 600">\(escapeHTML(title))</h2><p style="white-space: pre-wrap">\(escapeHTML(detail))</p></div></body></html>
		"""
		webView.loadHTMLString(html, baseURL: nil)
	}

	private func escapeHTML(_ text: String) -> String {
		text.replacingOccurrences(of: "&", with: "&amp;")
			.replacingOccurrences(of: "<", with: "&lt;")
			.replacingOccurrences(of: ">", with: "&gt;")
	}

	// The web app's bridge: notifications and the Dock badge (see web/src/attention.ts).
	func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
		guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
		switch type {
		case "trace":
			guard AppTrace.enabled, let name = body["name"] as? String, let ts = (body["ts"] as? NSNumber)?.int64Value else { return }
			AppTrace.instant(name, ts: ts, args: ["url": body["url"] as? String ?? ""])
		case "notify":
			let content = UNMutableNotificationContent()
			content.title = body["title"] as? String ?? "AmPi"
			content.body = body["body"] as? String ?? ""
			content.sound = .default
			if let route = body["route"] as? String { content.userInfo = ["route": route] }
			let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
			UNUserNotificationCenter.current().add(request)
		case "badge":
			let count = body["count"] as? Int ?? 0
			NSApp.dockTile.badgeLabel = count > 0 ? String(count) : nil
		default:
			break
		}
	}

	// Clicking a notification opens its thread.
	func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
		if let route = response.notification.request.content.userInfo["route"] as? String {
			NSApp.activate(ignoringOtherApps: true)
			window.makeKeyAndOrderFront(nil)
			let escaped = route.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "'", with: "\\'")
			webView.evaluateJavaScript("window.ampiOpen && window.ampiOpen('\(escaped)')")
		}
		completionHandler()
	}

	func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
		completionHandler([.banner, .sound])
	}

	// Links that leave the hub open in the default browser.
	func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
		if let url = navigationAction.request.url, navigationAction.navigationType == .linkActivated, url.host != "127.0.0.1" {
			NSWorkspace.shared.open(url)
			decisionHandler(.cancel)
			return
		}
		decisionHandler(.allow)
	}

	func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

	func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
		if !flag { window.makeKeyAndOrderFront(nil) }
		return true
	}

	func applicationWillTerminate(_ notification: Notification) {
		hub.stop()
	}

	@objc func reload(_ sender: Any?) {
		reconnect()
	}

	private func buildMenu() {
		let main = NSMenu()
		let appItem = NSMenuItem()
		let appMenu = NSMenu()
		appMenu.addItem(withTitle: "About AmPi", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
		appMenu.addItem(.separator())
		appMenu.addItem(withTitle: "Hide AmPi", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
		appMenu.addItem(withTitle: "Quit AmPi", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
		appItem.submenu = appMenu
		main.addItem(appItem)
		// Standard editing so copy and paste work in the web view. ⌘N, ⌘K, ⌘J, and ⌘0 stay with the web app.
		let editItem = NSMenuItem()
		let edit = NSMenu(title: "Edit")
		edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
		edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
		edit.addItem(.separator())
		edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
		edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
		edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
		edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
		editItem.submenu = edit
		main.addItem(editItem)
		let viewItem = NSMenuItem()
		let view = NSMenu(title: "View")
		view.addItem(withTitle: "Reload", action: #selector(reload(_:)), keyEquivalent: "r")
		view.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f").keyEquivalentModifierMask = [.command, .control]
		viewItem.submenu = view
		main.addItem(viewItem)
		let windowItem = NSMenuItem()
		let windowMenu = NSMenu(title: "Window")
		windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
		windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
		windowItem.submenu = windowMenu
		main.addItem(windowItem)
		NSApp.mainMenu = main
		NSApp.windowsMenu = windowMenu
	}
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
