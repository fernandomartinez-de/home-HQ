"use client";

// Jarvis: tap the arc reactor, speak, and Jarvis does it and answers out loud.
// The reactor starts small in the header; on tap it expands into a fullscreen
// 3D wireframe sphere — nodes connected by lines, glowing core, slow rotation.
// Everything is voice-in, voice-out — no dialog, no text.

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/* ------------------------------------------------------------------ */
/*  Small idle icon — flat SVG for the header button                   */
/* ------------------------------------------------------------------ */

function ArcReactorMini({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="16" cy="16" r="13" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.5" />
      <circle cx="16" cy="16" r="9.5" fill="none" stroke="currentColor" strokeWidth="1.2" opacity="0.7" />
      {[0, 60, 120, 180, 240, 300].map((deg) => (
        <line key={deg} x1="16" y1="4.5" x2="16" y2="6.5" stroke="currentColor" strokeWidth="1" opacity="0.5"
          transform={`rotate(${deg} 16 16)`} />
      ))}
      <circle cx="16" cy="16" r="6" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.8" />
      <circle cx="16" cy="16" r="3" fill="rgba(167,139,250,0.5)" />
      <circle cx="16" cy="16" r="1.5" fill="white" opacity="0.6" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  3D wireframe sphere — canvas-based                                 */
/* ------------------------------------------------------------------ */

// Fibonacci sphere: distribute N points evenly on a sphere surface.
function fibSphere(n: number): [number, number, number][] {
  const pts: [number, number, number][] = [];
  const golden = (1 + Math.sqrt(5)) / 2;
  for (let i = 0; i < n; i++) {
    const theta = Math.acos(1 - (2 * (i + 0.5)) / n);
    const phi = (2 * Math.PI * i) / golden;
    pts.push([Math.sin(theta) * Math.cos(phi), Math.sin(theta) * Math.sin(phi), Math.cos(theta)]);
  }
  return pts;
}

// Pre-compute which pairs of points are close enough to draw a line.
function buildEdges(pts: [number, number, number][], threshold: number): [number, number][] {
  const edges: [number, number][] = [];
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[i][0] - pts[j][0];
      const dy = pts[i][1] - pts[j][1];
      const dz = pts[i][2] - pts[j][2];
      if (dx * dx + dy * dy + dz * dz < threshold * threshold) {
        edges.push([i, j]);
      }
    }
  }
  return edges;
}

const NUM_POINTS = 180;
const EDGE_THRESHOLD = 0.55;
const SPHERE_PTS = fibSphere(NUM_POINTS);
const SPHERE_EDGES = buildEdges(SPHERE_PTS, EDGE_THRESHOLD);

// Inner core sphere — fewer, tighter points
const CORE_PTS = fibSphere(40);
const CORE_EDGES = buildEdges(CORE_PTS, 0.75);

interface SphereProps {
  phase: string;
}

function WireframeSphere({ phase }: SphereProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef(0);
  const angleRef = useRef({ x: 0, y: 0 });

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const cx = w / 2;
    const cy = h / 2;
    const radius = Math.min(w, h) * 0.42;
    const coreRadius = radius * 0.32;

    // Rotation speed varies by phase
    const speed = phase === "thinking" ? 0.012 : phase === "listening" ? 0.004 : phase === "reply" ? 0.003 : 0.002;
    angleRef.current.y += speed;
    angleRef.current.x += speed * 0.3;

    const ax = angleRef.current.x;
    const ay = angleRef.current.y;
    const cosX = Math.cos(ax), sinX = Math.sin(ax);
    const cosY = Math.cos(ay), sinY = Math.sin(ay);

    // Breathing pulse for listening
    const t = Date.now() / 1000;
    const breathe = phase === "listening" ? 1 + 0.04 * Math.sin(t * 2.5) : 1;
    const coreBreathe = phase === "listening" ? 1 + 0.08 * Math.sin(t * 2.5) : phase === "reply" ? 1 + 0.03 * Math.sin(t * 1.5) : 1;

    // Project a 3D point to 2D
    const project = (p: [number, number, number], r: number): { x: number; y: number; z: number } => {
      let [x, y, z] = p;
      // Rotate Y
      const x1 = x * cosY - z * sinY;
      const z1 = x * sinY + z * cosY;
      // Rotate X
      const y1 = y * cosX - z1 * sinX;
      const z2 = y * sinX + z1 * cosX;
      return { x: cx + x1 * r * breathe, y: cy + y1 * r * breathe, z: z2 };
    };

    ctx.clearRect(0, 0, w, h);

    // Core glow — radial gradient
    const glowIntensity = phase === "reply" ? 0.5 : phase === "listening" ? 0.3 + 0.1 * Math.sin(t * 2.5) : phase === "thinking" ? 0.35 : 0.15;
    const glowR = radius * (phase === "reply" ? 0.7 : 0.5) * coreBreathe;
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowR);
    glow.addColorStop(0, `rgba(167, 139, 250, ${glowIntensity})`);
    glow.addColorStop(0.4, `rgba(139, 92, 246, ${glowIntensity * 0.5})`);
    glow.addColorStop(1, "rgba(139, 92, 246, 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);

    // --- Outer sphere ---
    const projected = SPHERE_PTS.map((p) => project(p, radius));

    // Draw edges
    for (const [i, j] of SPHERE_EDGES) {
      const a = projected[i];
      const b = projected[j];
      // Depth-based opacity: front edges brighter, back edges dimmer
      const avgZ = (a.z + b.z) / 2;
      const depthAlpha = 0.08 + 0.22 * ((avgZ + 1) / 2);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = `rgba(167, 139, 250, ${depthAlpha})`;
      ctx.lineWidth = 0.6;
      ctx.stroke();
    }

    // Draw nodes
    for (const p of projected) {
      const depthAlpha = 0.2 + 0.8 * ((p.z + 1) / 2);
      const dotR = 1 + 0.8 * ((p.z + 1) / 2);
      ctx.beginPath();
      ctx.arc(p.x, p.y, dotR, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(196, 181, 253, ${depthAlpha})`;
      ctx.fill();
    }

    // --- Inner core sphere ---
    const coreProjected = CORE_PTS.map((p) => project(p, coreRadius * coreBreathe));

    for (const [i, j] of CORE_EDGES) {
      const a = coreProjected[i];
      const b = coreProjected[j];
      const avgZ = (a.z + b.z) / 2;
      const depthAlpha = 0.15 + 0.45 * ((avgZ + 1) / 2);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = `rgba(221, 214, 254, ${depthAlpha})`;
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }

    for (const p of coreProjected) {
      const depthAlpha = 0.3 + 0.7 * ((p.z + 1) / 2);
      const dotR = 1.2 + 1.0 * ((p.z + 1) / 2);
      ctx.beginPath();
      ctx.arc(p.x, p.y, dotR, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(237, 233, 254, ${depthAlpha})`;
      ctx.fill();
    }

    // Bright center point
    const centerGlow = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreRadius * 0.35 * coreBreathe);
    centerGlow.addColorStop(0, `rgba(255, 255, 255, ${phase === "reply" ? 0.95 : 0.8})`);
    centerGlow.addColorStop(0.3, `rgba(221, 214, 254, ${phase === "reply" ? 0.5 : 0.3})`);
    centerGlow.addColorStop(1, "rgba(167, 139, 250, 0)");
    ctx.fillStyle = centerGlow;
    ctx.beginPath();
    ctx.arc(cx, cy, coreRadius * 0.35 * coreBreathe, 0, Math.PI * 2);
    ctx.fill();

    frameRef.current = requestAnimationFrame(draw);
  }, [phase]);

  useEffect(() => {
    frameRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frameRef.current);
  }, [draw]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: "min(80vw, 80vh)", height: "min(80vw, 80vh)" }}
    />
  );
}

/* ------------------------------------------------------------------ */
/*  Phase label                                                        */
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
    <span className="text-[11px] font-medium tracking-widest uppercase text-violet-300/70 mt-4 select-none">
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
      {/* small header button */}
      <button
        onClick={handleClick}
        aria-label="Talk to Jarvis"
        disabled={!canListen && phase === "idle"}
        className={`relative w-9 h-9 flex items-center justify-center rounded-full border active:scale-95 transition-all duration-300 disabled:opacity-40
          ${expanded ? "opacity-0 pointer-events-none" : "bg-white/5 border-white/10 text-violet-300"}`}
      >
        <ArcReactorMini size={18} />
      </button>

      {/* expanded overlay — portaled to body */}
      {expanded && createPortal(
        <div
          onClick={handleClick}
          style={{
            position: "fixed", top: 0, left: 0, right: 0, bottom: 0, zIndex: 9999,
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
            background: "rgba(2, 6, 23, 0.78)",
            backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
            cursor: "pointer",
            animation: "jarvis-fade-in 0.3s ease-out",
          }}
        >
          <div style={{ animation: "jarvis-expand 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) both" }}>
            <WireframeSphere phase={phase} />
          </div>
          <PhaseLabel phase={phase} />
        </div>,
        document.body
      )}
    </>
  );
}
