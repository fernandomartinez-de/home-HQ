"use client";

// Jarvis: tap the arc reactor, speak, and Jarvis does it and answers out loud.
// The reactor starts small in the header; on tap it expands into a centered floating
// orb with animated concentric rings, a breathing core, and phase-driven visuals.
// Everything is voice-in, voice-out — no dialog, no text.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/* ------------------------------------------------------------------ */
/*  Arc Reactor SVG                                                    */
/* ------------------------------------------------------------------ */

function ArcReactor({ size = 20, phase = "idle" }: { size?: number; phase?: string }) {
  const active = phase === "listening" || phase === "reply";
  const thinking = phase === "thinking";
  const expanded = phase !== "idle";
  // More ring segments when expanded for detail
  const segments = expanded ? 12 : 6;
  const segAngle = 360 / segments;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ overflow: "visible" }}
    >
      <defs>
        <radialGradient id="core-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#c4b5fd" stopOpacity={active || thinking ? "1" : "0.6"} />
          <stop offset="100%" stopColor="#7c3aed" stopOpacity="0" />
        </radialGradient>
        <filter id="blur-glow">
          <feGaussianBlur stdDeviation={expanded ? "4" : "2"} />
        </filter>
      </defs>

      {/* ambient glow behind everything */}
      {expanded && (
        <circle cx="50" cy="50" r="48" fill="url(#core-glow)" opacity="0.35" filter="url(#blur-glow)" />
      )}

      {/* outermost dashed ring — slow counter-rotate */}
      {expanded && (
        <circle
          cx="50" cy="50" r="46"
          fill="none"
          stroke="rgba(167,139,250,0.2)"
          strokeWidth="0.5"
          strokeDasharray="4 8"
          className="jarvis-ring-ccw"
        />
      )}

      {/* outer ring */}
      <circle
        cx="50" cy="50" r={expanded ? 42 : 40}
        fill="none"
        stroke="currentColor"
        strokeWidth={expanded ? "1" : "1.5"}
        opacity={active ? "0.7" : "0.4"}
        className={active ? "jarvis-ring-outer-lg" : ""}
      />

      {/* segment tick marks */}
      {Array.from({ length: segments }).map((_, i) => {
        const deg = i * segAngle;
        return (
          <line
            key={deg}
            x1="50" y1={expanded ? "10" : "12"}
            x2="50" y2={expanded ? "16" : "17"}
            stroke="currentColor"
            strokeWidth={expanded ? "0.8" : "1"}
            opacity={active ? "0.7" : "0.4"}
            transform={`rotate(${deg} 50 50)`}
          />
        );
      })}

      {/* middle ring */}
      <circle
        cx="50" cy="50" r={expanded ? 30 : 28}
        fill="none"
        stroke="currentColor"
        strokeWidth={expanded ? "0.8" : "1.2"}
        opacity="0.5"
        className={thinking ? "jarvis-ring-think" : ""}
      />

      {/* inner dashed ring — visible when expanded */}
      {expanded && (
        <circle
          cx="50" cy="50" r="22"
          fill="none"
          stroke="rgba(167,139,250,0.3)"
          strokeWidth="0.6"
          strokeDasharray="3 6"
          className="jarvis-ring-cw"
        />
      )}

      {/* inner ring */}
      <circle
        cx="50" cy="50" r={expanded ? 16 : 17}
        fill="none"
        stroke="currentColor"
        strokeWidth={expanded ? "0.8" : "1"}
        opacity="0.7"
      />

      {/* core glow */}
      <circle
        cx="50" cy="50"
        r={expanded ? 10 : 9}
        fill={active || thinking ? "rgba(167,139,250,0.85)" : "rgba(167,139,250,0.45)"}
        className={active ? "jarvis-core-glow" : thinking ? "jarvis-core-think" : ""}
      />

      {/* bright center */}
      <circle
        cx="50" cy="50"
        r={expanded ? 5 : 4.5}
        fill="white"
        opacity={active || thinking ? "0.95" : "0.55"}
      />

      {/* tiny center pip */}
      {expanded && (
        <circle cx="50" cy="50" r="2" fill="rgba(167,139,250,1)" opacity="0.9" />
      )}
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  Phase label shown below the expanded orb                           */
/* ------------------------------------------------------------------ */

function PhaseLabel({ phase }: { phase: string }) {
  const labels: Record<string, string> = {
    listening: "Listening...",
    thinking: "Processing...",
    reply: "Speaking...",
    error: "Error",
  };
  const label = labels[phase];
  if (!label) return null;
  return (
    <span className="text-[11px] font-medium tracking-widest uppercase text-violet-300/70 mt-3 select-none">
      {label}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Types & constants                                                  */
/* ------------------------------------------------------------------ */

type Phase = "idle" | "listening" | "thinking" | "reply" | "error";
type Turn = { role: "user" | "assistant"; content: string };

const FOLLOW_UP_MS = 2 * 60_000;

/* ------------------------------------------------------------------ */
/*  TTS helpers                                                        */
/* ------------------------------------------------------------------ */

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

let currentAudio: HTMLAudioElement | null = null;
function speak(text: string, audioBase64?: string, onEnded?: () => void) {
  try { currentAudio?.pause(); currentAudio = null; } catch { /* fine */ }
  try { window.speechSynthesis?.cancel(); } catch { /* fine */ }

  if (audioBase64) {
    try {
      const audio = new Audio(`data:audio/mpeg;base64,${audioBase64}`);
      currentAudio = audio;
      if (onEnded) audio.onended = onEnded;
      audio.play().catch(() => { speakBrowserFallback(text); if (onEnded) setTimeout(onEnded, 1500); });
      return;
    } catch { /* fall through */ }
  }
  speakBrowserFallback(text);
  if (onEnded) setTimeout(onEnded, 1500);
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export default function Jarvis({ onDone }: { onDone?: () => void }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [canListen, setCanListen] = useState(true);
  const rec = useRef<any>(null);
  const history = useRef<{ turns: Turn[]; at: number }>({ turns: [], at: 0 });

  useEffect(() => {
    const SR = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    setCanListen(!!SR);
    window.speechSynthesis?.getVoices();
  }, []);

  const stop = () => {
    try { rec.current?.abort(); } catch { /* already stopped */ }
    try { currentAudio?.pause(); currentAudio = null; } catch { /* fine */ }
    window.speechSynthesis?.cancel();
    setPhase("idle");
  };

  const ask = async (text: string) => {
    const said = text.trim();
    if (!said) { setPhase("idle"); return; }
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
      setPhase(r.ok ? "reply" : "error");
      speak(answer, body.audio, () => setPhase("idle"));
      history.current = { turns: [...h, { role: "user" as const, content: said }, { role: "assistant" as const, content: answer }].slice(-6), at: Date.now() };
      if (r.ok && Array.isArray(body.did) && body.did.length) setTimeout(() => onDone?.(), 2500);
    } catch {
      setPhase("error");
      speak("Sorry, I couldn't reach the house.", undefined, () => setPhase("idle"));
    }
  };

  const startRecognition = () => {
    const SR = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (!SR) { setPhase("idle"); return; }
    window.speechSynthesis?.cancel();
    const r = new SR();
    r.lang = "en-US";
    r.interimResults = false;
    r.continuous = false;
    let final = "";
    r.onresult = (ev: any) => {
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        if (ev.results[i].isFinal) final += ev.results[i][0].transcript;
      }
    };
    r.onerror = (ev: any) => {
      if (ev.error === "no-speech" || ev.error === "aborted") { setPhase("idle"); return; }
      setPhase("error");
      speak(ev.error === "not-allowed" ? "Allow the microphone in Safari settings." : "Couldn't listen.", undefined, () => setPhase("idle"));
    };
    r.onend = () => { rec.current = null; if (final.trim()) ask(final); else setPhase("idle"); };
    rec.current = r;
    setPhase("listening");
    try { r.start(); } catch { setPhase("idle"); }
  };

  const greet = async (then: () => void) => {
    try {
      const r = await fetch("/api/jarvis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ greet: true }),
      });
      const body = await r.json().catch(() => ({}));
      const text = String(body.reply ?? "");
      if (text) {
        setPhase("reply");
        speak(text, body.audio, then);
        return;
      }
    } catch { /* greeting failed, just listen */ }
    then();
  };

  const activate = () => {
    try { const u = new SpeechSynthesisUtterance(" "); u.volume = 0; window.speechSynthesis?.speak(u); } catch { /* fine */ }
    if (!history.current.turns.length || Date.now() - history.current.at >= FOLLOW_UP_MS) {
      greet(startRecognition);
    } else {
      startRecognition();
    }
  };

  const handleClick = () => {
    if (phase === "listening") { rec.current?.stop(); return; }
    if (phase === "thinking") return;
    if (phase === "reply" || phase === "error") { stop(); return; }
    activate();
  };

  const expanded = phase !== "idle";

  return (
    <>
      {/* small header button — always rendered for layout, invisible when expanded */}
      <button
        onClick={handleClick}
        aria-label="Talk to Jarvis"
        disabled={!canListen && phase === "idle"}
        className={`relative w-9 h-9 flex items-center justify-center rounded-full border active:scale-95 transition-all duration-300 disabled:opacity-40
          ${expanded ? "opacity-0 pointer-events-none" : "bg-white/5 border-white/10 text-violet-300"}`}
      >
        <ArcReactor size={18} phase="idle" />
      </button>

      {/* expanded overlay — portaled to body, inline styles guarantee centering */}
      {expanded && createPortal(
        <div
          onClick={handleClick}
          style={{
            position: "fixed", top: 0, left: 0, right: 0, bottom: 0, zIndex: 9999,
            display: "flex", alignItems: "center", justifyContent: "center",
            background: "rgba(0,0,0,0.75)",
            backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)",
            cursor: "pointer",
          }}
          className="jarvis-overlay"
        >
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", position: "relative" }}>
            {/* outer pulse rings */}
            <div className={`jarvis-pulse-ring ${phase === "listening" ? "jarvis-pulse-ring-active" : ""}`} />
            <div className={`jarvis-pulse-ring jarvis-pulse-ring-delayed ${phase === "listening" ? "jarvis-pulse-ring-active" : ""}`} />

            {/* the reactor itself */}
            <div className={`jarvis-orb jarvis-orb-${phase}`}>
              <ArcReactor size={120} phase={phase} />
            </div>

            <PhaseLabel phase={phase} />
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
