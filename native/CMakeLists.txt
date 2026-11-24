cmake_minimum_required(VERSION 3.20)
project(SteaMar LANGUAGES CXX RC)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

# WebView2 ships as a NuGet package; the SDK copy is already in the user's cache.
set(WEBVIEW2_ROOT "$ENV{USERPROFILE}/.nuget/packages/microsoft.web.webview2/1.0.3405.78/build/native"
    CACHE PATH "folder holding include/WebView2.h and x64/WebView2LoaderStatic.lib")
if(NOT EXISTS "${WEBVIEW2_ROOT}/include/WebView2.h")
  message(FATAL_ERROR "WebView2 SDK not found in ${WEBVIEW2_ROOT} - set -DWEBVIEW2_ROOT=<path>")
endif()

add_executable(steamar WIN32
  src/app.cpp
  src/core.cpp
  src/config.cpp
  src/net.cpp
  src/api.cpp
  src/steamar.rc     # icon and version block, so the exe is the app everywhere Windows shows one
)

target_include_directories(steamar PRIVATE src "${WEBVIEW2_ROOT}/include")
target_compile_definitions(steamar PRIVATE UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN)
target_compile_options(steamar PRIVATE /W4 /permissive- /utf-8 /EHsc)

target_link_libraries(steamar PRIVATE
  "${WEBVIEW2_ROOT}/x64/WebView2LoaderStatic.lib"
  user32 gdi32 shell32 ole32 oleaut32 shlwapi dwmapi advapi32 winhttp ws2_32 version
)

set_target_properties(steamar PROPERTIES OUTPUT_NAME "SteaMar")

# Everything the app needs at runtime lives beside the exe; copying the UI in keeps a
# published build self-contained instead of pointing back at the source tree.
add_custom_command(TARGET steamar POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E copy_directory
          "${CMAKE_CURRENT_SOURCE_DIR}/../ui" "$<TARGET_FILE_DIR:steamar>/ui"
  COMMENT "copying ui/ next to the exe")
