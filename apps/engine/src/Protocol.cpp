#include "Protocol.h"
#include <cstdio>

namespace auduio
{
static juce::CriticalSection outLock;

void writeLine (const juce::var& o)
{
    auto s = juce::JSON::toString (o, juce::JSON::FormatOptions{}.withSpacing (juce::JSON::Spacing::none));
    const juce::ScopedLock sl (outLock);
    std::fwrite (s.toRawUTF8(), 1, s.getNumBytesAsUTF8(), stdout);
    std::fputc ('\n', stdout);
    std::fflush (stdout);
}
void reply (const juce::var& id, const juce::var& result)
{
    auto o = obj(); o->setProperty ("id", id); o->setProperty ("ok", true); o->setProperty ("result", result);
    writeLine (v (o));
}
void replyError (const juce::var& id, const juce::String& message)
{
    auto o = obj(); o->setProperty ("id", id); o->setProperty ("ok", false); o->setProperty ("error", message);
    writeLine (v (o));
}
void emit (const juce::String& event, juce::DynamicObject::Ptr payload)
{
    auto o = payload != nullptr ? payload : obj();
    o->setProperty ("event", event);
    writeLine (v (o));
}
void log (const juce::String& m)
{
    const juce::ScopedLock sl (outLock);
    std::fprintf (stderr, "[auduio-engine] %s\n", m.toRawUTF8());
    std::fflush (stderr);
}
juce::DynamicObject::Ptr obj() { return new juce::DynamicObject(); }
double num (const juce::var& o, const char* key, double def)
{
    auto x = o.getProperty (key, juce::var());
    if (x.isDouble() || x.isInt() || x.isInt64() || x.isBool()) { double d = (double) x; return std::isfinite (d) ? d : def; }
    return def;
}
juce::String str (const juce::var& o, const char* key, const juce::String& def)
{
    auto x = o.getProperty (key, juce::var());
    return x.isString() ? x.toString() : def;
}
} // namespace auduio
