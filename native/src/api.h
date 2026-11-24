// One request in, one response out. Routes that are pure Win32 live here; the rest go to the
// engine until they are ported, so the UI never learns which side answered.
#pragma once

#include <windows.h>

#include <functional>
#include <string>

namespace api {

struct Request {
  std::string method;
  std::string path;   // starts with /api/ or /img/
  std::string body;
};

struct Response {
  int status = 200;
  std::string body;
  std::string content_type = "application/json; charset=utf-8";
  std::string cache = "no-store";
};

void set_owner(HWND window);
void set_engine_port(int port);

// Text size is a window preference like geometry, so the shell applies and stores it; the route
// only validates the number and reports what came back.
using Zoom = std::function<int(int percent)>;
void set_zoom(Zoom handler);
void set_zoom_level(int percent);  // the value restored at startup, so /api/status is honest

// A folder picker is a Win32 dialog: it has to be shown on the UI thread, which owns the
// apartment and the message pump, and it should open on the folder the row already points at.
// The route works out that folder and hands both over; an empty answer means the person cancelled.
using Picker = std::function<std::wstring(const std::wstring& title, const std::wstring& start)>;
void set_picker(Picker handler);

Response handle(const Request& request);

}  // namespace api
