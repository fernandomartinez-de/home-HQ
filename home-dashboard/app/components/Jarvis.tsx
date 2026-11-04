"use client";

// Jarvis: tap the mic, say what you want ("movie mode", "kitchen lights to 40 percent", "is the door
// locked?"), and Home HQ does it and answers out loud. Speech to text is the browser's own (Safari on
// the iPad); the understanding happens in the jarvis function. Typing works too.

import { useEffect, useRef, useState } from "react";
import { Mic, Send as SendIcon, X, Loader2 } from "lucide-react";

type Phase = "idle" | "listening" | "thinking" | "reply" | "error";
type Turn = { role: "user" | "assistant"; content: string };

const FOLLOW_UP_MS = 2 * 60_000; // a request within 2 minutes can refer back ("now make them red")

// A British voice if the device has one, for the Jarvis feel; otherwise the default English voice.
// Used as fallback when the Cartesia audio isn't available.
function pickVoice() {
  if (typeof window === "undefined" || !window.speechSynthesis) return null;
  const voices = window.speechSynthesis.getVoices();
  return voices.find((v) => /Daniel|Arthur|Oliver/i.test(v.name) && /en-GB/i.test(v.lang))
    ?? voices.find((v) => /en-GB/i.test(v.lang))
    ?? voices.find((v) => /^en/i.test(v.lang)) ?? null;
}

function speakBrowserFallback(text: string) {
  try {
    const synth = window.speechSynthesis;
    if (!synth) return;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const v = pickVoice();
    if (v) { u.voice = v; u.lang = v.lang; }
    u.rate = 1.02;
    synth.speak(u);
  } catch { /* speech is a nicety */ }
}

// Play Cartesia TTS audio (base64 MP3), or fall back to browser speech.
let currentAudio: HTMLAudioElement | null = null;
function speak(text: string, audioBase64?: string) {
  // Stop any playing audio
  try { currentAudio?.pause(); currentAudio = null; } catch { /* fine */ }
  try { window.speechSynthesis?.cancel(); } catch { /* fine */ }

  if (audioBase64) {
    try {
      const audio = new Audio(`data:audio/mpeg;base64,${audioBase64}`);
      currentAudio = audio;
      audio.play().catch(() => speakBrowserFallback(text));
      return;
    } catch { /* fall through to browser */ }
  }
  speakBrowserFallback(text);
}

export default function Jarvis({ onDone }: { onDone?: () => void }) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [heard, setHeard] = useState("");
  const [reply, setReply] = useState("");
  const [typed, setTyped] = useState("");
  const [canListen, setCanListen] = useState(true);
  const rec = useRef<any>(null);
  const history = useRef<{ turns: Turn[]; at: number }>({ turns: [], at: 0 });

  useEffect(() => {
    const SR = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    setCanListen(!!SR);
    window.speechSynthesis?.getVoices(); // loads the voice list early
  }, []);

  const close = () => {
    try { rec.current?.abort(); } catch { /* already stopped */ }
    try { currentAudio?.pause(); currentAudio = null; } catch { /* fine */ }
    window.speechSynthesis?.cancel();
    setOpen(false);
    setPhase("idle");
  };

  const ask = async (text: string) => {
    const said = text.trim();
    if (!said) { setPhase("idle"); return; }
    setHeard(said);
    setPhase("thinking");
    const h = Date.now() - history.current.at < FOLLOW_UP_MS ? history.current.turns : [];
    try {
      const r = await fetch("/api/jarvis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: said, history: h }),
      });
      const body = await r.json().catch(() => ({}));
      const answer = String(body.reply ?? body.error ?? "Sorry, I didn't catch that.");
      setReply(answer);
      setPhase(r.ok ? "reply" : "error");
      speak(answer, body.audio);
      history.current = { turns: [...h, { role: "user" as const, content: said }, { role: "assistant" as const, content: answer }].slice(-6), at: Date.now() };
      if (r.ok && Array.isArray(body.did) && body.did.length) setTimeout(() => onDone?.(), 2500);
    } catch (e) {
      setReply(`Couldn't reach Jarvis: ${(e as Error).message}`);
      setPhase("error");
    }
  };

  const listen = () => {
    // iPad Safari only lets a page talk after a tap, so prime speech now with a silent utterance.
    try { const u = new SpeechSynthesisUtterance(" "); u.volume = 0; window.speechSynthesis?.speak(u); } catch { /* fine */ }
    setOpen(true);
    setReply("");
    setHeard("");
    const SR = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (!SR) { setPhase("idle"); return; }
    window.speechSynthesis?.cancel();
    const r = new SR();
    r.lang = "en-US";
    r.interimResults = true;
    r.continuous = false;
    let final = "";
    r.onresult = (ev: any) => {
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const t = ev.results[i][0].transcript;
        if (ev.results[i].isFinal) final += t; else interim += t;
      }
      setHeard((final + interim).trim());
    };
    r.onerror = (ev: any) => {
      if (ev.error === "no-speech" || ev.error === "aborted") { setPhase("idle"); return; }
      setReply(ev.error === "not-allowed" ? "Allow the microphone for this site in Safari settings, or type below." : `Couldn't listen: ${ev.error}`);
      setPhase("error");
    };
    r.onend = () => { rec.current = null; if (final.trim()) ask(final); else setPhase((p) => (p === "listening" ? "idle" : p)); };
    rec.current = r;
    setPhase("listening");
    try { r.start(); } catch { setPhase("idle"); }
  };

  const status = phase === "listening" ? "Listening…" : phase === "thinking" ? "On it…" : phase === "error" ? "Something went wrong" : phase === "reply" ? "Jarvis" : canListen ? "Tap the mic and speak" : "Type a request";

  return (
    <>
      <button onClick={() => (phase === "listening" ? rec.current?.stop() : listen())} aria-label="Talk to Jarvis"
        className={`w-9 h-9 flex items-center justify-center rounded-xl border active:scale-95 transition-colors ${phase === "listening" ? "bg-violet-500/30 border-violet-300/50 text-white jarvis-pulse" : "bg-white/5 border-white/10 text-violet-300"}`}>
        <Mic className="w-4 h-4" />
      </button>
      {open && (
        <div className="fixed inset-x-0 top-[84px] z-[60] flex justify-center px-4 pointer-events-none">
          <div role="dialog" aria-label="Jarvis" className="pointer-events-auto w-full max-w-[560px] rounded-3xl bg-[#17161d]/95 backdrop-blur border border-violet-300/20 shadow-2xl shadow-black/60 p-4 panel-in">
            <div className="flex items-center gap-3">
              <button onClick={() => (phase === "listening" ? rec.current?.stop() : listen())} disabled={!canListen || phase === "thinking"} aria-label={phase === "listening" ? "Stop listening" : "Speak again"}
                className={`relative w-12 h-12 shrink-0 rounded-full flex items-center justify-center border disabled:opacity-50 ${phase === "listening" ? "bg-violet-500 border-violet-300 text-white jarvis-pulse" : "bg-violet-500/15 border-violet-400/30 text-violet-200"}`}>
                {phase === "thinking" ? <Loader2 className="w-5 h-5 animate-spin" /> : <Mic className="w-5 h-5" />}
              </button>
              <div className="flex-1 min-w-0">
                <div className="text-[10px] font-mono tracking-wider uppercase text-violet-300/80">{status}</div>
                <div className="text-[15px] text-slate-400 truncate">{heard ? `“${heard}”` : phase === "listening" ? "…" : ""}</div>
              </div>
              <button onClick={close} aria-label="Close" className="w-9 h-9 shrink-0 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center text-slate-400"><X className="w-4 h-4" /></button>
            </div>
            {reply && <p className={`mt-3 text-[17px] leading-snug ${phase === "error" ? "text-amber-200" : "text-white"}`}>{reply}</p>}
            <form onSubmit={(e) => { e.preventDefault(); const t = typed; setTyped(""); ask(t); }} className="mt-3 flex gap-2">
              <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Or type: movie mode, lock the door…" enterKeyHint="send"
                className="flex-1 min-w-0 h-10 px-3 rounded-xl bg-black/40 border border-white/10 text-[14px] text-white placeholder:text-slate-500 outline-none focus:border-violet-400/50" />
              <button type="submit" disabled={!typed.trim() || phase === "thinking"} aria-label="Send" className="w-10 h-10 shrink-0 rounded-xl bg-violet-500/20 border border-violet-400/30 text-violet-200 flex items-center justify-center disabled:opacity-40"><SendIcon className="w-4 h-4" /></button>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
