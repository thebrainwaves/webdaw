// Newline-delimited JSON over stdin/stdout. One JSON object per line.
//   request : {"id": 7, "cmd": "plugin.load", ...args}
//   response: {"id": 7, "ok": true, "result": {...}}  or  {"id": 7, "ok": false, "error": "..."}
//   event   : {"event": "scan.progress", ...}
// stdout carries protocol lines only; logs go to stderr.
#pragma once
#include <JuceHeader.h>

namespace auduio
{
constexpr int kProtocolVersion = 1;
constexpr int kMaxLineBytes = 8 * 1024 * 1024; // plugin state chunks travel base64-encoded

void writeLine (const juce::var& obj);                         // thread-safe
void reply (const juce::var& id, const juce::var& result);
void replyError (const juce::var& id, const juce::String& message);
void emit (const juce::String& event, juce::DynamicObject::Ptr payload = nullptr);
void log (const juce::String& message);                         // stderr

juce::DynamicObject::Ptr obj();
inline juce::var v (juce::DynamicObject::Ptr o) { return juce::var (o.get()); }
double num (const juce::var& o, const char* key, double def);
juce::String str (const juce::var& o, const char* key, const juce::String& def = {});
} // namespace auduio
