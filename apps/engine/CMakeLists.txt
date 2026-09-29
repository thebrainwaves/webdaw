# auduio-engine: native audio engine sidecar for the Auduio desktop app (Tauri).
# Hosts VST3 (all platforms) and AudioUnit (macOS) plugins with JUCE, talks to the app over stdin/stdout
# (newline-delimited JSON, see ../docs/PLUGIN-HOSTING.md) and scans plugins in separate child processes.
#
#   cmake -S engine -B engine/build -G Ninja -DCMAKE_BUILD_TYPE=Release [-DJUCE_DIR=/path/to/JUCE]
#   cmake --build engine/build --config Release
cmake_minimum_required(VERSION 3.22)
project(AuduioEngine VERSION 0.4.0 LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(APPLE)
  set(CMAKE_OSX_DEPLOYMENT_TARGET "10.15" CACHE STRING "")
endif()
if(MSVC)
  # static CRT: the sidecar runs next to the app without an extra VC++ redistributable
  set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
endif()

set(JUCE_DIR "" CACHE PATH "Path to a JUCE checkout (otherwise JUCE 8.0.12 is downloaded)")
if(JUCE_DIR)
  add_subdirectory(${JUCE_DIR} juce EXCLUDE_FROM_ALL)
else()
  include(FetchContent)
  FetchContent_Declare(juce GIT_REPOSITORY https://github.com/juce-framework/JUCE.git GIT_TAG 8.0.12 GIT_SHALLOW ON)
  FetchContent_MakeAvailable(juce)
endif()

# a console app (plain executable, stdio pipes) that still runs the JUCE message loop so plugin editors work
juce_add_console_app(auduio-engine PRODUCT_NAME "auduio-engine" VERSION ${PROJECT_VERSION}
  COMPANY_NAME "thebrainwaves" BUNDLE_ID "com.thebrainwaves.auduio.engine")
juce_generate_juce_header(auduio-engine)
target_sources(auduio-engine PRIVATE src/Main.cpp src/Engine.cpp src/Scanner.cpp src/Protocol.cpp)
target_compile_definitions(auduio-engine PRIVATE
  JUCE_PLUGINHOST_VST3=1
  JUCE_PLUGINHOST_AU=$<IF:$<BOOL:${APPLE}>,1,0>
  JUCE_PLUGINHOST_LADSPA=0
  JUCE_PLUGINHOST_LV2=0
  JUCE_WEB_BROWSER=0
  JUCE_USE_CURL=0
  JUCE_LOAD_CURL_SYMBOLS_LAZILY=1
  JUCE_REPORT_APP_USAGE=0
  JUCE_USE_FLAC=0 JUCE_USE_OGGVORBIS=0 JUCE_USE_MP3AUDIOFORMAT=0 JUCE_USE_LAME_AUDIO_FORMAT=0 JUCE_USE_WINDOWS_MEDIA_FORMAT=0
  JUCE_ASIO=0
  JUCE_JACK=0
  JUCE_APPLICATION_NAME_STRING="$<TARGET_PROPERTY:auduio-engine,JUCE_PRODUCT_NAME>"
  JUCE_APPLICATION_VERSION_STRING="$<TARGET_PROPERTY:auduio-engine,JUCE_VERSION>"
  AUDUIO_ENGINE_VERSION="${PROJECT_VERSION}")
target_link_libraries(auduio-engine PRIVATE
  juce::juce_audio_utils juce::juce_audio_processors juce::juce_audio_devices juce::juce_audio_formats juce::juce_gui_extra
  juce::juce_recommended_config_flags juce::juce_recommended_warning_flags)
if(WIN32)
  target_link_libraries(auduio-engine PRIVATE juce::juce_recommended_lto_flags)
endif()
