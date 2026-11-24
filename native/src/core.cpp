#include "core.h"

#include <windows.h>

#include <chrono>
#include <cstdio>
#include <mutex>

namespace core {
namespace {

std::wstring g_root;
std::mutex g_log_lock;

bool file_exists(const std::wstring& path) {
  const DWORD attr = GetFileAttributesW(path.c_str());
  return attr != INVALID_FILE_ATTRIBUTES;
}

}  // namespace

std::string narrow(const std::wstring& text) {
  if (text.empty()) return {};
  const int need = WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr);
  std::string out(static_cast<size_t>(need), '\0');
  WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), out.data(), need, nullptr, nullptr);
  return out;
}

std::wstring wide(std::string_view text) {
  if (text.empty()) return {};
  const int need = MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), nullptr, 0);
  std::wstring out(static_cast<size_t>(need), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), out.data(), need);
  return out;
}

std::wstring join(const std::wstring& a, const std::wstring& b) {
  if (b.size() > 1 && b[1] == L':') return b;
  if (!b.empty() && (b[0] == L'\\' || b[0] == L'/')) return b;
  std::wstring left = a;
  while (!left.empty() && (left.back() == L'\\' || left.back() == L'/')) left.pop_back();
  if (left.empty()) return b;
  return left + L"\\" + b;
}

bool exists(const std::wstring& path) {
  if (path.empty()) return false;
  return file_exists(path);
}

bool is_dir(const std::wstring& path) {
  const DWORD attr = GetFileAttributesW(path.c_str());
  return attr != INVALID_FILE_ATTRIBUTES && (attr & FILE_ATTRIBUTE_DIRECTORY) != 0;
}

void ensure_dir(const std::wstring& path) {
  if (path.empty() || is_dir(path)) return;
  std::wstring acc;
  acc.reserve(path.size());
  for (size_t i = 0; i < path.size(); ++i) {
    const wchar_t c = path[i];
    acc.push_back(c);
    const bool last = i + 1 == path.size();
    if ((c == L'\\' || c == L'/') || last) {
      if (acc.size() > 1) CreateDirectoryW(acc.c_str(), nullptr);
    }
  }
}

std::string read_file(const std::wstring& path) {
  HANDLE h = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                         nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (h == INVALID_HANDLE_VALUE) return {};
  LARGE_INTEGER size{};
  if (!GetFileSizeEx(h, &size) || size.QuadPart > (1LL << 31)) {
    CloseHandle(h);
    return {};
  }
  std::string out(static_cast<size_t>(size.QuadPart), '\0');
  DWORD read = 0;
  if (!out.empty()) {
    if (!ReadFile(h, out.data(), static_cast<DWORD>(out.size()), &read, nullptr)) out.clear();
    else out.resize(read);
  }
  CloseHandle(h);
  return out;
}

bool write_file(const std::wstring& path, std::string_view bytes) {
  const size_t slash = path.find_last_of(L"\\/");
  if (slash != std::wstring::npos) ensure_dir(path.substr(0, slash));
  HANDLE h = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (h == INVALID_HANDLE_VALUE) return false;
  DWORD written = 0;
  const bool ok = bytes.empty() || WriteFile(h, bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr);
  CloseHandle(h);
  return ok;
}

std::vector<std::wstring> list_dir(const std::wstring& path) {
  std::vector<std::wstring> out;
  WIN32_FIND_DATAW data{};
  HANDLE h = FindFirstFileW(join(path, L"*").c_str(), &data);
  if (h == INVALID_HANDLE_VALUE) return out;
  do {
    const std::wstring name = data.cFileName;
    if (name == L"." || name == L"..") continue;
    out.push_back(name);
  } while (FindNextFileW(h, &data));
  FindClose(h);
  return out;
}

std::uint64_t file_size(const std::wstring& path) {
  WIN32_FILE_ATTRIBUTE_DATA data{};
  if (!GetFileAttributesExW(path.c_str(), GetFileExInfoStandard, &data)) return 0;
  return (static_cast<std::uint64_t>(data.nFileSizeHigh) << 32) | data.nFileSizeLow;
}

std::uint64_t now_ms() {
  const auto now = std::chrono::system_clock::now().time_since_epoch();
  return static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(now).count());
}

std::string now_iso() {
  SYSTEMTIME utc{};
  GetSystemTime(&utc);
  char buf[40]{};
  std::snprintf(buf, sizeof buf, "%04u-%02u-%02uT%02u:%02u:%02u.%03uZ", utc.wYear, utc.wMonth, utc.wDay,
                utc.wHour, utc.wMinute, utc.wSecond, utc.wMilliseconds);
  return buf;
}

std::wstring exe_dir() {
  wchar_t buf[MAX_PATH * 2]{};
  const DWORD len = GetModuleFileNameW(nullptr, buf, static_cast<DWORD>(std::size(buf)));
  std::wstring path(buf, len);
  const size_t slash = path.find_last_of(L"\\/");
  return slash == std::wstring::npos ? path : path.substr(0, slash);
}

void set_project_root(const std::wstring& root) { g_root = root; }

std::wstring project_root() {
  if (!g_root.empty()) return g_root;

  // A published build carries ui/ and config/ beside the exe; a dev build sits in native/build.
  std::wstring dir = exe_dir();
  for (int level = 0; level < 6 && !dir.empty(); ++level) {
    if (exists(join(dir, L"ui\\index.html")) && is_dir(join(dir, L"config"))) {
      g_root = dir;
      return g_root;
    }
    const size_t slash = dir.find_last_of(L"\\/");
    if (slash == std::wstring::npos) break;
    dir = dir.substr(0, slash);
  }
  g_root = exe_dir();
  return g_root;
}

void log(std::string_view line) {
  std::lock_guard<std::mutex> guard(g_log_lock);
  const std::wstring dir = join(project_root(), L"out");
  ensure_dir(dir);
  const std::string text = "[" + now_iso() + "] " + std::string(line) + "\n";
  HANDLE h = CreateFileW(join(dir, L"native.log").c_str(), FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE,
                         nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (h != INVALID_HANDLE_VALUE) {
    DWORD written = 0;
    WriteFile(h, text.data(), static_cast<DWORD>(text.size()), &written, nullptr);
    CloseHandle(h);
  }
  OutputDebugStringA(text.c_str());
}

}  // namespace core
