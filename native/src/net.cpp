#include "net.h"

#include <winsock2.h>
#include <mstcpip.h>
#include <windows.h>
#include <winhttp.h>

#include <vector>

namespace net {
namespace {

constexpr wchar_t kAgent[] = L"SteaMar/0.4 (+local)";

struct Url {
  std::wstring host;
  std::wstring path;
  INTERNET_PORT port = 0;
  bool secure = false;
};

bool split(const std::wstring& url, Url& out) {
  URL_COMPONENTS parts{};
  parts.dwStructSize = sizeof parts;
  parts.dwHostNameLength = static_cast<DWORD>(-1);
  parts.dwUrlPathLength = static_cast<DWORD>(-1);
  parts.dwExtraInfoLength = static_cast<DWORD>(-1);
  if (!WinHttpCrackUrl(url.c_str(), static_cast<DWORD>(url.size()), 0, &parts)) return false;
  out.host.assign(parts.lpszHostName, parts.dwHostNameLength);
  out.path.assign(parts.lpszUrlPath, parts.dwUrlPathLength);
  if (parts.dwExtraInfoLength) out.path.append(parts.lpszExtraInfo, parts.dwExtraInfoLength);
  out.port = parts.nPort;
  out.secure = parts.nScheme == INTERNET_SCHEME_HTTPS;
  return true;
}

std::string query_header(HINTERNET request, DWORD which) {
  DWORD size = 0;
  WinHttpQueryHeaders(request, which, WINHTTP_HEADER_NAME_BY_INDEX, nullptr, &size, WINHTTP_NO_HEADER_INDEX);
  if (!size) return {};
  std::wstring text(size / sizeof(wchar_t), L'\0');
  if (!WinHttpQueryHeaders(request, which, WINHTTP_HEADER_NAME_BY_INDEX, text.data(), &size, WINHTTP_NO_HEADER_INDEX))
    return {};
  while (!text.empty() && text.back() == L'\0') text.pop_back();
  const size_t semi = text.find(L';');
  const std::wstring value = semi == std::wstring::npos ? text : text.substr(0, semi);
  std::string out;
  out.reserve(value.size());
  for (wchar_t c : value) out.push_back(static_cast<char>(c));
  return out;
}

Result send(const wchar_t* verb, const std::wstring& url, const std::string* body, int timeout_ms) {
  Result out;
  Url parts;
  if (!split(url, parts)) return out;

  HINTERNET session = WinHttpOpen(kAgent, WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_NO_PROXY_NAME,
                                  WINHTTP_NO_PROXY_BYPASS, 0);
  if (!session) return out;
  WinHttpSetTimeouts(session, timeout_ms, timeout_ms, timeout_ms, timeout_ms);

  HINTERNET connect = WinHttpConnect(session, parts.host.c_str(), parts.port, 0);
  if (!connect) {
    WinHttpCloseHandle(session);
    return out;
  }

  HINTERNET request = WinHttpOpenRequest(connect, verb, parts.path.c_str(), nullptr, WINHTTP_NO_REFERER,
                                         WINHTTP_DEFAULT_ACCEPT_TYPES,
                                         parts.secure ? WINHTTP_FLAG_SECURE : 0);
  if (!request) {
    WinHttpCloseHandle(connect);
    WinHttpCloseHandle(session);
    return out;
  }

  const wchar_t* headers = body ? L"content-type: application/json\r\n" : nullptr;
  const BOOL sent = WinHttpSendRequest(request, headers, static_cast<DWORD>(-1L),
                                       body ? const_cast<char*>(body->data()) : WINHTTP_NO_REQUEST_DATA,
                                       body ? static_cast<DWORD>(body->size()) : 0,
                                       static_cast<DWORD>(body ? body->size() : 0), 0);
  if (!sent || !WinHttpReceiveResponse(request, nullptr)) {
    WinHttpCloseHandle(request);
    WinHttpCloseHandle(connect);
    WinHttpCloseHandle(session);
    return out;
  }

  DWORD status = 0;
  DWORD status_size = sizeof status;
  WinHttpQueryHeaders(request, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_HEADER_NAME_BY_INDEX,
                      &status, &status_size, WINHTTP_NO_HEADER_INDEX);
  out.status = static_cast<int>(status);
  out.content_type = query_header(request, WINHTTP_QUERY_CONTENT_TYPE);

  for (;;) {
    DWORD available = 0;
    if (!WinHttpQueryDataAvailable(request, &available) || available == 0) break;
    std::string chunk(available, '\0');
    DWORD read = 0;
    if (!WinHttpReadData(request, chunk.data(), available, &read)) break;
    chunk.resize(read);
    out.body += chunk;
  }

  out.ok = out.status >= 200 && out.status < 300;
  WinHttpCloseHandle(request);
  WinHttpCloseHandle(connect);
  WinHttpCloseHandle(session);
  return out;
}

}  // namespace

Result get(const std::wstring& url, int timeout_ms) { return send(L"GET", url, nullptr, timeout_ms); }

Result post(const std::wstring& url, const std::string& body, int timeout_ms) {
  return send(L"POST", url, &body, timeout_ms);
}

bool alive(const std::wstring& url, int timeout_ms) {
  const Result r = get(url, timeout_ms);
  return r.status > 0;
}

bool listening(int port) {
  WSADATA wsa{};
  if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) return true;  // cannot tell: the HTTP probe decides
  bool open = true;
  const SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (s != INVALID_SOCKET) {
    // Windows retries a refused loopback connection for about two seconds. With SYN retries off, a
    // closed port says so at once; libuv sets the same switch for the same reason.
    TCP_INITIAL_RTO_PARAMETERS rto{};
    rto.Rtt = TCP_INITIAL_RTO_UNSPECIFIED_RTT;
    rto.MaxSynRetransmissions = TCP_INITIAL_RTO_NO_SYN_RETRANSMISSIONS;
    DWORD bytes = 0;
    WSAIoctl(s, SIO_TCP_INITIAL_RTO, &rto, sizeof rto, nullptr, 0, &bytes, nullptr, nullptr);
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(static_cast<u_short>(port));
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    open = connect(s, reinterpret_cast<const sockaddr*>(&addr), sizeof addr) == 0;
    closesocket(s);
  }
  WSACleanup();
  return open;
}

}  // namespace net
