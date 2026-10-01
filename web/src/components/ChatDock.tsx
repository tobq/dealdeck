import { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../../../shared/types';
import { useVoice } from '../voice/useVoice';
import '../voice/voice.css';

const MicIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
);
const SpeakerIcon = ({ off }: { off: boolean }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 9h4l5-4v14l-5-4H4z" />{off ? <path d="M17 9l5 6M22 9l-5 6" /> : <path d="M17 8a5 5 0 0 1 0 8M19.5 5.5a9 9 0 0 1 0 13" />}</svg>
);

const LABEL = { idle: 'Mic off', listening: 'Listening', thinking: 'Thinking', speaking: 'Speaking' } as const;

export default function ChatDock({ deckId, chat, streaming, busy }: { deckId: string; chat: ChatMessage[]; streaming?: string | null; busy: boolean }) {
  const v = useVoice(deckId);
  const [text, setText] = useState('');
  const [sendErr, setSendErr] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' }); }, [chat.length, streaming]);

  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    setSendErr(null);
    const r = await fetch('/api/decks/' + deckId + '/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: t }) }).catch(() => null);
    if (!r || !r.ok) { setSendErr(`Send failed${r ? ` (${r.status})` : ''}`); setText(t); }
  };

  const err = v.error || sendErr;
  return (
    <div className="vx-dock">
      <div className="vx-log" ref={logRef}>
        {!chat.length && !streaming && <div className="vx-empty">Ask anything about this deck. Turn on the mic to talk; it will answer out loud and edit slides as you go.</div>}
        {chat.map((m) => (
          <div key={m.id} className={`vx-msg vx-msg-${m.role}`}>
            {m.text}
            {m.role === 'assistant' && m.spoken && m.spoken !== m.text && <div className="vx-msg-spoken">Said: {m.spoken}</div>}
          </div>
        ))}
        {streaming ? <div className="vx-msg vx-msg-assistant vx-msg-streaming">{streaming}</div> : null}
      </div>
      <div className="vx-status">
        <span className={`vx-dot vx-dot-${v.state}`} />
        <span>{v.micOn || v.state === 'speaking' ? LABEL[v.state] : busy ? 'Working...' : LABEL.idle}</span>
        {v.micOn && v.partial ? <span className="vx-partial">"{v.partial}"</span> : null}
        {err ? <span className="vx-err">{err}</span> : null}
      </div>
      <div className="vx-inputrow">
        <button className={`vx-mic${v.micOn ? ' vx-mic-on' : ''}`} onClick={v.toggleMic} title={v.micOn ? 'Stop listening' : 'Talk to the deck'} aria-pressed={v.micOn}>
          <MicIcon />
        </button>
        <input
          className="vx-input"
          value={text}
          placeholder={v.micOn ? 'Listening... or type' : 'Ask a question or request an edit'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
        />
        <button className="vx-icon" onClick={v.toggleMute} title={v.muted ? 'Unmute voice' : 'Mute voice'} aria-pressed={v.muted}>
          <SpeakerIcon off={v.muted} />
        </button>
      </div>
    </div>
  );
}

export { ChatDock };
