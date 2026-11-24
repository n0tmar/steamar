// SteaMar, the native shell: one window, WebView2 pointed at a virtual host backed by ui/,
// and every /api or /img request answered by api.cpp instead of a local HTTP server.
#include <windows.h>

#include <dwmapi.h>
#include <shellapi.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <shlwapi.h>
#include <wrl.h>
#include <WebView2.h>
#include <WebView2EnvironmentOptions.h>

#include <atomic>
#include <cstdio>
#include <string>
#include <thread>
#include <vector>

#include "api.h"
#include "core.h"
#include "json.h"
#include "net.h"

using Microsoft::WRL::Callback;
using Microsoft::WRL::ComPtr;

namespace {

constexpr wchar_t kClass[] = L"SteaMarMainWindow";
constexpr wchar_t kTitle[] = L"SteaMar";
// The page's origin. This name is mapped straight to ui/ on disk and never resolves on the network,
// so it costs nothing to be the domain the product actually lives on.
constexpr wchar_t kHost[] = L"steamar.cc";
constexpr int kPort = 8788;
constexpr UINT kReplyReady = WM_APP + 1;
constexpr UINT kZoom = WM_APP + 3;
constexpr UINT kPick = WM_APP + 4;
constexpr UINT_PTR kShotTimer = 1;
constexpr UINT_PTR kShotDeadline = 2;
// One size, no resize handle. Every layout in ui/ is drawn for this width, and a tool window the
// user cannot stretch keeps its proportions instead of drifting. Text size is the one thing that
// changes how much of it you see.
constexpr int kWidth = 1180;
constexpr int kHeight = 760;
constexpr int kZoomMin = 100;
constexpr int kZoomMax = 130;
// Large is the size a fresh copy opens at: the window is 1180x760 on purpose, and at 100% the
// shelves and the status bar read small on a 1440p display.
constexpr int kZoomDefault = 115;

HWND g_window = nullptr;
ComPtr<ICoreWebView2Environment> g_env;
ComPtr<ICoreWebView2Controller> g_controller;
ComPtr<ICoreWebView2> g_webview;

std::wstring g_ui_dir;
std::wstring g_shot_file;
std::wstring g_route;
int g_shot_wait = 1600;
std::atomic<bool> g_engine_ready{false};
std::atomic<bool> g_first_request{false};
bool g_devtools = false;
std::uint64_t g_started = 0;
HANDLE g_engine_job = nullptr;
int g_zoom = kZoomDefault;
// The size the window is meant to have in logical pixels, so a monitor change keeps it the same
// apparent size instead of shrinking or doubling.
int g_logical_width = kWidth;
int g_logical_height = kHeight;

struct Pending {
  long long id = 0;
  api::Response response;
};

/* ---------- window geometry, remembered between runs ---------- */

std::wstring state_file() { return core::join(core::join(core::project_root(), L"out"), L"window.ini"); }

// Only the position is remembered now: the size is a constant, and a stale 1400x900 in window.ini
// from an older build must not make the window open at a size it can no longer have.
void load_position(int width, int height, int& x, int& y) {
  const std::wstring file = state_file();
  int left = static_cast<int>(GetPrivateProfileIntW(L"window", L"x", 0, file.c_str()));
  int top = static_cast<int>(GetPrivateProfileIntW(L"window", L"y", 0, file.c_str()));
  if (left == 0 && top == 0) {
    RECT work{};
    SystemParametersInfoW(SPI_GETWORKAREA, 0, &work, 0);
    left = work.left + ((work.right - work.left) - width) / 2;
    top = work.top + ((work.bottom - work.top) - height) / 2;
  }
  x = left;
  y = top;
}

void save_position() {
  if (!g_window || IsIconic(g_window) || IsZoomed(g_window)) return;
  RECT rect{};
  if (!GetWindowRect(g_window, &rect)) return;
  const std::wstring file = state_file();
  const std::wstring x = std::to_wstring(rect.left);
  const std::wstring y = std::to_wstring(rect.top);
  WritePrivateProfileStringW(L"window", L"x", x.c_str(), file.c_str());
  WritePrivateProfileStringW(L"window", L"y", y.c_str(), file.c_str());
  // Older builds stored a size here; the window is fixed now, so drop the stale keys instead of
  // leaving a number in the file that nothing reads.
  WritePrivateProfileStringW(L"window", L"w", nullptr, file.c_str());
  WritePrivateProfileStringW(L"window", L"h", nullptr, file.c_str());
}

/* ---------- text size ---------- */

// WebView2 scales the whole page, so type, controls, art and spacing grow together and stay sharp.
// The alternative - fatter CSS - would mean a second layout for every value in style.css.
void load_zoom() {
  const UINT stored = GetPrivateProfileIntW(L"window", L"zoom", kZoomDefault, state_file().c_str());
  const int value = static_cast<int>(stored);
  g_zoom = value < kZoomMin ? kZoomMin : (value > kZoomMax ? kZoomMax : value);
  if (g_zoom != kZoomDefault) core::log("zoom: restored " + std::to_string(g_zoom) + "%");
}

// The controller is apartment-threaded, so this only ever runs on the UI thread. A route calls
// zoom_blocking() below, which hands the number over and waits for the answer.
int apply_zoom(int percent) {
  const int value = percent < kZoomMin ? kZoomMin : (percent > kZoomMax ? kZoomMax : percent);
  g_zoom = value;
  const HRESULT hr = g_controller ? g_controller->put_ZoomFactor(value / 100.0) : E_POINTER;
  const std::wstring text = std::to_wstring(value);
  WritePrivateProfileStringW(L"window", L"zoom", text.c_str(), state_file().c_str());
  core::log("zoom: " + std::to_string(value) + "% hr " + std::to_string(static_cast<long>(hr)));
  return value;
}

struct ZoomRequest {
  int percent = kZoomMin;
  HANDLE done = nullptr;
  int applied = kZoomMin;
};

int zoom_blocking(int percent) {
  ZoomRequest request{percent, CreateEventW(nullptr, TRUE, FALSE, nullptr), g_zoom};
  if (!request.done) return g_zoom;
  if (!PostMessageW(g_window, kZoom, 0, reinterpret_cast<LPARAM>(&request))) {
    core::log("zoom: cannot reach the window");
    CloseHandle(request.done);
    return g_zoom;
  }
  if (WaitForSingleObject(request.done, 5000) != WAIT_OBJECT_0) core::log("zoom: timed out");
  CloseHandle(request.done);
  return request.applied;
}

/* ---------- folder picker ---------- */

// The Settings rows ask for a folder, so the dialog opens on the folder that row already points at
// instead of on whatever Windows happens to remember from last time. It runs here, on the window
// thread: that is the apartment the shell dialog needs, and the owner window keeps it in front.
std::wstring show_folder_picker(const std::wstring& title, const std::wstring& start) {
  ComPtr<IFileOpenDialog> dialog;
  if (FAILED(CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dialog)))) {
    core::log("picker: cannot create the folder dialog");
    return {};
  }

  DWORD options = 0;
  dialog->GetOptions(&options);
  dialog->SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
  if (!title.empty()) dialog->SetTitle(title.c_str());

  ComPtr<IFileDialog> plain;
  if (SUCCEEDED(dialog.As(&plain))) plain->SetOkButtonLabel(L"Use this folder");

  if (!start.empty()) {
    ComPtr<IShellItem> folder;
    if (SUCCEEDED(SHCreateItemFromParsingName(start.c_str(), nullptr, IID_PPV_ARGS(&folder)))) {
      // SetFolder is where it opens now; SetDefaultFolder is where it opens next time, even after
      // the person browsed somewhere else and pressed cancel.
      dialog->SetFolder(folder.Get());
      dialog->SetDefaultFolder(folder.Get());
    }
  }

  SetForegroundWindow(g_window);
  core::log("picker: opening '" + core::narrow(title) + "' in " + core::narrow(start));
  const HRESULT shown = dialog->Show(g_window);
  if (FAILED(shown)) {
    core::log("picker: closed without a folder, hr " + std::to_string(static_cast<long>(shown)));
    return {};
  }

  ComPtr<IShellItem> picked;
  PWSTR raw = nullptr;
  std::wstring path;
  if (SUCCEEDED(dialog->GetResult(&picked)) && SUCCEEDED(picked->GetDisplayName(SIGDN_FILESYSPATH, &raw)) && raw) {
    path = raw;
    CoTaskMemFree(raw);
  }
  core::log("picker: opened in " + core::narrow(start) + ", chose " + core::narrow(path));
  return path;
}

struct PickRequest {
  std::wstring title;
  std::wstring start;
  std::wstring picked;
  HANDLE done = nullptr;
};

// Routes run on worker threads, which have no apartment and no message pump, so a dialog created
// there is not owned by the window and can open behind it. Hand the request to the window thread
// and wait, the same way the zoom change does.
std::wstring pick_blocking(const std::wstring& title, const std::wstring& start) {
  auto* request = new PickRequest{title, start, {}, CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  if (!request->done) {
    delete request;
    return {};
  }
  if (!PostMessageW(g_window, kPick, 0, reinterpret_cast<LPARAM>(request))) {
    core::log("picker: cannot reach the window");
    CloseHandle(request->done);
    delete request;
    return {};
  }
  // Browsing can take a while. If the window goes away first the answer never arrives, and the
  // request is left allocated rather than freeing memory the window thread may still be holding.
  std::wstring picked;
  if (WaitForSingleObject(request->done, 60 * 60 * 1000) == WAIT_OBJECT_0) {
    picked = request->picked;
    CloseHandle(request->done);
    delete request;
  } else {
    core::log("picker: no answer for an hour");
  }
  return picked;
}

/* ---------- engine ---------- */

// The engine still owns the catalogue. It is started here, kept in a job object so it dies with
// the window, and probed until it answers before the first paint asks it anything.
enum class EngineState { ready, absent, conflict };

// An engine is only reusable when it belongs to this copy. Any listener would answer the port, and
// a second SteaMar (another folder, or one on a stick) would then install into the wrong Steam
// folder while its window showed the result as its own. Runs on the UI thread, before the webview.
EngineState probe_engine() {
  // Nothing listening is the usual start, and asking over HTTP first made every start two seconds slower.
  if (!net::listening(kPort)) return EngineState::absent;
  const std::wstring base = L"http://127.0.0.1:" + std::to_wstring(kPort);
  const net::Result probe = net::get(base + L"/api/status", 800);
  if (!probe.ok) return EngineState::absent;

  std::string needle = "\"root\":\"";
  for (const char c : core::narrow(core::project_root())) {
    if (c == '\\' || c == '"') needle += '\\';
    needle += c;
  }
  needle += '"';
  if (probe.body.find(needle) != std::string::npos) {
    core::log("engine: already running on " + std::to_string(kPort));
    g_engine_ready = true;
    return EngineState::ready;
  }

  core::log("engine: port " + std::to_string(kPort) + " belongs to another copy");
  MessageBoxW(g_window,
              L"Another copy of SteaMar is already running.\n\nClose it, then start this one again.",
              kTitle, MB_ICONWARNING | MB_OK | MB_SETFOREGROUND);
  return EngineState::conflict;
}

void start_engine() {
  wchar_t from_env[1024]{};
  // A portable copy carries its own runtime, so the machine it lands on needs nothing installed.
  const std::wstring bundled = core::join(core::project_root(), L"runtime\\node.exe");
  std::wstring exe = core::exists(bundled) ? bundled : L"node.exe";
  if (GetEnvironmentVariableW(L"STEAMAR_ENGINE", from_env, static_cast<DWORD>(std::size(from_env)))) exe = from_env;
  if (exe != L"node.exe") core::log("engine: runtime " + core::narrow(exe));

  const std::wstring script = core::join(core::join(core::project_root(), L"src"), L"server.js");
  std::wstring command = L"\"" + exe + L"\" \"" + script + L"\"";

  STARTUPINFOW startup{};
  startup.cb = sizeof startup;
  PROCESS_INFORMATION info{};
  const BOOL launched = CreateProcessW(nullptr, command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW,
                                       nullptr, core::project_root().c_str(), &startup, &info);
  if (!launched) {
    core::log("engine: could not start " + core::narrow(exe) + " (" + std::to_string(GetLastError()) + ")");
    return;
  }

  g_engine_job = CreateJobObjectW(nullptr, nullptr);
  if (g_engine_job) {
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limit{};
    limit.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    SetInformationJobObject(g_engine_job, JobObjectExtendedLimitInformation, &limit, sizeof limit);
    AssignProcessToJobObject(g_engine_job, info.hProcess);
  }
  CloseHandle(info.hThread);
  CloseHandle(info.hProcess);
  core::log("engine: started pid " + std::to_string(info.dwProcessId));

  for (int i = 0; i < 120; ++i) {
    if (net::alive(L"http://127.0.0.1:" + std::to_wstring(kPort) + L"/api/status", 400)) {
      g_engine_ready = true;
      core::log("engine: answering after " + std::to_string(i * 50) + " ms");
      return;
    }
    Sleep(50);
  }
  core::log("engine: did not answer in 6 s");
}

/* ---------- webview ---------- */

// The page talks to us with postMessage: {id, path, method, body}. It is answered on a worker
// thread and posted back as {id, status, text}, so a slow request never holds up the UI thread.
HRESULT on_message(ICoreWebView2* /*sender*/, ICoreWebView2WebMessageReceivedEventArgs* args) {
  LPWSTR raw = nullptr;
  if (FAILED(args->get_WebMessageAsJson(&raw)) || !raw) return S_OK;
  const std::string text = core::narrow(raw);
  CoTaskMemFree(raw);

  json::Value message;
  if (!json::Value::parse(text, message)) {
    core::log("bridge: unreadable message");
    return S_OK;
  }

  api::Request request;
  request.path = message["path"].as_string();
  request.method = message["method"].as_string();
  request.body = message["body"].as_string();
  if (request.method.empty()) request.method = "GET";
  const long long id = message["id"].as_int();
  if (request.path.empty()) {
    core::log("bridge: a message arrived without a path");
    return S_OK;
  }

  if (!g_first_request.exchange(true)) {
    core::log("page: first call " + request.path + " after " + std::to_string(core::now_ms() - g_started) + " ms");
  }

  auto* pending = new Pending{id, {}};
  try {
    std::thread([pending, request]() {
      try {
        pending->response = api::handle(request);
      } catch (...) {
        pending->response.status = 500;
        pending->response.body = "{\"error\":\"the app hit an error\"}";
      }
      if (!PostMessageW(g_window, kReplyReady, 0, reinterpret_cast<LPARAM>(pending))) {
        core::log("bridge: cannot return " + request.path);
        delete pending;
      }
    }).detach();
  } catch (const std::exception& error) {
    core::log("bridge: cannot start a worker for " + request.path + ": " + error.what());
    delete pending;
  }
  return S_OK;
}

void capture(const std::wstring& file) {
  if (!g_webview) {
    PostQuitMessage(0);
    return;
  }
  ComPtr<IStream> stream;
  const HRESULT opened = SHCreateStreamOnFileEx(file.c_str(), STGM_CREATE | STGM_WRITE | STGM_SHARE_EXCLUSIVE,
                                                FILE_ATTRIBUTE_NORMAL, TRUE, nullptr, &stream);
  if (FAILED(opened)) {
    core::log("shot: cannot write " + core::narrow(file));
    PostQuitMessage(1);
    return;
  }
  g_webview->CapturePreview(
      COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG, stream.Get(),
      Callback<ICoreWebView2CapturePreviewCompletedHandler>(
          [](HRESULT) -> HRESULT {
            core::log("shot: written");
            PostMessageW(g_window, WM_CLOSE, 0, 0);
            return S_OK;
          })
          .Get());
}

void setup_webview() {
  RECT bounds{};
  GetClientRect(g_window, &bounds);
  g_controller->put_Bounds(bounds);
  // Applied before the first navigation, so the page is already at the chosen size when it paints.
  // WebView2 starts at 100%, so 100 is the one value that needs no call.
  if (g_zoom != kZoomMin) g_controller->put_ZoomFactor(g_zoom / 100.0);

  ComPtr<ICoreWebView2Controller2> controller2;
  if (SUCCEEDED(g_controller.As(&controller2))) {
    const COREWEBVIEW2_COLOR background{255, 9, 10, 13};  // --window, so no white flash on resize
    controller2->put_DefaultBackgroundColor(background);
  }

  ComPtr<ICoreWebView2Settings> settings;
  if (SUCCEEDED(g_webview->get_Settings(&settings)) && settings) {
    settings->put_AreDefaultContextMenusEnabled(FALSE);
    settings->put_AreDevToolsEnabled(g_devtools ? TRUE : FALSE);
    settings->put_IsStatusBarEnabled(FALSE);
    settings->put_IsZoomControlEnabled(FALSE);
    settings->put_IsBuiltInErrorPageEnabled(FALSE);
    ComPtr<ICoreWebView2Settings3> settings3;
    if (SUCCEEDED(settings.As(&settings3))) settings3->put_AreBrowserAcceleratorKeysEnabled(FALSE);
    ComPtr<ICoreWebView2Settings5> settings5;
    if (SUCCEEDED(settings.As(&settings5))) settings5->put_IsPinchZoomEnabled(FALSE);
    ComPtr<ICoreWebView2Settings6> settings6;
    if (SUCCEEDED(settings.As(&settings6))) settings6->put_IsSwipeNavigationEnabled(FALSE);
  }

  ComPtr<ICoreWebView2_3> webview3;
  if (FAILED(g_webview.As(&webview3))) {
    core::log("webview: too old for a virtual host");
    return;
  }
  webview3->SetVirtualHostNameToFolderMapping(kHost, g_ui_dir.c_str(),
                                              COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_DENY_CORS);
  g_webview->AddWebResourceRequestedFilter(L"https://steamar.cc/api/*", COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);
  g_webview->AddWebResourceRequestedFilter(L"https://steamar.cc/img/*", COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);
  g_webview->add_WebMessageReceived(
      Callback<ICoreWebView2WebMessageReceivedEventHandler>(on_message).Get(), nullptr);

  // Links that want a new window belong to the user's browser, not to a popup without chrome.
  g_webview->add_NewWindowRequested(
      Callback<ICoreWebView2NewWindowRequestedEventHandler>(
          [](ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs* args) -> HRESULT {
            LPWSTR uri = nullptr;
            args->get_Uri(&uri);
            if (uri) {
              ShellExecuteW(g_window, L"open", uri, nullptr, nullptr, SW_SHOWNORMAL);
              CoTaskMemFree(uri);
            }
            args->put_Handled(TRUE);
            return S_OK;
          })
          .Get(),
      nullptr);

  if (!g_shot_file.empty()) {
    g_webview->add_NavigationCompleted(
        Callback<ICoreWebView2NavigationCompletedEventHandler>(
            [](ICoreWebView2*, ICoreWebView2NavigationCompletedEventArgs*) -> HRESULT {
              SetTimer(g_window, kShotTimer, static_cast<UINT>(g_shot_wait), nullptr);
              SetTimer(g_window, kShotDeadline, 30000, nullptr);
              return S_OK;
            })
            .Get(),
        nullptr);
  }

  // Nothing is asked of the engine until it answers, so the first paint already has data.
  for (int i = 0; i < 200 && !g_engine_ready; ++i) Sleep(50);

  const std::wstring url = L"https://steamar.cc/index.html" + (g_route.empty() ? L"" : L"#/" + g_route);
  core::log("page: navigating " + std::to_string(core::now_ms() - g_started) + " ms after start");
  g_webview->Navigate(url.c_str());
}

void create_webview() {
  wchar_t local[1024]{};
  std::wstring data_dir;
  if (GetEnvironmentVariableW(L"LOCALAPPDATA", local, static_cast<DWORD>(std::size(local)))) {
    data_dir = core::join(core::join(local, L"SteaMar"), L"WebView2");
  } else {
    data_dir = core::join(core::join(core::project_root(), L"out"), L"webview");
  }
  core::ensure_dir(data_dir);

  // Debug builds can be driven from the outside: DevTools plus a CDP port for the self-tests.
  ComPtr<ICoreWebView2EnvironmentOptions> options;
  if (g_devtools) {
    auto created = Microsoft::WRL::Make<CoreWebView2EnvironmentOptions>();
    created->put_AdditionalBrowserArguments(L"--remote-debugging-port=9222");
    options = created;
  }

  auto environment = Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
      [data_dir](HRESULT result, ICoreWebView2Environment* env) -> HRESULT {
        if (FAILED(result) || !env) {
          core::log("webview: environment failed 0x" + std::to_string(static_cast<unsigned>(result)));
          // A portable copy lands on machines that have never run a WebView2 app. Offering the
          // official installer is the difference between "flawless" and "go search for it".
          if (MessageBoxW(g_window,
                          L"SteaMar needs the Microsoft WebView2 runtime, and this PC does not have it yet.\n\n"
                          L"Open the download page? It is free, from Microsoft, and takes about a minute.",
                          kTitle, MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON1 | MB_SETFOREGROUND) == IDYES) {
            ShellExecuteW(g_window, L"open", L"https://go.microsoft.com/fwlink/p/?LinkId=2124703", nullptr,
                          nullptr, SW_SHOWNORMAL);
          }
          PostQuitMessage(1);
          return S_OK;
        }
        g_env = env;
        env->CreateCoreWebView2Controller(
            g_window,
            Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
                [](HRESULT created, ICoreWebView2Controller* controller) -> HRESULT {
                  if (FAILED(created) || !controller) {
                    core::log("webview: controller failed");
                    PostQuitMessage(1);
                    return S_OK;
                  }
                  g_controller = controller;
                  g_controller->get_CoreWebView2(&g_webview);
                  setup_webview();
                  return S_OK;
                })
                .Get());
        return S_OK;
      });

  CreateCoreWebView2EnvironmentWithOptions(nullptr, data_dir.c_str(), options.Get(), environment.Get());
}

/* ---------- window ---------- */

// The window has exactly one size: 1180x760 logical pixels, scaled by the DPI of the monitor it is
// on. Everything that needs a size - the min/max pin, the repair on WM_SIZE - asks for this, never
// for whatever the rectangle happens to be at that moment.
int scaled(int logical, HWND window) {
  UINT dpi = window ? GetDpiForWindow(window) : 0;
  if (!dpi) dpi = GetDpiForSystem();
  return MulDiv(logical, static_cast<int>(dpi ? dpi : 96), 96);
}

LRESULT CALLBACK window_proc(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
  switch (message) {
    case WM_SIZE: {
      if (g_controller) {
        RECT bounds{};
        GetClientRect(window, &bounds);
        g_controller->put_Bounds(bounds);
      }
      // Snap, Win+arrow and a bad restore can still hand the window a size no layout is drawn for.
      // Put it back, unless it is on its way to the taskbar.
      if (wparam != SIZE_MINIMIZED && !IsIconic(window)) {
        RECT rect{};
        if (GetWindowRect(window, &rect)) {
          const int want_width = scaled(g_logical_width, window);
          const int want_height = scaled(g_logical_height, window);
          if (rect.right - rect.left != want_width || rect.bottom - rect.top != want_height) {
            core::log("size: " + std::to_string(rect.right - rect.left) + "x" + std::to_string(rect.bottom - rect.top)
                      + " corrected to " + std::to_string(want_width) + "x" + std::to_string(want_height));
            SetWindowPos(window, nullptr, 0, 0, want_width, want_height, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
          }
        }
      }
      return 0;
    }
    case WM_GETMINMAXINFO: {
      // No thick frame means no drag-resize, but snap and Win+arrow still ask for a new size.
      // Pinning min and max to the window's own size refuses every one of them.
      //
      // The size comes from the constant, not from the live rect. This message also arrives while
      // the window is being created, activated, minimised and restored - pinning whatever the rect
      // is at that instant is how the window ends up as nothing but a title bar with a minimise and
      // a close button, with no way back short of restarting the app.
      auto* info = reinterpret_cast<MINMAXINFO*>(lparam);
      const int width = scaled(g_logical_width, window);
      const int height = scaled(g_logical_height, window);
      info->ptMinTrackSize.x = width;
      info->ptMinTrackSize.y = height;
      info->ptMaxTrackSize.x = width;
      info->ptMaxTrackSize.y = height;
      return 0;
    }
    case WM_DPICHANGED: {
      // Same logical size on the new monitor: a 1180x760 window stays 1180x760 to the eye whether
      // that display is at 100% or 200%.
      const auto* suggested = reinterpret_cast<RECT*>(lparam);
      const UINT dpi = HIWORD(wparam);
      const int width = MulDiv(g_logical_width, static_cast<int>(dpi), 96);
      const int height = MulDiv(g_logical_height, static_cast<int>(dpi), 96);
      core::log("dpi: " + std::to_string(dpi) + " -> " + std::to_string(width) + "x" + std::to_string(height));
      SetWindowPos(window, nullptr, suggested->left, suggested->top, width, height, SWP_NOZORDER | SWP_NOACTIVATE);
      return 0;
    }
    case kZoom: {
      auto* request = reinterpret_cast<ZoomRequest*>(lparam);
      if (request) {
        request->applied = apply_zoom(request->percent);
        if (request->done) SetEvent(request->done);
      }
      return 0;
    }
    case kPick: {
      auto* request = reinterpret_cast<PickRequest*>(lparam);
      if (request) {
        request->picked = show_folder_picker(request->title, request->start);
        if (request->done) SetEvent(request->done);
      }
      return 0;
    }
    case kReplyReady: {
      auto* pending = reinterpret_cast<Pending*>(lparam);
      json::Value reply = json::Value::object();
      reply.set("id", json::Value::number(static_cast<double>(pending->id)));
      reply.set("status", json::Value::number(pending->response.status));
      reply.set("text", json::Value::str(pending->response.body));
      if (g_webview) g_webview->PostWebMessageAsJson(core::wide(json::dump(reply)).c_str());
      delete pending;      return 0;
    }
    case WM_TIMER: {
      if (wparam == kShotTimer) {
        KillTimer(window, kShotTimer);
        capture(g_shot_file);
      } else if (wparam == kShotDeadline) {
        KillTimer(window, kShotDeadline);
        core::log("shot: timed out");
        PostQuitMessage(2);
      }
      return 0;
    }
    case WM_CLOSE:
      save_position();
      DestroyWindow(window);
      return 0;
    case WM_DESTROY:
      if (g_controller) g_controller->Close();
      PostQuitMessage(0);
      return 0;
    default:
      return DefWindowProcW(window, message, wparam, lparam);
  }
}

void make_dark(HWND window) {
  const BOOL dark = TRUE;
  DwmSetWindowAttribute(window, 20 /* DWMWA_USE_IMMERSIVE_DARK_MODE */, &dark, sizeof dark);
  const COLORREF caption = RGB(11, 12, 16);
  DwmSetWindowAttribute(window, 35 /* DWMWA_CAPTION_COLOR */, &caption, sizeof caption);
  const COLORREF text = RGB(212, 215, 220);
  DwmSetWindowAttribute(window, 36 /* DWMWA_TEXT_COLOR */, &text, sizeof text);
  const COLORREF border = RGB(23, 26, 32);
  DwmSetWindowAttribute(window, 34 /* DWMWA_BORDER_COLOR */, &border, sizeof border);
}

// A crash is written down before Windows Error Reporting takes over - nothing is swallowed
// silently, and the last line in out/native.log says what happened.
LONG WINAPI on_crash(EXCEPTION_POINTERS* info) {
  if (info && info->ExceptionRecord) {
    const unsigned long code = static_cast<unsigned long>(info->ExceptionRecord->ExceptionCode);
    char line[160]{};
    std::snprintf(line, sizeof line, "crash: code 0x%08lx at %p", code,
                  static_cast<const void*>(info->ExceptionRecord->ExceptionAddress));
    core::log(line);
  }
  return EXCEPTION_CONTINUE_SEARCH;
}

// The mark ships inside the exe as resource 1 (steamar.rc), so Explorer, the taskbar and alt-tab
// all show the same artwork at the size they ask for instead of a scaled 32px copy.
HICON load_icon(int width, int height) {
  return static_cast<HICON>(LoadImageW(GetModuleHandleW(nullptr), MAKEINTRESOURCEW(1), IMAGE_ICON, width, height,
                                       LR_DEFAULTCOLOR));
}

struct Launch {  std::wstring shot;
  std::wstring route;
  int wait_ms = 1600;
  int width = 0;
  int height = 0;
};

Launch parse(const std::wstring& command_line) {
  Launch launch;
  int argc = 0;
  wchar_t** argv = CommandLineToArgvW(command_line.c_str(), &argc);
  if (!argv) return launch;
  for (int i = 1; i < argc; ++i) {
    const std::wstring arg = argv[i];
    if (arg == L"--shot" && i + 1 < argc) launch.shot = argv[++i];
    else if (arg == L"--route" && i + 1 < argc) launch.route = argv[++i];
    else if (arg == L"--wait" && i + 1 < argc) launch.wait_ms = _wtoi(argv[++i]);
    else if (arg == L"--size" && i + 1 < argc) {
      const std::wstring size = argv[++i];
      const size_t x = size.find(L'x');
      if (x != std::wstring::npos) {
        launch.width = _wtoi(size.substr(0, x).c_str());
        launch.height = _wtoi(size.substr(x + 1).c_str());
      }
    } else if (arg == L"--devtools") {
      g_devtools = true;
    } else if (arg == L"--root" && i + 1 < argc) {
      core::set_project_root(argv[++i]);
    } else if (arg == L"--port" && i + 1 < argc) {
      api::set_engine_port(_wtoi(argv[++i]));
    }
  }
  LocalFree(argv);
  return launch;
}

}  // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int show) {
  SetUnhandledExceptionFilter(on_crash);
  const Launch launch = parse(GetCommandLineW());
  g_shot_file = launch.shot;
  g_route = launch.route;
  g_started = core::now_ms();
  if (launch.wait_ms > 0) g_shot_wait = launch.wait_ms;

  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  SetCurrentProcessExplicitAppUserModelID(L"SteaMar.App");
  CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

  HANDLE single = CreateMutexW(nullptr, TRUE, L"SteaMar.SingleInstance");
  if (single && GetLastError() == ERROR_ALREADY_EXISTS) {
    if (HWND existing = FindWindowW(kClass, nullptr)) {
      ShowWindow(existing, SW_RESTORE);
      SetForegroundWindow(existing);
    }
    return 0;
  }

  const std::wstring root = core::project_root();
  g_ui_dir = core::join(root, L"ui");
  core::log("start: root " + core::narrow(root));

  WNDCLASSEXW wc{};
  wc.cbSize = sizeof wc;
  wc.style = CS_HREDRAW | CS_VREDRAW;
  wc.lpfnWndProc = window_proc;
  wc.hInstance = instance;
  wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  wc.hbrBackground = CreateSolidBrush(RGB(9, 10, 13));
  wc.lpszClassName = kClass;
  wc.lpszMenuName = nullptr;
  wc.hIcon = load_icon(GetSystemMetrics(SM_CXICON), GetSystemMetrics(SM_CYICON));
  wc.hIconSm = load_icon(GetSystemMetrics(SM_CXSMICON), GetSystemMetrics(SM_CYSMICON));
  RegisterClassExW(&wc);

  // --size overrides the fixed size for screenshots; the shipped window cannot be stretched.
  if (launch.width > 0 && launch.height > 0) {
    g_logical_width = launch.width;
    g_logical_height = launch.height;
  }
  const int dpi = static_cast<int>(GetDpiForSystem());
  const int width = MulDiv(g_logical_width, dpi, 96);
  const int height = MulDiv(g_logical_height, dpi, 96);
  int x = 0;
  int y = 0;
  load_position(width, height, x, y);
  if (launch.width > 0 || launch.height > 0) {
    x = CW_USEDEFAULT;
    y = CW_USEDEFAULT;
  }

  // No WS_THICKFRAME and no WS_MAXIMIZEBOX: a fixed tool window, still minimisable and closable.
  const DWORD style = WS_OVERLAPPEDWINDOW & ~WS_THICKFRAME & ~WS_MAXIMIZEBOX;
  g_window = CreateWindowExW(0, kClass, kTitle, style, x, y, width, height, nullptr, nullptr, instance, nullptr);
  if (!g_window) {
    core::log("start: no window");
    return 1;
  }
  // Setting them on the window too keeps the taskbar button and alt-tab in step after a DPI change.
  SendMessageW(g_window, WM_SETICON, ICON_BIG, reinterpret_cast<LPARAM>(wc.hIcon));
  SendMessageW(g_window, WM_SETICON, ICON_SMALL, reinterpret_cast<LPARAM>(wc.hIconSm));
  make_dark(g_window);
  api::set_owner(g_window);
  load_zoom();
  api::set_zoom(zoom_blocking);
  api::set_picker(pick_blocking);
  api::set_zoom_level(g_zoom);

  ShowWindow(g_window, show == 0 ? SW_SHOWDEFAULT : show);
  UpdateWindow(g_window);

  switch (probe_engine()) {
    case EngineState::conflict:
      // The message is already on screen; nothing else here can be trusted to act on it.
      return 0;
    case EngineState::ready:
      break;
    case EngineState::absent: {
      std::thread engine(start_engine);
      engine.detach();
      break;
    }
  }

  create_webview();

  MSG message{};
  while (GetMessageW(&message, nullptr, 0, 0)) {
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }

  if (g_engine_job) CloseHandle(g_engine_job);  // takes the engine down with it
  CoUninitialize();
  return 0;
}
