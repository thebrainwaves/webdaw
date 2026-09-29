// Plugin scanning. Every plugin file is probed in its own child process ("auduio-engine --scan-one ..."),
// so a plugin that crashes or hangs while loading cannot take down the engine (or the app). Crashing /
// hanging files are remembered in a block list and skipped until the user asks for a full rescan.
#pragma once
#include <JuceHeader.h>

namespace auduio
{
struct ScanResult { juce::Array<juce::var> plugins; juce::Array<juce::var> failed; };

juce::var describe (const juce::PluginDescription&);          // PluginDescription -> JSON
bool descriptionFromVar (const juce::var&, juce::PluginDescription&);
juce::File dataDir();                                          // where the scan cache lives
juce::StringArray defaultSearchPaths (juce::AudioPluginFormat&);

// child mode: probe one file, write a JSON array of descriptions to outFile. Returns the process exit code.
int scanOneMain (const juce::String& formatName, const juce::String& fileOrId, const juce::File& outFile);

class Scanner : private juce::Thread
{
public:
    explicit Scanner (juce::AudioPluginFormatManager& fm);
    ~Scanner() override;
    // start a background scan. extraPaths are added to the default folders. rescan = also retry blocked files
    bool start (const juce::StringArray& extraPaths, bool rescan, int timeoutMs);
    bool isScanning() const { return isThreadRunning(); }
    void cancel() { signalThreadShouldExit(); }
    juce::var cacheAsVar() const;                       // { plugins: [...], failed: [...], paths: [...] }
    bool find (const juce::String& uid, juce::PluginDescription& out) const;
    void loadCache();

private:
    void run() override;
    void saveCache();
    juce::AudioPluginFormatManager& formats;
    mutable juce::CriticalSection lock;
    juce::Array<juce::var> plugins, failed;             // guarded by lock
    juce::StringArray paths, extra;
    bool rescanAll = false;
    int timeout = 30000;
};
} // namespace auduio
