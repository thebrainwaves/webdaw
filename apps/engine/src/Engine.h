// The native engine: plugin instances grouped into tracks, rendered in the audio device callback and
// mixed straight to the audio output. The web app sends MIDI with engine timestamps (see "clock"), mix
// settings and parameter changes; the engine reports parameter changes made in plugin editors, meters and
// crashes. Tracks can also be rendered offline (bounce / export / tests) without an audio device.
#pragma once
#include <JuceHeader.h>
#include "Scanner.h"

namespace auduio
{
struct TimedMidi { juce::int64 sample; juce::MidiMessage msg; };
struct TimedParam { juce::int64 sample; int instance; int index; float value; };

struct Instance
{
    int id = 0;
    juce::String trackId;
    std::unique_ptr<juce::AudioPluginInstance> plugin;
    std::unique_ptr<juce::DocumentWindow> editorWindow;
    std::unique_ptr<juce::AudioProcessorParameter::Listener> watcher;
    juce::PluginDescription desc;
};

struct Track
{
    juce::String id;
    std::vector<Instance*> chain;              // [0] = instrument (or first effect), then effects; owned by Engine::instances
    std::atomic<float> gain { 1.0f }, pan { 0.0f };
    std::atomic<bool> mute { false }, offline { false };
    std::vector<TimedMidi> midi;               // guarded by Engine::queueLock
    std::vector<TimedParam> params;            // guarded by Engine::queueLock
    std::atomic<float> peakL { 0 }, peakR { 0 };
    juce::AudioBuffer<float> scratch;
    juce::MidiBuffer block;
};

class Engine : public juce::AudioIODeviceCallback, private juce::Timer, public juce::AudioPlayHead
{
public:
    Engine();
    ~Engine() override;
    juce::var handle (const juce::String& cmd, const juce::var& args); // message thread; throws std::runtime_error
    void shutdown();

    // AudioIODeviceCallback
    void audioDeviceIOCallbackWithContext (const float* const*, int, float* const*, int, int, const juce::AudioIODeviceCallbackContext&) override;
    void audioDeviceAboutToStart (juce::AudioIODevice*) override;
    void audioDeviceStopped() override;
    // AudioPlayHead
    juce::Optional<PositionInfo> getPosition() const override;

    void paramChangedFromPlugin (int instance, int index, float value, int gesture); // any thread
private:
    void timerCallback() override;
    Track& track (const juce::String& id);
    Instance& inst (int id);
    juce::var paramList (Instance&);
    juce::var loadPlugin (const juce::var& args);
    void unload (int id);
    void prepare (Instance&);
    void renderTrack (Track&, int numSamples, juce::int64 blockStart);
    juce::var renderOffline (const juce::var& args);
    juce::var openDevice (const juce::var& args);
    juce::var deviceInfo();

    juce::AudioPluginFormatManager formats;
    std::unique_ptr<Scanner> scanner;
    juce::AudioDeviceManager devices;
    bool deviceOpen = false;
    std::map<int, std::unique_ptr<Instance>> instances;
    std::map<juce::String, std::unique_ptr<Track>> tracks;
    juce::CriticalSection graphLock;            // tracks/chains structure (audio thread try-locks)
    juce::CriticalSection queueLock;            // midi/param queues
    std::atomic<juce::int64> sampleClock { 0 };
    std::atomic<double> sampleRate { 48000.0 };
    std::atomic<int> blockSize { 512 };
    int nextId = 1;
    // transport for tempo-synced plugins
    std::atomic<bool> playing { false };
    std::atomic<double> bpm { 120.0 }, ppqAtStart { 0.0 };
    std::atomic<juce::int64> startSample { 0 };
    std::atomic<int> sigNum { 4 }, sigDen { 4 };
    // plugin -> UI parameter change queue
    juce::AbstractFifo fifo { 4096 };
    std::array<TimedParam, 4096> fifoData;
    std::array<int, 4096> fifoGesture;
};
} // namespace auduio
