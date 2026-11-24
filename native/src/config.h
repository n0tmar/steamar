// Everything the app knows about the machine: config/steam.json, the Steam install, and the
// two folders it writes scripts and manifests into.
#pragma once

#include <string>
#include <vector>

#include "json.h"

namespace app {

const json::Value& config();
void reload_config();
bool save_config();

std::wstring steam_root();
std::wstring detect_steam_root();
std::wstring stplug_in();
std::wstring depotcache();
std::wstring toml_path();
std::wstring out_dir();
std::wstring data_dir(const std::string& key);
std::wstring dll_source();
bool is_override(const char* key);

bool steam_running();
std::vector<std::string> proxy_dlls();

// The number of titles with an access token: what makes a delisted or region-locked app addable.
int games_available();

struct Script {
  std::wstring file;
  std::wstring path;
  std::string appid;
  bool game = false;
  std::uint64_t bytes = 0;
};

std::vector<Script> scripts();

}  // namespace app
