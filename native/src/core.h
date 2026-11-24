// Small shared plumbing: strings, files, the project root, and the log file.
#pragma once

#include <string>
#include <string_view>
#include <vector>

namespace core {

std::string narrow(const std::wstring& text);
std::wstring wide(std::string_view text);

std::wstring join(const std::wstring& a, const std::wstring& b);
bool exists(const std::wstring& path);
bool is_dir(const std::wstring& path);
void ensure_dir(const std::wstring& path);
std::string read_file(const std::wstring& path);
bool write_file(const std::wstring& path, std::string_view bytes);
std::vector<std::wstring> list_dir(const std::wstring& path);
std::uint64_t file_size(const std::wstring& path);
std::uint64_t now_ms();
std::string now_iso();

// The folder holding config/, ui/ and out/: found by walking up from the exe so a copied
// build still finds its data, and overridable with --root.
std::wstring project_root();
void set_project_root(const std::wstring& root);

std::wstring exe_dir();
void log(std::string_view line);

}  // namespace core
