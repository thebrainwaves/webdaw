#include "Engine.h"
#include "Protocol.h"
#include <stdexcept>

namespace auduio
{
namespace
{
struct Fail : std::runtime_error { using std::runtime_error::runtime_error; };
[[noreturn]] void fail (const juce::String& m) { throw Fail (m.toStdString()); }
bool hiddenParamName (const juce::String& n) { return n.startsWith ("MIDI CC ") && n.containsChar ('|'); } // VST3 MIDI-CC emulation params

class Watcher : public juce::AudioProcessorParameter::Listener
{
public:
    Watcher (Engine& e, int i) : engine (e), id (i) {}
    void parameterValueChanged (int index, float value) override { engine.paramChangedFromPlugin (id, index, value, 0); }
    void parameterGestureChanged (int index, bool starting) override { engine.paramChangedFromPlugin (id, index, -1.0f, starting ? 1 : 2); }
private:
    Engine& engine; int id;
};

class EditorWindow : public juce::DocumentWindow
{
public:
    EditorWindow (const juce::String& title, std::function<void()> onClose)
        : juce::DocumentWindow (title, juce::Colour (0xff1b1b1b), juce::DocumentWindow::closeButton | juce::DocumentWindow::minimiseButton), closeFn (std::move (onClose))
    { setUsingNativeTitleBar (true); }
    void closeButtonPressed() override { if (closeFn) closeFn(); }
private:
    std::function<void()> closeFn;
};
} // namespace

Engine::Engine()
{
    juce::addDefaultFormatsToManager (formats);
    scanner = std::make_unique<Scanner> (formats);
    startTimerHz (20);
}
Engine::~Engine() { shutdown(); }

void Engine::shutdown()
{
    stopTimer();
    if (scanner) { scanner->cancel(); scanner.reset(); }
    devices.removeAudioCallback (this);
    devices.closeAudioDevice();
    std::vector<int> ids; for (auto& [id, _] : instances) ids.push_back (id);
    for (auto id : ids) unload (id);
    tracks.clear();
}

Track& Engine::track (const juce::String& id)
{
    if (id.isEmpty() || id.length() > 64) fail ("bad trackId");
    auto it = tracks.find (id);
    if (it != tracks.end()) return *it->second;
    auto t = std::make_unique<Track>(); t->id = id;
    t->scratch.setSize (2, juce::jmax (blockSize.load(), 4096));
    auto& ref = *t;
    const juce::ScopedLock sl (graphLock);
    tracks[id] = std::move (t);
    return ref;
}
Instance& Engine::inst (int id)
{
    auto it = instances.find (id);
    if (it == instances.end()) fail ("unknown instanceId " + juce::String (id));
    return *it->second;
}

juce::var Engine::deviceInfo()
{
    auto o = obj();
    auto* d = devices.getCurrentAudioDevice();
    o->setProperty ("open", d != nullptr);
    if (d)
    {
        o->setProperty ("type", d->getTypeName()); o->setProperty ("name", d->getName());
        o->setProperty ("sampleRate", d->getCurrentSampleRate()); o->setProperty ("bufferSize", d->getCurrentBufferSizeSamples());
        o->setProperty ("outputLatency", d->getOutputLatencyInSamples() / juce::jmax (1.0, d->getCurrentSampleRate()));
    }
    return v (o);
}
juce::var Engine::openDevice (const juce::var& a)
{
    auto type = str (a, "type"), name = str (a, "device");
    if (type.isNotEmpty()) devices.setCurrentAudioDeviceType (type, true);
    auto err = devices.initialise (0, 2, nullptr, true, name, nullptr);
    if (err.isNotEmpty()) fail ("audio device: " + err);
    auto setup = devices.getAudioDeviceSetup();
    if (a.hasProperty ("sampleRate")) setup.sampleRate = num (a, "sampleRate", 48000);
    if (a.hasProperty ("bufferSize")) setup.bufferSize = (int) num (a, "bufferSize", 512);
    if (name.isNotEmpty()) setup.outputDeviceName = name;
    err = devices.setAudioDeviceSetup (setup, true);
    if (err.isNotEmpty()) fail ("audio device: " + err);
    if (devices.getCurrentAudioDevice() == nullptr) fail ("no audio output device available");
    if (! deviceOpen) devices.addAudioCallback (this);
    deviceOpen = true;
    return deviceInfo();
}

void Engine::prepare (Instance& i)
{
    auto* p = i.plugin.get();
    p->setPlayHead (this);
    p->setRateAndBufferSizeDetails (sampleRate.load(), blockSize.load());
    p->prepareToPlay (sampleRate.load(), blockSize.load());
}

juce::var Engine::paramList (Instance& i)
{
    juce::Array<juce::var> arr;
    auto& ps = i.plugin->getParameters();
    for (int k = 0; k < ps.size() && k < 16384; ++k)
    {
        auto* p = ps[k];
        auto o = obj();
        auto name = p->getName (64);
        o->setProperty ("i", k);
        if (auto* hp = dynamic_cast<juce::HostedAudioProcessorParameter*> (p)) o->setProperty ("id", hp->getParameterID());
        o->setProperty ("name", name);
        o->setProperty ("label", p->getLabel());
        o->setProperty ("def", p->getDefaultValue());
        o->setProperty ("value", p->getValue());
        o->setProperty ("text", p->getCurrentValueAsText());
        o->setProperty ("steps", p->getNumSteps());
        o->setProperty ("discrete", p->isDiscrete());
        o->setProperty ("bool", p->isBoolean());
        o->setProperty ("automatable", p->isAutomatable());
        o->setProperty ("meta", p->isMetaParameter());
        o->setProperty ("category", (int) p->getCategory()); // 2 = output gain, 1 = input gain, >=3 meters
        if (hiddenParamName (name) || (int) p->getCategory() >= 3) o->setProperty ("hidden", true);
        if (p->isDiscrete() && p->getNumSteps() > 1 && p->getNumSteps() <= 64)
        {
            juce::Array<juce::var> opts; for (auto& s : p->getAllValueStrings()) opts.add (s);
            if (! opts.isEmpty()) o->setProperty ("options", opts);
        }
        arr.add (v (o));
    }
    return arr;
}

juce::var Engine::loadPlugin (const juce::var& a)
{
    auto uid = str (a, "uid");
    juce::PluginDescription desc;
    if (! scanner->find (uid, desc))
    {
        // allow loading straight from a file (tests / drag & drop of a .vst3)
        auto file = str (a, "file");
        if (file.isEmpty()) fail ("plugin not found (scan first): " + uid);
        juce::OwnedArray<juce::PluginDescription> found;
        for (auto* f : formats.getFormats()) if (f->fileMightContainThisPluginType (file)) f->findAllTypesForFile (found, file);
        if (found.isEmpty()) fail ("no plugin in " + file);
        desc = *found[0];
        for (auto* d : found) if (d->createIdentifierString() == uid || d->name == str (a, "name")) desc = *d;
    }
    juce::String err;
    auto plugin = formats.createPluginInstance (desc, sampleRate.load(), blockSize.load(), err);
    if (! plugin) fail ("could not load " + desc.name + ": " + err);
    auto in = std::make_unique<Instance>();
    in->id = nextId++; in->desc = desc; in->plugin = std::move (plugin);
    in->trackId = str (a, "trackId");
    // stereo out, and stereo in for effects
    auto* p = in->plugin.get();
    p->enableAllBuses();
    prepare (*in);
    in->watcher = std::make_unique<Watcher> (*this, in->id);
    for (auto* prm : p->getParameters()) prm->addListener (in->watcher.get());
    if (a.hasProperty ("state")) { juce::MemoryOutputStream mo; if (juce::Base64::convertFromBase64 (mo, str (a, "state"))) { auto mb = mo.getMemoryBlock(); p->setStateInformation (mb.getData(), (int) mb.getSize()); } }

    auto& t = track (in->trackId);
    auto slot = (int) num (a, "slot", -1);
    auto* raw = in.get();
    int channels = juce::jmax (2, p->getTotalNumInputChannels(), p->getTotalNumOutputChannels());
    {
        const juce::ScopedLock sl (graphLock);
        if (t.scratch.getNumChannels() < channels) t.scratch.setSize (channels, t.scratch.getNumSamples());
        if (slot < 0 || slot >= (int) t.chain.size()) t.chain.push_back (raw);
        else t.chain.insert (t.chain.begin() + slot, raw);
        instances[raw->id] = std::move (in);
    }
    auto o = obj();
    o->setProperty ("instanceId", raw->id);
    o->setProperty ("plugin", describe (desc));
    o->setProperty ("hasEditor", p->hasEditor());
    o->setProperty ("latency", p->getLatencySamples());
    o->setProperty ("inputs", p->getTotalNumInputChannels());
    o->setProperty ("outputs", p->getTotalNumOutputChannels());
    o->setProperty ("acceptsMidi", p->acceptsMidi());
    o->setProperty ("params", paramList (*raw));
    return v (o);
}

void Engine::unload (int id)
{
    auto it = instances.find (id);
    if (it == instances.end()) return;
    auto& i = *it->second;
    i.editorWindow.reset();
    for (auto* prm : i.plugin->getParameters()) prm->removeListener (i.watcher.get());
    std::unique_ptr<Instance> dead;
    {
        const juce::ScopedLock sl (graphLock);
        for (auto& [tid, t] : tracks) t->chain.erase (std::remove (t->chain.begin(), t->chain.end(), &i), t->chain.end());
        dead = std::move (it->second);
        instances.erase (it);
    }
    dead->plugin->releaseResources();
    dead.reset();
}

void Engine::audioDeviceAboutToStart (juce::AudioIODevice* d)
{
    sampleRate = d->getCurrentSampleRate();
    blockSize = d->getCurrentBufferSizeSamples();
    const juce::ScopedLock sl (graphLock);
    for (auto& [id, i] : instances) prepare (*i);
    for (auto& [id, t] : tracks) if (t->scratch.getNumSamples() < blockSize.load()) t->scratch.setSize (t->scratch.getNumChannels(), blockSize.load());
}
void Engine::audioDeviceStopped() {}

juce::Optional<juce::AudioPlayHead::PositionInfo> Engine::getPosition() const
{
    PositionInfo info;
    auto sr = sampleRate.load();
    auto now = sampleClock.load();
    info.setBpm (bpm.load());
    info.setTimeSignature (TimeSignature { sigNum.load(), sigDen.load() });
    info.setIsPlaying (playing.load());
    double ppq = ppqAtStart.load() + (playing.load() ? (double) (now - startSample.load()) / sr * bpm.load() / 60.0 : 0.0);
    info.setPpqPosition (ppq);
    info.setTimeInSamples (now); info.setTimeInSeconds ((double) now / sr);
    double barLen = sigNum.load() * 4.0 / juce::jmax (1, sigDen.load());
    info.setPpqPositionOfLastBarStart (std::floor (ppq / barLen) * barLen);
    return info;
}

void Engine::renderTrack (Track& t, int n, juce::int64 blockStart)
{
    t.block.clear();
    {
        const juce::ScopedTryLock ql (queueLock);
        if (ql.isLocked())
        {
            auto end = blockStart + n;
            auto& q = t.midi;
            size_t w = 0;
            for (size_t r = 0; r < q.size(); ++r)
            {
                if (q[r].sample < end) t.block.addEvent (q[r].msg, (int) juce::jlimit ((juce::int64) 0, (juce::int64) n - 1, q[r].sample - blockStart));
                else q[w++] = q[r];
            }
            q.resize (w); // shrinking never allocates
            auto& pq = t.params; size_t w2 = 0;
            for (size_t r = 0; r < pq.size(); ++r)
            {
                if (pq[r].sample < end)
                {
                    auto it = instances.find (pq[r].instance);
                    if (it != instances.end()) { auto& ps = it->second->plugin->getParameters(); if (juce::isPositiveAndBelow (pq[r].index, ps.size())) ps[pq[r].index]->setValue (pq[r].value); }
                }
                else pq[w2++] = pq[r];
            }
            pq.resize (w2);
        }
    }
    int ch = t.scratch.getNumChannels();
    juce::AudioBuffer<float> buf (t.scratch.getArrayOfWritePointers(), ch, juce::jmin (n, t.scratch.getNumSamples()));
    buf.clear();
    for (auto* i : t.chain)
    {
        auto* p = i->plugin.get();
        const juce::ScopedLock cl (p->getCallbackLock());
        if (p->isSuspended()) continue;
        int pch = juce::jmax (p->getTotalNumInputChannels(), p->getTotalNumOutputChannels());
        juce::AudioBuffer<float> view (buf.getArrayOfWritePointers(), juce::jmin (pch, ch), buf.getNumSamples());
        p->processBlock (view, t.block);
    }
}

void Engine::audioDeviceIOCallbackWithContext (const float* const*, int, float* const* out, int numOut, int n, const juce::AudioIODeviceCallbackContext&)
{
    for (int c = 0; c < numOut; ++c) if (out[c]) juce::FloatVectorOperations::clear (out[c], n);
    auto start = sampleClock.load();
    const juce::ScopedTryLock tl (graphLock);
    if (tl.isLocked())
    {
        for (auto& [id, tp] : tracks)
        {
            auto& t = *tp;
            if (t.offline || t.chain.empty()) continue;
            renderTrack (t, n, start);
            float g = t.mute ? 0.0f : t.gain.load(), pan = t.pan.load();
            float gl = g * juce::jmin (1.0f, 1.0f - pan), gr = g * juce::jmin (1.0f, 1.0f + pan);
            int m = juce::jmin (n, t.scratch.getNumSamples());
            auto* L = t.scratch.getReadPointer (0); auto* R = t.scratch.getReadPointer (t.scratch.getNumChannels() > 1 ? 1 : 0);
            float pl = 0, pr = 0;
            for (int s = 0; s < m; ++s) { pl = juce::jmax (pl, std::abs (L[s] * gl)); pr = juce::jmax (pr, std::abs (R[s] * gr)); }
            if (numOut >= 2 && out[0] && out[1]) { juce::FloatVectorOperations::addWithMultiply (out[0], L, gl, m); juce::FloatVectorOperations::addWithMultiply (out[1], R, gr, m); }
            else if (numOut == 1 && out[0]) { juce::FloatVectorOperations::addWithMultiply (out[0], L, gl * 0.5f, m); juce::FloatVectorOperations::addWithMultiply (out[0], R, gr * 0.5f, m); }
            t.peakL = juce::jmax (t.peakL.load(), pl); t.peakR = juce::jmax (t.peakR.load(), pr);
        }
    }
    sampleClock += n;
}

void Engine::paramChangedFromPlugin (int instance, int index, float value, int gesture)
{
    int s1, n1, s2, n2;
    fifo.prepareToWrite (1, s1, n1, s2, n2);
    if (n1 + n2 < 1) return; // UI is not keeping up: drop (the value is re-read on the next full refresh)
    int slot = n1 > 0 ? s1 : s2;
    fifoData[(size_t) slot] = { 0, instance, index, value };
    fifoGesture[(size_t) slot] = gesture;
    fifo.finishedWrite (1);
}

void Engine::timerCallback()
{
    // plugin editor -> UI parameter changes (coalesced per parameter)
    std::map<int, std::map<int, float>> changes;
    std::map<int, juce::Array<juce::var>> gestures;
    int s1, n1, s2, n2;
    fifo.prepareToRead (fifo.getNumReady(), s1, n1, s2, n2);
    auto take = [&] (int start, int count) {
        for (int k = start; k < start + count; ++k)
        {
            auto& e = fifoData[(size_t) k];
            if (fifoGesture[(size_t) k] == 0) changes[e.instance][e.index] = e.value;
            else { juce::Array<juce::var> g; g.add (e.index); g.add (fifoGesture[(size_t) k]); gestures[e.instance].add (juce::var (g)); }
        }
    };
    take (s1, n1); take (s2, n2);
    fifo.finishedRead (n1 + n2);
    for (auto& [id, m] : changes)
    {
        auto it = instances.find (id); if (it == instances.end()) continue;
        auto& ps = it->second->plugin->getParameters();
        juce::Array<juce::var> list;
        for (auto& [idx, val] : m)
        {
            juce::Array<juce::var> e; e.add (idx); e.add (val);
            if (juce::isPositiveAndBelow (idx, ps.size())) e.add (ps[idx]->getText (val, 32));
            list.add (juce::var (e));
        }
        auto o = obj(); o->setProperty ("instanceId", id); o->setProperty ("changes", list);
        if (gestures.count (id)) o->setProperty ("gestures", gestures[id]);
        emit ("params", o);
    }
    for (auto& [id, g] : gestures) if (! changes.count (id)) { auto o = obj(); o->setProperty ("instanceId", id); o->setProperty ("changes", juce::Array<juce::var>()); o->setProperty ("gestures", g); emit ("params", o); }
    // meters (only while something is loaded)
    if (deviceOpen && ! tracks.empty())
    {
        auto m = obj(); bool any = false;
        for (auto& [id, t] : tracks)
        {
            if (t->chain.empty()) continue;
            juce::Array<juce::var> lr; lr.add (t->peakL.exchange (0.0f)); lr.add (t->peakR.exchange (0.0f));
            m->setProperty (id, lr); any = true;
        }
        if (any) { auto o = obj(); o->setProperty ("tracks", v (m)); emit ("meters", o); }
    }
}

juce::var Engine::renderOffline (const juce::var& a)
{
    auto& t = track (str (a, "trackId"));
    if (t.chain.empty()) fail ("track has no plugins");
    double sr = sampleRate.load();
    double seconds = juce::jlimit (0.05, 600.0, num (a, "seconds", 2.0));
    auto total = (juce::int64) (seconds * sr);
    int bs = blockSize.load();
    struct Ev { juce::int64 s; juce::MidiMessage m; };
    std::vector<Ev> evs;
    if (auto* notes = a.getProperty ("notes", {}).getArray())
        for (auto& nt : *notes)
        {
            int ch = juce::jlimit (1, 16, (int) num (nt, "ch", 1)), note = juce::jlimit (0, 127, (int) num (nt, "n", 60));
            auto vel = (juce::uint8) juce::jlimit (1, 127, (int) num (nt, "v", 100));
            double t0 = num (nt, "t", 0), d = num (nt, "d", 0.5);
            evs.push_back ({ (juce::int64) (t0 * sr), juce::MidiMessage::noteOn (ch, note, vel) });
            evs.push_back ({ (juce::int64) ((t0 + d) * sr), juce::MidiMessage::noteOff (ch, note) });
        }
    std::sort (evs.begin(), evs.end(), [] (const Ev& x, const Ev& y) { return x.s < y.s; });
    juce::AudioBuffer<float> outBuf (2, (int) total);
    outBuf.clear();
    const juce::ScopedLock sl (graphLock); // the device callback outputs silence while this runs
    t.offline = true;
    for (auto* i : t.chain) i->plugin->reset();
    size_t e = 0;
    juce::MidiBuffer mb;
    for (juce::int64 pos = 0; pos < total; pos += bs)
    {
        int n = (int) juce::jmin ((juce::int64) bs, total - pos);
        mb.clear();
        while (e < evs.size() && evs[e].s < pos + n) { mb.addEvent (evs[e].m, (int) juce::jmax ((juce::int64) 0, evs[e].s - pos)); ++e; }
        int ch = t.scratch.getNumChannels();
        juce::AudioBuffer<float> buf (t.scratch.getArrayOfWritePointers(), ch, n);
        buf.clear();
        for (auto* i : t.chain)
        {
            auto* p = i->plugin.get();
            int pch = juce::jmax (p->getTotalNumInputChannels(), p->getTotalNumOutputChannels());
            juce::AudioBuffer<float> view (buf.getArrayOfWritePointers(), juce::jmin (pch, ch), n);
            p->processBlock (view, mb);
        }
        for (int c = 0; c < 2; ++c) outBuf.copyFrom (c, (int) pos, buf, juce::jmin (c, ch - 1), 0, n);
    }
    for (auto* i : t.chain) i->plugin->reset();
    t.offline = false;
    auto o = obj();
    float peak = outBuf.getMagnitude (0, outBuf.getNumSamples());
    double rms = 0.5 * (outBuf.getRMSLevel (0, 0, outBuf.getNumSamples()) + outBuf.getRMSLevel (1, 0, outBuf.getNumSamples()));
    o->setProperty ("peak", peak); o->setProperty ("rms", rms); o->setProperty ("samples", (juce::int64) total); o->setProperty ("sampleRate", sr);
    auto path = str (a, "wav");
    if (path.isNotEmpty())
    {
        if (! juce::File::isAbsolutePath (path) || ! path.endsWithIgnoreCase (".wav")) fail ("wav must be an absolute .wav path");
        juce::File f (path); f.deleteFile();
        juce::WavAudioFormat wav;
        std::unique_ptr<juce::OutputStream> os (f.createOutputStream());
        if (! os) fail ("cannot write " + path);
        auto opts = juce::AudioFormatWriterOptions{}.withSampleRate (sr).withNumChannels (2).withBitsPerSample (24);
        auto w = wav.createWriterFor (os, opts);
        if (! w) fail ("cannot create wav writer");
        w->writeFromAudioSampleBuffer (outBuf, 0, outBuf.getNumSamples());
        o->setProperty ("wav", path);
    }
    return v (o);
}

juce::var Engine::handle (const juce::String& cmd, const juce::var& a)
{
    if (cmd == "hello" || cmd == "ping")
    {
        auto o = obj();
        o->setProperty ("engine", "auduio-engine"); o->setProperty ("version", AUDUIO_ENGINE_VERSION); o->setProperty ("protocol", kProtocolVersion);
        o->setProperty ("juce", juce::SystemStats::getJUCEVersion()); o->setProperty ("os", juce::SystemStats::getOperatingSystemName());
        juce::Array<juce::var> f; for (auto* x : formats.getFormats()) f.add (x->getName()); o->setProperty ("formats", f);
        o->setProperty ("sampleRate", sampleRate.load()); o->setProperty ("blockSize", blockSize.load());
        o->setProperty ("device", deviceInfo());
        o->setProperty ("dataDir", dataDir().getFullPathName());
        return v (o);
    }
    if (cmd == "clock")
    {
        auto o = obj(); auto s = sampleClock.load();
        o->setProperty ("samples", s); o->setProperty ("sampleRate", sampleRate.load()); o->setProperty ("seconds", (double) s / sampleRate.load());
        o->setProperty ("running", deviceOpen);
        return v (o);
    }
    if (cmd == "audio.devices")
    {
        juce::Array<juce::var> types;
        for (auto* type : devices.getAvailableDeviceTypes())
        {
            type->scanForDevices();
            auto o = obj(); o->setProperty ("type", type->getTypeName());
            juce::Array<juce::var> outs; for (auto& n : type->getDeviceNames (false)) outs.add (n);
            o->setProperty ("outputs", outs); types.add (v (o));
        }
        auto o = obj(); o->setProperty ("types", types); o->setProperty ("current", deviceInfo());
        return v (o);
    }
    if (cmd == "audio.open") return openDevice (a);
    if (cmd == "audio.close") { devices.removeAudioCallback (this); devices.closeAudioDevice(); deviceOpen = false; return deviceInfo(); }
    if (cmd == "scan")
    {
        juce::StringArray extra;
        if (auto* p = a.getProperty ("paths", {}).getArray()) for (auto& x : *p) if (x.isString() && juce::File::isAbsolutePath (x.toString())) extra.add (x.toString());
        auto started = scanner->start (extra, (bool) a.getProperty ("rescan", false), (int) num (a, "timeoutMs", 30000));
        auto o = obj(); o->setProperty ("started", started); o->setProperty ("scanning", scanner->isScanning());
        return v (o);
    }
    if (cmd == "scan.cancel") { scanner->cancel(); return true; }
    if (cmd == "plugins.list") return scanner->cacheAsVar();
    if (cmd == "track.set")
    {
        auto& t = track (str (a, "trackId"));
        if (a.hasProperty ("gainDb")) { auto db = num (a, "gainDb", 0); t.gain = db <= -100 ? 0.0f : (float) juce::Decibels::decibelsToGain (juce::jmin (12.0, db)); }
        if (a.hasProperty ("pan")) t.pan = (float) juce::jlimit (-1.0, 1.0, num (a, "pan", 0));
        if (a.hasProperty ("mute")) t.mute = (bool) a.getProperty ("mute", false);
        return true;
    }
    if (cmd == "track.remove")
    {
        auto id = str (a, "trackId"); auto it = tracks.find (id);
        if (it != tracks.end()) { auto chain = it->second->chain; for (auto* i : chain) unload (i->id); const juce::ScopedLock sl (graphLock); tracks.erase (id); }
        return true;
    }
    if (cmd == "plugin.load") return loadPlugin (a);
    if (cmd == "plugin.unload") { unload ((int) num (a, "instanceId", -1)); return true; }
    if (cmd == "plugin.params") return paramList (inst ((int) num (a, "instanceId", -1)));
    if (cmd == "param.set" || cmd == "param.setMany")
    {
        auto& i = inst ((int) num (a, "instanceId", -1));
        auto& ps = i.plugin->getParameters();
        juce::Array<juce::var> vals;
        if (cmd == "param.set") { juce::Array<juce::var> e; e.add (a.getProperty ("index", -1)); e.add (a.getProperty ("value", 0)); vals.add (juce::var (e)); }
        else if (auto* arr = a.getProperty ("values", {}).getArray()) vals = *arr;
        bool timed = a.hasProperty ("t"), notify = (bool) a.getProperty ("notify", false);
        auto when = (juce::int64) (num (a, "t", 0) * sampleRate.load());
        juce::Array<juce::var> texts;
        {
            const juce::ScopedLock ql (queueLock);
            for (auto& e : vals)
            {
                int idx = (int) e[0]; float val = (float) juce::jlimit (0.0, 1.0, (double) e[1]);
                if (! juce::isPositiveAndBelow (idx, ps.size())) continue;
                if (timed) tracks[i.trackId]->params.push_back ({ when, i.id, idx, val });
                else if (notify) ps[idx]->setValueNotifyingHost (val); // as if moved in the plugin: reported in `params` events
                else ps[idx]->setValue (val);
            }
        }
        if (! timed) for (auto& e : vals) { int idx = (int) e[0]; if (juce::isPositiveAndBelow (idx, ps.size())) texts.add (ps[idx]->getCurrentValueAsText()); }
        auto o = obj(); o->setProperty ("texts", texts); return v (o);
    }
    if (cmd == "editor.open")
    {
        auto& i = inst ((int) num (a, "instanceId", -1));
        if (i.editorWindow) { i.editorWindow->toFront (true); return true; }
        if (! i.plugin->hasEditor()) fail (i.desc.name + " has no editor window");
        if (juce::Desktop::getInstance().getDisplays().getPrimaryDisplay() == nullptr) fail ("no display available for plugin windows");
        auto* ed = i.plugin->createEditorIfNeeded();
        if (! ed) fail ("the plugin did not create an editor");
        int id = i.id;
        i.editorWindow = std::make_unique<EditorWindow> (i.desc.name + " - Auduio", [this, id] {
            juce::MessageManager::callAsync ([this, id] {
                auto it = instances.find (id); if (it == instances.end()) return;
                it->second->editorWindow.reset();
                auto o = obj(); o->setProperty ("instanceId", id); emit ("editor.closed", o);
            });
        });
        i.editorWindow->setContentOwned (ed, true);
        i.editorWindow->setResizable (ed->isResizable(), false);
        i.editorWindow->centreWithSize (i.editorWindow->getWidth(), i.editorWindow->getHeight());
        i.editorWindow->setVisible (true);
        i.editorWindow->toFront (true);
        auto o = obj(); o->setProperty ("width", ed->getWidth()); o->setProperty ("height", ed->getHeight()); return v (o);
    }
    if (cmd == "editor.close") { auto& i = inst ((int) num (a, "instanceId", -1)); i.editorWindow.reset(); return true; }
    if (cmd == "state.get")
    {
        auto& i = inst ((int) num (a, "instanceId", -1));
        juce::MemoryBlock mb; i.plugin->getStateInformation (mb);
        auto o = obj(); o->setProperty ("data", juce::Base64::toBase64 (mb.getData(), mb.getSize())); o->setProperty ("bytes", (int) mb.getSize()); return v (o); // standard base64 (RFC 4648)
    }
    if (cmd == "state.set")
    {
        auto& i = inst ((int) num (a, "instanceId", -1));
        juce::MemoryOutputStream mo; if (! juce::Base64::convertFromBase64 (mo, str (a, "data"))) fail ("bad state data"); auto mb = mo.getMemoryBlock();
        i.plugin->setStateInformation (mb.getData(), (int) mb.getSize());
        auto o = obj(); o->setProperty ("params", paramList (i)); return v (o);
    }
    if (cmd == "midi")
    {
        auto& t = track (str (a, "trackId"));
        auto sr = sampleRate.load(); auto now = sampleClock.load();
        const juce::ScopedLock ql (queueLock);
        if (auto* evs = a.getProperty ("events", {}).getArray())
            for (auto& e : *evs)
            {
                auto* d = e.getProperty ("d", {}).getArray();
                if (! d || d->isEmpty() || d->size() > 3) continue;
                int b[3] = { 0, 0, 0 }; for (int k = 0; k < d->size(); ++k) b[k] = juce::jlimit (0, 255, (int) (*d)[k]);
                if (b[0] < 0x80 || b[0] >= 0xF0) continue; // channel messages only
                auto s = e.hasProperty ("t") ? (juce::int64) (num (e, "t", 0) * sr) : now;
                t.midi.push_back ({ juce::jmax (s, now), juce::MidiMessage (b[0], b[1], b[2]) });
            }
        if (t.midi.size() > 100000) t.midi.erase (t.midi.begin(), t.midi.begin() + (long) (t.midi.size() - 100000));
        return true;
    }
    if (cmd == "notesOff")
    {
        auto only = str (a, "trackId"); auto now = sampleClock.load();
        const juce::ScopedLock ql (queueLock);
        for (auto& [id, t] : tracks)
        {
            if (only.isNotEmpty() && id != only) continue;
            t->midi.clear();
            for (int ch = 1; ch <= 16; ++ch) { t->midi.push_back ({ now, juce::MidiMessage::allNotesOff (ch) }); t->midi.push_back ({ now, juce::MidiMessage::allSoundOff (ch) }); }
        }
        return true;
    }
    if (cmd == "transport")
    {
        if (a.hasProperty ("bpm")) bpm = juce::jlimit (20.0, 999.0, num (a, "bpm", 120));
        if (a.hasProperty ("num")) sigNum = juce::jlimit (1, 32, (int) num (a, "num", 4));
        if (a.hasProperty ("den")) sigDen = juce::jlimit (1, 32, (int) num (a, "den", 4));
        if (a.hasProperty ("playing"))
        {
            ppqAtStart = num (a, "ppq", 0);
            startSample = a.hasProperty ("t") ? (juce::int64) (num (a, "t", 0) * sampleRate.load()) : sampleClock.load();
            playing = (bool) a.getProperty ("playing", false);
        }
        return true;
    }
    if (cmd == "render") return renderOffline (a);
    if (cmd == "quit") { juce::MessageManager::callAsync ([] { if (! juce::MessageManager::getInstance()->hasStopMessageBeenSent()) juce::JUCEApplicationBase::quit(); }); return true; }
    fail ("unknown command: " + cmd);
}
} // namespace auduio
