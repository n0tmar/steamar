#include "api.h"

#include <shellapi.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <wrl.h>

#include <string>
#include <thread>
#include <utility>

#include "config.h"
#include "core.h"
#include "net.h"

using Microsoft::WRL::ComPtr;

namespace api {
namespace {

HWND g_owner = nullptr;
int g_port = 8788;
Zoom g_zoom;
Picker g_picker;
int g_zoom_level = 100;

std::wstring engine_base() { return L"http://127.0.0.1:" + std::to_wstring(g_port); }

std::string escape(std::string_view text) {
  std::string out;
  out.reserve(text.size() + 8);
  for (char c : text) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (static_cast<unsigned char>(c) < 0x20) out += ' ';
        else out += c;
    }
  }
  return out;
}

Response fail(std::string_view message, int status = 500) {
  Response r;
  r.status = status;
  r.body = "{\"error\":\"" + escape(message) + "\"}";
  return r;
}

Response okay(std::string body) {
  Response r;
  r.status = 200;
  r.body = std::move(body);
  return r;
}

bool digits_only(std::string_view text) {
  if (text.empty() || text.size() > 12) return false;
  for (char c : text) {
    if (c < '0' || c > '9') return false;
  }
  return true;
}

// A small JSON field reader: the bridge only ever needs one flat key out of a body like
// {"appid":"123","action":"install"}.
std::string field(std::string_view json, std::string_view key) {
  const std::string needle = "\"" + std::string(key) + "\"";
  size_t at = json.find(needle);
  if (at == std::string_view::npos) return {};
  at = json.find(':', at + needle.size());
  if (at == std::string_view::npos) return {};
  ++at;
  while (at < json.size() && (json[at] == ' ' || json[at] == '\t' || json[at] == '\r' || json[at] == '\n')) ++at;
  if (at >= json.size()) return {};
  if (json[at] != '"') {
    // A number or a bare literal, so a body like {"percent":115} reads as text too.
    size_t end = json.find_first_of(",}", at);
    if (end == std::string_view::npos) end = json.size();
    std::string out(json.substr(at, end - at));
    while (!out.empty() && (out.back() == ' ' || out.back() == '\t' || out.back() == '\r' || out.back() == '\n')) {
      out.pop_back();
    }
    return out;
  }
  ++at;
  std::string out;
  while (at < json.size() && json[at] != '"') {
    if (json[at] == '\\' && at + 1 < json.size()) {
      ++at;
      switch (json[at]) {
        case 'n': out += '\n'; break;
        case 't': out += '\t'; break;
        case 'r': out += '\r'; break;
        default: out += json[at];
      }
    } else {
      out += json[at];
    }
    ++at;
  }
  return out;
}

// Explorer and Steam are handed work through ShellExecute: no console window, no cmd.
bool shell_open(const std::wstring& target) {
  const HINSTANCE result = ShellExecuteW(g_owner, L"open", target.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
  return reinterpret_cast<INT_PTR>(result) > 32;
}

bool is_dir(const std::wstring& path) {
  if (path.empty()) return false;
  const DWORD attributes = GetFileAttributesW(path.c_str());
  return attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_DIRECTORY);
}

// Windows will not open a picker on a folder that is not there, and the stored value can be stale:
// a Steam folder that moved, a Lua folder that does not exist yet. Walk up to the nearest parent
// that does exist, so the dialog always lands as close to the configured folder as it can.
std::wstring nearest_dir(std::wstring path) {
  while (path.size() > 3) {
    if (is_dir(path)) return path;
    const size_t cut = path.find_last_of(L"\\/");
    if (cut == std::wstring::npos || cut < 3) break;
    path.erase(cut);
  }
  return is_dir(path) ? path : std::wstring();
}

std::wstring documents_dir() {
  PWSTR raw = nullptr;
  std::wstring out;
  if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_Documents, 0, nullptr, &raw)) && raw) {
    out = raw;
    CoTaskMemFree(raw);
  }
  return out;
}

// Which folder a Settings row is about. The page names the row; the shell knows where it points,
// so the dialog never depends on the page having the same idea about its own configuration.
std::wstring folder_for_key(const std::string& key) {
  if (key == "steam_root") return app::steam_root();
  if (key == "stplug_in") return app::stplug_in();
  if (key == "depotcache") return app::depotcache();
  if (key == "dll_source") return app::dll_source();
  return std::wstring();
}

// The folder the dialog should open on: what the caller asked for, else the row's own folder, else
// Steam, else Documents. Always an existing directory, or empty when nothing suitable is found.
std::wstring start_folder(const std::string& key, const std::string& requested) {
  const std::wstring asked = requested.empty() ? std::wstring() : core::wide(requested);
  for (const std::wstring& candidate : {asked, folder_for_key(key), app::steam_root(), documents_dir()}) {
    const std::wstring found = nearest_dir(candidate);
    if (!found.empty()) return found;
  }
  return std::wstring();
}

Response pick_folder(const Request& request) {
  const std::string title = field(request.body, "title");
  const std::string key = field(request.body, "key");
  const std::string requested = field(request.body, "start");
  const std::wstring start = start_folder(key, requested);

  // The shell owns the UI thread and its apartment, so the dialog is shown there while this
  // worker waits. Only if no host is installed does this thread try on its own.
  std::wstring picked;
  if (g_picker) {
    picked = g_picker(core::wide(title), start);
  } else {
    ComPtr<IFileOpenDialog> dialog;
    if (FAILED(CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dialog)))) {
      return fail("the folder picker is not available");
    }
    DWORD options = 0;
    dialog->GetOptions(&options);
    dialog->SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
    if (!title.empty()) dialog->SetTitle(core::wide(title).c_str());
    if (!start.empty()) {
      ComPtr<IShellItem> here;
      if (SUCCEEDED(SHCreateItemFromParsingName(start.c_str(), nullptr, IID_PPV_ARGS(&here)))) {
        dialog->SetFolder(here.Get());
        dialog->SetDefaultFolder(here.Get());
      }
    }
    if (SUCCEEDED(dialog->Show(g_owner))) {
      ComPtr<IShellItem> item;
      PWSTR raw = nullptr;
      if (SUCCEEDED(dialog->GetResult(&item)) && SUCCEEDED(item->GetDisplayName(SIGDN_FILESYSPATH, &raw)) && raw) {
        picked = raw;
        CoTaskMemFree(raw);
      }
    }
  }

  if (picked.empty()) return fail("no folder picked", 400);

  Response r;
  r.body = "{\"folder\":\"" + escape(core::narrow(picked)) + "\",\"started_in\":\"" + escape(core::narrow(start)) +
           "\"}";
  return r;
}

Response install(const Request& request) {
  const std::string appid = field(request.body, "appid");
  if (!digits_only(appid)) return fail("appid must be digits", 400);
  const std::string action = field(request.body, "action");
  const std::wstring url = L"steam://" + std::wstring(action == "play" ? L"rungameid/" : L"install/") +
                           core::wide(appid);
  if (!shell_open(url)) return fail("Steam did not answer the request");
  return okay("{\"opened\":\"" + escape(core::narrow(url)) + "\"}");
}

// Log lines stay one per event, so a stack trace keeps its frames but loses its newlines.
std::string one_line(const std::string& text) {
  std::string flat;
  flat.reserve(text.size() + 8);
  bool gap = false;
  for (const char c : text) {
    if (c == '\r' || c == '\n' || c == '\t') { gap = true; continue; }
    if (static_cast<unsigned char>(c) < 0x20) continue;
    if (gap) { if (c == ' ') continue; if (!flat.empty()) flat += " | "; gap = false; }
    flat.push_back(c);
  }
  return flat;
}

// The number is validated here; the shell applies it to the controller on the UI thread and
// answers with what it actually set, so the two can never disagree.
Response text_size(const Request& request) {
  const std::string raw = field(request.body, "percent");
  if (!digits_only(raw)) return fail("text size must be a whole number", 400);
  if (!g_zoom) return fail("text size needs the desktop app", 503);
  g_zoom_level = g_zoom(std::stoi(raw));
  return okay("{\"zoom\":" + std::to_string(g_zoom_level) + "}");
}

// Every UI warning and error arrives here so one log file has the whole story, shell and page.
Response log_from_ui(const Request& request) {
  std::string level = field(request.body, "level");
  std::string message = field(request.body, "message");
  if (level.empty()) level = "log";
  if (level.size() > 20) level.resize(20);
  if (message.size() > 2000) message.resize(2000);
  core::log("ui." + level + ": " + one_line(message));
  return okay("{\"logged\":true}");
}

Response status() {  const std::vector<app::Script> scripts = app::scripts();
  int games = 0;
  int configs = 0;
  for (const auto& script : scripts) (script.game ? games : configs) += 1;

  json::Value dlls = json::Value::array();
  for (const std::string& name : app::proxy_dlls()) {
    const std::wstring full = core::join(app::steam_root(), core::wide(name));
    json::Value dll = json::Value::object();
    dll.set("name", json::Value::str(name));
    dll.set("present", json::Value::boolean(core::exists(full)));
    dlls.push(dll);
  }

  json::Value out = json::Value::object();
  out.set("root", json::Value::str(core::narrow(core::project_root())));
  out.set("steam_root", json::Value::str(core::narrow(app::steam_root())));
  out.set("steam_running", json::Value::boolean(app::steam_running()));
  out.set("proxy_dlls", dlls);
  out.set("toml", json::Value::boolean(core::exists(app::toml_path())));
  out.set("scripts", json::Value::number(games));
  out.set("config_scripts", json::Value::number(configs));
  // No `available` here any more. How many titles can be added is the service's count, and the
  // engine already answers it (`/api/reach`); what this route could see was the old downloaded game
  // list, so it read zero on every copy that had none - and "an empty copy" is not the same thing
  // as "the service has nothing to offer".
  out.set("zoom", json::Value::number(g_zoom_level));
  out.set("needs_repair", json::Value::number(0));
  return okay(json::dump(out));
}

Response reveal(const Request& request) {
  const std::string target = field(request.body, "target");
  std::wstring dir;
  if (target == "steam") dir = app::steam_root();
  else if (target == "stplug_in") dir = app::stplug_in();
  else if (target == "depotcache") dir = app::depotcache();
  else if (target == "out") dir = app::out_dir();
  else if (target == "project") dir = core::project_root();
  else return fail("unknown target " + target, 400);

  if (!core::exists(dir)) return fail("missing " + core::narrow(dir), 404);
  if (!shell_open(dir)) return fail("explorer did not open that folder");
  return okay("{\"opened\":\"" + escape(core::narrow(dir)) + "\"}");
}

Response cache_clear() {  const std::wstring out = core::join(core::project_root(), L"out");
  for (const wchar_t* name : {L"cache", L"imgcache"}) {
    const std::wstring dir = core::join(out, name);
    if (!core::exists(dir)) continue;
    std::wstring from = dir;
    from.push_back(L'\0');
    from.push_back(L'\0');
    SHFILEOPSTRUCTW op{};
    op.wFunc = FO_DELETE;
    op.pFrom = from.c_str();
    op.fFlags = FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI;
    SHFileOperationW(&op);
  }
  return okay("{\"cleared\":true}");
}

// Art lives on the engine's loopback origin for now: the UI gets absolute urls back so its
// <img> tags work from the virtual host without another hop through this bridge.
void expand_art(std::string& text) {
  const std::string from = "\"/img/";
  const std::string to = "\"" + core::narrow(engine_base()) + "/img/";
  size_t at = 0;
  while ((at = text.find(from, at)) != std::string::npos) {
    text.replace(at, from.size(), to);
    at += to.size();
  }
}

// The one route that ends this process on purpose. The page has already downloaded the release and
// checked it against the checksum in the signed manifest; what it cannot do is replace a file the
// app is running. So the shell starts the updater, then closes - and the updater is this process's
// child rather than the engine's, because the engine lives in a job object that dies with the window
// and anything it starts dies with it. That one detail is the whole reason this is native code.
Response update_apply() {
  const std::wstring root = core::project_root();
  const std::wstring bundled = core::join(root, L"runtime\\node.exe");
  const std::wstring node = core::exists(bundled) ? bundled : L"node.exe";
  const std::wstring script = core::join(root, L"src\\update-apply.js");
  const std::wstring stage = core::join(root, L"out\\update\\stage");

  if (!core::exists(script)) return fail("this copy has no updater in it - download the release instead", 400);
  if (!core::exists(core::join(stage, L"SteaMar.exe"))) return fail("nothing has been staged to install", 400);

  const std::wstring command = L"\"" + node + L"\" \"" + script + L"\" \"" + stage + L"\"";
  std::wstring launch = command;
  STARTUPINFOW startup{};
  startup.cb = sizeof startup;
  startup.dwFlags = STARTF_USESHOWWINDOW;
  startup.wShowWindow = SW_HIDE;
  PROCESS_INFORMATION info{};
  if (!CreateProcessW(nullptr, launch.data(), nullptr, nullptr, FALSE,
                      CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP, nullptr, root.c_str(), &startup, &info)) {
    core::log("update: the updater would not start");
    return fail("the updater would not start", 500);
  }
  CloseHandle(info.hThread);
  CloseHandle(info.hProcess);
  core::log("update: updater started, closing the window");

  // The reply has to reach the page before the window goes, so the close waits its turn. A window
  // that vanished inside the reply would leave the page showing a spinner over a dead process.
  std::thread([]() {
    Sleep(900);
    if (g_owner) PostMessageW(g_owner, WM_CLOSE, 0, 0);
  }).detach();
  return okay("{\"started\":true}");
}

Response proxy(const Request& request) {
  const std::wstring url = engine_base() + core::wide(request.path);
  const std::uint64_t started = core::now_ms();
  const net::Result result = request.method == "POST" ? net::post(url, request.body) : net::get(url);
  const std::uint64_t took = core::now_ms() - started;

  if (result.status == 0) {
    core::log("proxy: engine unreachable for " + request.path + " after " + std::to_string(took) + " ms");
    return fail("the app engine is not running", 503);
  }
  if (result.status >= 500) {
    core::log("proxy: " + request.path + " -> " + std::to_string(result.status) + " in " + std::to_string(took) +
              " ms: " + result.body.substr(0, 200));
  } else if (took > 1500) {
    core::log("proxy: slow " + request.path + " " + std::to_string(took) + " ms");
  }

  Response r;
  r.status = result.status;
  r.body = result.body;
  if (!result.content_type.empty()) {
    r.content_type = result.content_type;
    if (r.content_type.rfind("image/", 0) == 0) r.cache = "public, max-age=31536000, immutable";
  }
  if (r.content_type.rfind("application/json", 0) == 0) expand_art(r.body);
  return r;
}

}  // namespace

void set_owner(HWND window) { g_owner = window; }
void set_engine_port(int port) { g_port = port; }
void set_zoom(Zoom handler) { g_zoom = std::move(handler); }
void set_zoom_level(int percent) { g_zoom_level = percent; }
void set_picker(Picker handler) { g_picker = std::move(handler); }

Response handle(const Request& request) {
  // One bad route must never take the window down: everything leaves as JSON.
  try {
    if (request.body.size() > (1u << 20)) return fail("body too large", 413);
    if (request.path.rfind("/api/", 0) != 0) return fail("no route " + request.path, 404);

    // Native routes: instant, and they keep working with the engine down.
    if (request.path == "/api/status" && request.method == "GET") return status();
      if (request.path == "/api/log" && request.method == "POST") return log_from_ui(request);
    if (request.path == "/api/reveal" && request.method == "POST") return reveal(request);
    if (request.path == "/api/pick-folder" && request.method == "POST") return pick_folder(request);
    if (request.path == "/api/install" && request.method == "POST") return install(request);
    if (request.path == "/api/cache/clear" && request.method == "POST") return cache_clear();
    // Updating is a shell job: it starts a process that outlives this one and closes the window.
    if (request.path == "/api/update/apply" && request.method == "POST") return update_apply();
    if (request.path == "/api/text-size" && request.method == "POST") return text_size(request);

    return proxy(request);
  } catch (const std::bad_alloc&) {
    core::log("api: out of memory on " + request.path);
    return fail("the app ran out of memory", 500);
  } catch (const std::exception& error) {
    core::log("api: exception on " + request.path + ": " + error.what());
    return fail(std::string("the app hit an error: ") + error.what(), 500);
  } catch (...) {
    core::log("api: unknown exception on " + request.path);
    return fail("the app hit an error", 500);
  }
}

}  // namespace api
