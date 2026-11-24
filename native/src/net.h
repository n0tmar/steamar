// WinHTTP, in the two shapes this app needs: a small JSON read, and a small JSON post.
#pragma once

#include <string>

namespace net {

struct Result {
  bool ok = false;
  int status = 0;
  std::string body;
  std::string content_type;
};

Result get(const std::wstring& url, int timeout_ms = 15000);
Result post(const std::wstring& url, const std::string& body, int timeout_ms = 20000);

// True when something answers on the url at all; used to tell "engine is up" from "not yet".
bool alive(const std::wstring& url, int timeout_ms = 700);

// True when something listens on 127.0.0.1:port. Instant either way, where an HTTP call to a closed
// port waits about two seconds while Windows retries it.
bool listening(int port);

}  // namespace net
