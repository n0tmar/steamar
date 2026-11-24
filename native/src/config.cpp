#include "config.h"

#include <windows.h>

#include <tlhelp32.h>

#include <algorithm>
#include <mutex>

#include "core.h"

namespace app {
namespace {

std::wstring g_root;
json::Value g_config;
bool g_loaded = false;
std::mutex g_lock;
int g_available = -1;
FILETIME g_available_stamp{};

std::wstring trim_slashes(std::wstring path) {
  while (!path.empty() && (path.back() == L'\\' || path.back() == L'/')) path.pop_back();
  return path;
}

std::wstring from_json_string(const std::string& text) {
  std::wstring out = core::wide(text);
  std::replace(out.begin(), out.end(), L'/', L'\\');
  return trim_slashes(out);
}

std::wstring config_path() { return core::join(core::join(core::project_root(), L"config"), L"steam.json"); }

bool has_steam_exe(const std::wstring& root) { return !root.empty() && core::exists(core::join(root, L"steam.exe")); }

std::wstring registry_value(HKEY hive, const wchar_t* key, const wchar_t* name) {
  wchar_t buffer[1024]{};
  DWORD size = sizeof buffer;
  DWORD type = 0;
  if (RegGetValueW(hive, key, name, RRF_RT_REG_SZ, &type, buffer, &size) != ERROR_SUCCESS) return {};
  return trim_slashes(from_json_string(core::narrow(buffer)));
}

}  // namespace

const json::Value& config() {
  std::lock_guard<std::mutex> guard(g_lock);
  if (g_loaded) return g_config;
  const std::string text = core::read_file(config_path());
  if (!text.empty() && !json::Value::parse(text, g_config)) g_config = json::Value::object();
  if (!g_config.is_object()) g_config = json::Value::object();
  g_loaded = true;
  return g_config;
}

void reload_config() {
  std::lock_guard<std::mutex> guard(g_lock);
  g_config = json::Value::object();
  const std::string text = core::read_file(config_path());
  if (!text.empty()) json::Value::parse(text, g_config);
  if (!g_config.is_object()) g_config = json::Value::object();
  g_loaded = true;
}

bool save_config() {
  std::string text;
  json::write(config(), text);
  text += "\n";
  return core::write_file(config_path(), text);
}

// The registry hands back whatever case Steam wrote, and the two fallback paths are typed by hand;
// the disk knows the real spelling, so ask it once instead of showing "c:\program files" in the UI.
std::wstring long_path(const std::wstring& path) {
  wchar_t buffer[MAX_PATH * 2]{};
  const DWORD length = GetLongPathNameW(path.c_str(), buffer, static_cast<DWORD>(std::size(buffer)));
  if (length == 0 || length >= std::size(buffer)) return path;
  return std::wstring(buffer, length);
}

std::wstring detect_steam_root() {
  struct Probe {
    HKEY hive;
    const wchar_t* key;
    const wchar_t* value;
  };
  const Probe probes[] = {
      {HKEY_CURRENT_USER, L"Software\\Valve\\Steam", L"SteamPath"},
      {HKEY_LOCAL_MACHINE, L"SOFTWARE\\WOW6432Node\\Valve\\Steam", L"InstallPath"},
      {HKEY_LOCAL_MACHINE, L"SOFTWARE\\Valve\\Steam", L"InstallPath"},
  };
  for (const auto& probe : probes) {
    const std::wstring guess = registry_value(probe.hive, probe.key, probe.value);
    if (has_steam_exe(guess)) return long_path(guess);
  }
  for (const wchar_t* guess : {L"C:\\Program Files (x86)\\Steam", L"C:\\Program Files\\Steam"}) {
    if (has_steam_exe(guess)) return long_path(guess);
  }
  return {};
}

std::wstring steam_root() {
  wchar_t env[1024]{};
  const DWORD env_len = GetEnvironmentVariableW(L"STEAM_ROOT", env, static_cast<DWORD>(std::size(env)));
  if (env_len > 0) return trim_slashes(env);

  const std::wstring stored = from_json_string(config()["steam_root"].as_string());
  if (has_steam_exe(stored)) return stored;

  const std::wstring detected = detect_steam_root();
  if (!detected.empty()) return detected;
  if (!stored.empty()) return stored;
  return L"C:\\Program Files (x86)\\Steam";
}

std::wstring stplug_in() {
  const std::wstring custom = from_json_string(config()["stplug_in"].as_string());
  return custom.empty() ? core::join(core::join(steam_root(), L"config"), L"stplug-in") : custom;
}

std::wstring depotcache() {
  const std::wstring custom = from_json_string(config()["depotcache"].as_string());
  return custom.empty() ? core::join(steam_root(), L"depotcache") : custom;
}

std::wstring toml_path() { return core::join(steam_root(), L"opensteamtool.toml"); }

std::wstring out_dir() { return core::join(core::project_root(), L"out"); }

std::wstring data_dir(const std::string& key) {
  const std::string folder = config()["data"][key].as_string();
  return core::join(core::project_root(), core::wide(folder.empty() ? key : folder));
}

std::wstring dll_source() {
  const std::wstring custom = from_json_string(config()["dll_source"].as_string());
  return custom.empty() ? core::join(core::project_root(), L"vendor") : custom;
}

bool is_override(const char* key) { return !from_json_string(config()[key].as_string()).empty(); }

// A process snapshot costs about a millisecond and needs no console: no tasklist spawn.
bool steam_running() {
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE) return false;
  PROCESSENTRY32W entry{};
  entry.dwSize = sizeof entry;
  bool found = false;
  if (Process32FirstW(snapshot, &entry)) {
    do {
      if (_wcsicmp(entry.szExeFile, L"steam.exe") == 0) {
        found = true;
        break;
      }
    } while (Process32NextW(snapshot, &entry));
  }
  CloseHandle(snapshot);
  return found;
}

std::vector<std::string> proxy_dlls() {
  std::vector<std::string> out;
  const json::Value& list = config()["proxy_dlls"];
  for (size_t i = 0; i < list.size(); ++i) out.push_back(list.at(i).as_string());
  return out;
}

int games_available() {
  const std::wstring file = core::join(core::join(data_dir("manifesthub3"), L"archive"), L"appaccesstokens.json");
  WIN32_FILE_ATTRIBUTE_DATA info{};
  const bool found = GetFileAttributesExW(file.c_str(), GetFileExInfoStandard, &info) != 0;
  {
    std::lock_guard<std::mutex> guard(g_lock);
    // The game list is downloaded on first run, after this process started: follow the file's
    // timestamp instead of answering with the count from an empty folder forever.
    if (g_available >= 0 && found && CompareFileTime(&info.ftLastWriteTime, &g_available_stamp) == 0) {
      return g_available;
    }
  }
  int count = 0;
  if (found) {
    const std::string text = core::read_file(file);
    if (!text.empty()) {
      json::Value tokens;
      if (json::Value::parse(text, tokens)) count = static_cast<int>(tokens.members().size());
    }
  }
  std::lock_guard<std::mutex> guard(g_lock);
  g_available = count;
  g_available_stamp = found ? info.ftLastWriteTime : FILETIME{};
  return g_available;
}

std::vector<Script> scripts() {
  std::vector<Script> out;
  const std::wstring dir = stplug_in();
  if (!core::is_dir(dir)) return out;

  for (const std::wstring& name : core::list_dir(dir)) {
    if (name.size() < 5) continue;
    std::wstring lower = name;
    std::transform(lower.begin(), lower.end(), lower.begin(), towlower);
    if (lower.substr(lower.size() - 4) != L".lua") continue;

    Script script;
    script.file = name;
    script.path = core::join(dir, name);
    script.bytes = core::file_size(script.path);
    script.appid = core::narrow(name.substr(0, name.size() - 4));
    const std::string text = core::read_file(script.path);
    script.game = text.find("addappid") != std::string::npos;
    out.push_back(std::move(script));
  }
  return out;
}

}  // namespace app
