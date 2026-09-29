#include "Scanner.h"
#include "Protocol.h"

namespace auduio
{
juce::var describe (const juce::PluginDescription& d)
{
    auto o = obj();
    o->setProperty ("uid", d.createIdentifierString());
    o->setProperty ("name", d.name);
    o->setProperty ("descriptiveName", d.descriptiveName);
    o->setProperty ("format", d.pluginFormatName);
    o->setProperty ("category", d.category);
    o->setProperty ("vendor", d.manufacturerName);
    o->setProperty ("version", d.version);
    o->setProperty ("file", d.fileOrIdentifier);
    o->setProperty ("uniqueId", d.uniqueId);
    o->setProperty ("deprecatedUid", d.deprecatedUid);
    o->setProperty ("isInstrument", d.isInstrument);
    o->setProperty ("inputs", d.numInputChannels);
    o->setProperty ("outputs", d.numOutputChannels);
    o->setProperty ("modified", d.lastFileModTime.toMilliseconds());
    return v (o);
}
bool descriptionFromVar (const juce::var& x, juce::PluginDescription& d)
{
    if (! x.isObject()) return false;
    d.name = str (x, "name"); d.descriptiveName = str (x, "descriptiveName"); d.pluginFormatName = str (x, "format");
    d.category = str (x, "category"); d.manufacturerName = str (x, "vendor"); d.version = str (x, "version");
    d.fileOrIdentifier = str (x, "file"); d.uniqueId = (int) num (x, "uniqueId", 0); d.deprecatedUid = (int) num (x, "deprecatedUid", 0);
    d.isInstrument = (bool) x.getProperty ("isInstrument", false); d.numInputChannels = (int) num (x, "inputs", 0); d.numOutputChannels = (int) num (x, "outputs", 2);
    d.lastFileModTime = juce::Time ((juce::int64) num (x, "modified", 0));
    return d.name.isNotEmpty() && d.fileOrIdentifier.isNotEmpty();
}
juce::File dataDir()
{
    auto env = juce::SystemStats::getEnvironmentVariable ("AUDUIO_ENGINE_DATA", {});
    auto dir = env.isNotEmpty() ? juce::File (env) : juce::File::getSpecialLocation (juce::File::userApplicationDataDirectory).getChildFile ("Auduio");
    dir.createDirectory();
    return dir;
}
juce::StringArray defaultSearchPaths (juce::AudioPluginFormat& f)
{
    juce::StringArray out;
    auto p = f.getDefaultLocationsToSearch();
    for (int i = 0; i < p.getNumPaths(); ++i) out.add (p.getRawString (i));
   #if JUCE_WINDOWS
    if (f.getName() == "VST3")
    {
        // the standard folder (C:\Program Files\Common Files\VST3) is in JUCE's defaults; add the per-user one too
        auto local = juce::File::getSpecialLocation (juce::File::windowsLocalAppData).getChildFile ("Programs\\Common\\VST3");
        out.addIfNotAlreadyThere (local.getFullPathName());
    }
   #endif
    auto env = juce::SystemStats::getEnvironmentVariable ("AUDUIO_" + f.getName().toUpperCase() + "_PATH", {});
    if (env.isNotEmpty()) out.addTokens (env, juce::File::getSeparatorChar() == '\\' ? ";" : ":", {});
    out.removeEmptyStrings(); out.removeDuplicates (false);
    return out;
}

int scanOneMain (const juce::String& formatName, const juce::String& fileOrId, const juce::File& outFile)
{
    juce::AudioPluginFormatManager fm;
    juce::addDefaultFormatsToManager (fm);
    for (auto* f : fm.getFormats())
    {
        if (f->getName() != formatName) continue;
        juce::OwnedArray<juce::PluginDescription> found;
        f->findAllTypesForFile (found, fileOrId);
        juce::Array<juce::var> arr;
        for (auto* d : found) arr.add (describe (*d));
        outFile.replaceWithText (juce::JSON::toString (juce::var (arr)));
        return found.isEmpty() ? 2 : 0;
    }
    return 3;
}

Scanner::Scanner (juce::AudioPluginFormatManager& fm) : juce::Thread ("auduio plugin scanner"), formats (fm) { loadCache(); }
Scanner::~Scanner() { stopThread (5000); }

void Scanner::loadCache()
{
    auto j = juce::JSON::parse (dataDir().getChildFile ("plugin-cache.json"));
    const juce::ScopedLock sl (lock);
    plugins.clear(); failed.clear();
    if (auto* a = j.getProperty ("plugins", {}).getArray()) plugins = *a;
    if (auto* b = j.getProperty ("failed", {}).getArray()) failed = *b;
}
void Scanner::saveCache()
{
    auto o = obj();
    { const juce::ScopedLock sl (lock); o->setProperty ("plugins", plugins); o->setProperty ("failed", failed); }
    o->setProperty ("version", kProtocolVersion);
    dataDir().getChildFile ("plugin-cache.json").replaceWithText (juce::JSON::toString (v (o)));
}
juce::var Scanner::cacheAsVar() const
{
    auto o = obj();
    const juce::ScopedLock sl (lock);
    o->setProperty ("plugins", plugins); o->setProperty ("failed", failed);
    juce::Array<juce::var> p; for (auto& s : paths) p.add (s); o->setProperty ("paths", p);
    o->setProperty ("scanning", isThreadRunning());
    return v (o);
}
bool Scanner::find (const juce::String& uid, juce::PluginDescription& out) const
{
    const juce::ScopedLock sl (lock);
    for (auto& p : plugins)
        if (str (p, "uid") == uid && descriptionFromVar (p, out)) return true;
    return false;
}
bool Scanner::start (const juce::StringArray& extraPaths, bool rescan, int timeoutMs)
{
    if (isThreadRunning()) return false;
    extra = extraPaths; rescanAll = rescan; timeout = juce::jlimit (2000, 300000, timeoutMs);
    startThread();
    return true;
}

void Scanner::run()
{
    // collect candidate files per format
    struct Job { juce::String format, file; };
    juce::Array<Job> jobs;
    juce::StringArray allPaths;
    for (auto* f : formats.getFormats())
    {
        auto dirs = defaultSearchPaths (*f);
        dirs.addArray (extra);
        allPaths.addArray (dirs);
        juce::FileSearchPath sp;
        for (auto& d : dirs) if (juce::File::isAbsolutePath (d) && juce::File (d).isDirectory()) sp.add (juce::File (d));
        for (auto& file : f->searchPathsForPlugins (sp, true, false)) jobs.add ({ f->getName(), file });
    }
    allPaths.removeDuplicates (false);
    { const juce::ScopedLock sl (lock); paths = allPaths; }

    juce::Array<juce::var> newPlugins, newFailed;
    juce::Array<juce::var> oldPlugins, oldFailed;
    { const juce::ScopedLock sl (lock); oldPlugins = plugins; oldFailed = failed; }
    auto exe = juce::File::getSpecialLocation (juce::File::currentExecutableFile);
    int done = 0;
    for (auto& job : jobs)
    {
        if (threadShouldExit()) break;
        auto p = obj(); p->setProperty ("done", done); p->setProperty ("total", jobs.size()); p->setProperty ("current", job.file);
        emit ("scan.progress", p);
        ++done;
        auto mod = juce::File (job.file).getLastModificationTime().toMilliseconds();
        // unchanged file already known: reuse
        bool reused = false;
        for (auto& op : oldPlugins)
            if (str (op, "file") == job.file && (juce::int64) num (op, "modified", -1) == mod && ! rescanAll) { newPlugins.add (op); reused = true; }
        if (reused) continue;
        if (! rescanAll)
        {
            bool blocked = false;
            for (auto& of : oldFailed) if (str (of, "file") == job.file && (juce::int64) num (of, "modified", -1) == mod) { newFailed.add (of); blocked = true; }
            if (blocked) continue;
        }
        auto out = juce::File::createTempFile (".json");
        juce::ChildProcess child;
        juce::StringArray args { exe.getFullPathName(), "--scan-one", job.format, job.file, out.getFullPathName() };
        juce::String reason;
        if (! child.start (args, 0)) reason = "could not start scanner process";
        else if (! child.waitForProcessToFinish (timeout)) { child.kill(); reason = "timed out (plugin hangs while loading)"; }
        else
        {
            auto code = child.getExitCode();
            auto res = juce::JSON::parse (out);
            if (auto* a = res.getArray(); a != nullptr && ! a->isEmpty())
                for (auto& d : *a) { if (auto* dobj = d.getDynamicObject()) dobj->setProperty ("modified", mod); newPlugins.add (d); }
            else reason = code == 2 ? "no plugin found in file" : "crashed while loading (exit code " + juce::String ((int) code) + ")";
        }
        out.deleteFile();
        if (reason.isNotEmpty())
        {
            auto f = obj(); f->setProperty ("file", job.file); f->setProperty ("format", job.format); f->setProperty ("reason", reason); f->setProperty ("modified", mod);
            newFailed.add (v (f));
            log ("scan failed: " + job.file + ": " + reason);
        }
    }
    { const juce::ScopedLock sl (lock); plugins = newPlugins; failed = newFailed; }
    saveCache();
    auto cv = cacheAsVar();
    juce::DynamicObject::Ptr d = cv.getDynamicObject();
    d->setProperty ("cancelled", threadShouldExit());
    emit ("scan.done", d);
}
} // namespace auduio
