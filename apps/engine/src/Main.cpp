// auduio-engine entry point.
//   auduio-engine                      protocol server on stdin/stdout (spawned by the Auduio desktop app)
//   auduio-engine --scan-one F P OUT   probe one plugin file in isolation (spawned by the scanner)
//   auduio-engine --version
#include <JuceHeader.h>
#include "Engine.h"
#include "Protocol.h"
#include "Scanner.h"
#include <iostream>
#include <thread>
#include <cstdlib>

class AuduioEngineApp : public juce::JUCEApplication
{
public:
    const juce::String getApplicationName() override { return "auduio-engine"; }
    const juce::String getApplicationVersion() override { return AUDUIO_ENGINE_VERSION; }
    bool moreThanOneInstanceAllowed() override { return true; }

    void initialise (const juce::String&) override
    {
        auto args = getCommandLineParameterArray();
        if (args.contains ("--version")) { std::printf ("auduio-engine %s (JUCE %s)\n", AUDUIO_ENGINE_VERSION, juce::SystemStats::getJUCEVersion().toRawUTF8()); std::fflush (stdout); setApplicationReturnValue (0); quit(); return; }
        auto k = args.indexOf ("--scan-one");
        if (k >= 0)
        {
            int code = 4;
            if (args.size() >= k + 4) code = auduio::scanOneMain (args[k + 1], args[k + 2], juce::File (args[k + 3]));
            setApplicationReturnValue (code);
            quit();
            return;
        }
        engine = std::make_unique<auduio::Engine>();
        // stdin reader: lines are handled on the message thread (plugins must be driven from there)
        reader = std::thread ([] {
            std::string line;
            while (std::getline (std::cin, line))
            {
                if (line.empty()) continue;
                if ((int) line.size() > auduio::kMaxLineBytes) { auduio::log ("dropped oversized line"); continue; }
                auto s = juce::String::fromUTF8 (line.data(), (int) line.size());
                juce::MessageManager::callAsync ([s] { if (auto* app = dynamic_cast<AuduioEngineApp*> (JUCEApplication::getInstance())) app->dispatch (s); });
            }
            // parent closed the pipe (app quit or crashed): do not linger
            // (guarded: a second quit on macOS throws "Periodic events are already being generated")
            juce::MessageManager::callAsync ([] { if (! juce::MessageManager::getInstance()->hasStopMessageBeenSent()) juce::JUCEApplicationBase::quit(); });
        });
        reader.detach();
        auto hello = engine->handle ("hello", {});
        auduio::emit ("ready", hello.getDynamicObject());
    }

    void dispatch (const juce::String& line)
    {
        juce::var msg;
        if (juce::JSON::parse (line, msg).failed() || ! msg.isObject()) { auduio::replyError ({}, "bad JSON"); return; }
        auto id = msg.getProperty ("id", {});
        auto cmd = msg.getProperty ("cmd", {}).toString();
        if (! engine) { auduio::replyError (id, "engine not running"); return; }
        try { auduio::reply (id, engine->handle (cmd, msg)); }
        catch (const std::exception& e) { auduio::replyError (id, e.what()); }
    }

    void shutdown() override
    {
        if (! engine) return; // --scan-one / --version: normal exit
        engine->shutdown(); engine.reset();
        // the stdin reader thread is blocked in getline; skip static destructors (which would wait on std::cin)
        std::fflush (stdout); std::fflush (stderr);
        std::_Exit (getApplicationReturnValue());
    }
    void systemRequestedQuit() override { if (! juce::MessageManager::getInstance()->hasStopMessageBeenSent()) quit(); }
    void anotherInstanceStarted (const juce::String&) override {}

private:
    std::unique_ptr<auduio::Engine> engine;
    std::thread reader;
};

START_JUCE_APPLICATION (AuduioEngineApp)
