'use client';

import Link from 'next/link';
import { useEffect, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import { CAPTIONS, frozenTicker, heroMeter, initialTicker, pickStep, stageOf, TICK_MS, tick, type TickerState } from '@/lib/landing-ticker';

const LOGO = '/logo.png';
/** The official PayPal logo (the board's asset, unaltered). Used only in the hero's settlement step. */
const PAYPAL_MARK = '/paypal-mark.webp';

function spot(event: PointerEvent<HTMLElement>): void {
  const t = event.currentTarget;
  const r = t.getBoundingClientRect();
  t.style.setProperty('--mx', `${event.clientX - r.left}px`);
  t.style.setProperty('--my', `${event.clientY - r.top}px`);
}

function Arrow() {
  return (
    <svg className="arr" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

function Check({ color, size = 24 }: { color: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: 'none' }}>
      <path d="m5 12 5 5L20 7" />
    </svg>
  );
}

/** Reduced motion, read on the client (design spec §16). */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}

const STEPS = [
  ['01', 'Link PayPal once', "Approve on PayPal's page and set limits. That's your only click."],
  ['02', 'Agent hits a paid API', 'The API answers 402 with a price, like $0.02.'],
  ['03', 'It signs and retries', 'A signed payment promise. The call goes through.'],
  ['04', 'One charge, later', 'Calls add up. We charge PayPal once near $5.00, or daily.'],
] as const;

const SUBS = [
  ['Search API · Pro', '$29/mo'],
  ['News API · Team', '$49/mo'],
  ['Maps API · Growth', '$99/mo'],
  ['Translate API · Plus', '$19/mo'],
  ['Weather API · Pro', '$15/mo'],
  ['Sentiment API · Basic', '$25/mo'],
  ['OCR API · Team', '$39/mo'],
  ['Quotes API · Pro', '$29/mo'],
] as const;

const FAQ = [
  ['Do I need crypto?', 'No. No wallets, tokens or seed phrases. Payments settle in US dollars through PayPal.'],
  ['What does the agent need?', 'An agent key from your console and the standard x402 fetch client with our PayPal plug-in. It handles the 402, signs and retries.'],
  ['How are fees kept low?', 'Paid calls are batched into one PayPal charge at your auto-charge amount, or once a day.'],
  ['Can I stop it?', 'Yes. Unlink here, or stop from your PayPal account. Agents are refused within a minute.'],
  ['Who receives the money?', "Each PayPal charge is made by PayPer402. Sellers see their share of every charge, after PayPal's fee."],
  ['Who holds my PayPal details?', 'PayPal does. We only keep a token for the agreement you approved.'],
] as const;

const glowOn = '0 0 0 8px rgba(43,227,138,.25), 0 18px 34px -14px rgba(12,15,14,.4)';
const glowOff = '0 12px 26px -16px rgba(12,15,14,.35)';
const strong: CSSProperties = { fontSize: 'clamp(13px, 1.4vw, 16px)', letterSpacing: '-0.01em' };
const sub: CSSProperties = { fontSize: 12, color: '#5B635F', marginTop: -6 };

/**
 * The ticker's pause control (design spec §10.1): a small icon button in the hero panel's caption
 * bar, next to the stage counter. Under reduced motion the animation is already off, so it is
 * disabled and says so.
 */
function PauseButton({ paused, reduced, onToggle }: { paused: boolean; reduced: boolean; onToggle: () => void }) {
  const label = reduced ? 'Animation off (reduced motion)' : paused ? 'Play animation' : 'Pause animation';
  return (
    <button type="button" className="lp-pause" aria-label={label} title={label} aria-pressed={paused} disabled={reduced} onClick={onToggle}>
      {paused || reduced ? (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M7 4v16l13-8z" />
        </svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <rect x="6" y="5" width="4" height="14" rx="1" />
          <rect x="14" y="5" width="4" height="14" rx="1" />
        </svg>
      )}
    </button>
  );
}

function Hero({ state, paused, reduced, onTogglePause }: { state: TickerState; paused: boolean; reduced: boolean; onTogglePause: () => void }) {
  const { stage, sub: subStage } = stageOf(state.h);
  const actor = ['agent', 'api', 'agent', 'agent', 'meter', 'api', 'meter', 'paypal', 'seller'][stage];
  const glow = (n: string) => (actor === n ? glowOn : glowOff);
  const meter = heroMeter(stage, subStage);
  return (
    <div className="wrap win" style={{ position: 'relative', paddingBottom: 96 }}>
      <div className="spotcard" onPointerMove={spot} style={{ maxWidth: 1080, margin: '0 auto', background: '#FFFFFF', border: '1px solid #E2E4DE', borderRadius: 28, boxShadow: '0 50px 100px -40px rgba(12,15,14,.3), 0 20px 40px -24px rgba(12,15,14,.16)', overflow: 'hidden', textAlign: 'left' }}>
        <div role="img" aria-label={`How a paid call works, step ${stage + 1} of 9: ${CAPTIONS[stage]}`} style={{ position: 'relative', padding: 'clamp(28px, 4vw, 44px) clamp(14px, 4vw, 56px) clamp(28px, 4vw, 40px)', backgroundImage: 'radial-gradient(#E6E8E2 1px, transparent 1px)', backgroundSize: '20px 20px' }}>
          <div className="lane" style={{ marginBottom: 18 }}>EVERY CALL · NO HUMAN CLICK · NO PAYPAL FEE</div>
          <div className="prow">
            <div className="ftrack">
              <div className="pline" />
              <div className="pline-on" style={{ background: '#0C0F0E', opacity: stage <= 6 ? 1 : 0 }} />
              {stage === 0 ? <span key="s0" className="chip fwd" style={{ background: '#0C0F0E', color: '#FFFFFF' }}><span className="t">GET /quote</span></span> : null}
              {stage === 1 ? <span key="s1" className="chip back" style={{ background: '#FFF1D6', color: '#6B4200', border: '1px solid #F0C978' }}><span className="t">402 · $0.02</span></span> : null}
              {stage === 3 ? <span key="s3" className="chip fwd" style={{ background: '#5B3FD9', color: '#FFFFFF' }}><span className="t">signed promise</span></span> : null}
              {stage === 5 ? <span key="s5" className="chip back" style={{ background: '#2BE38A', color: '#0C0F0E' }}><span className="t">200 OK</span></span> : null}
              {stage === 6
                ? [0, 0.33, 0.66].map((d) => (
                    <span key={`strm-${d}`} className="chip strm" style={{ background: '#0C0F0E', color: '#FFFFFF', animationDelay: `${d}s` }}>
                      <span className="t">call</span>
                    </span>
                  ))
                : null}
            </div>
            <div className="pnode">
              <div className="pbox" style={{ background: '#0C0F0E', boxShadow: glow('agent') }}>
                <svg width="40%" height="40%" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="5" y="8" width="14" height="11" rx="3.5" />
                  <path d="M12 4v4" />
                  <circle cx="12" cy="3.5" r="1" fill="#2BE38A" stroke="#2BE38A" />
                  <path d="M9.5 13h.01M14.5 13h.01" strokeWidth="2.6" />
                </svg>
                {stage === 2 ? (
                  <span className="bdg jev" style={{ background: '#FFFFFF', color: '#0C0F0E', border: '1.5px solid #0C0F0E' }}>
                    <Check color="#087A3D" size={11} />
                    Jev · serves task <span style={{ color: '#087A3D' }}>0.96</span>
                  </span>
                ) : null}
                {stage === 3 ? (
                  <span className="bdg" style={{ background: '#ECE8FF', color: '#3A2799' }}>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M4 20h4L19 9l-4-4L4 16z" />
                    </svg>
                    signs
                  </span>
                ) : null}
                {stage === 5 ? (
                  <span className="bdg" style={{ background: '#DDF9E9', color: '#05592C' }}>
                    <Check color="currentColor" size={11} />
                    data
                  </span>
                ) : null}
              </div>
              <strong style={strong}>Your agent</strong>
              <span className="mono" style={sub}>
                research-bot
              </span>
            </div>
            <div className="ptrack" />
            <div className="pnode">
              <div className="pbox" style={{ background: '#FFFFFF', border: '1.5px solid #E2E4DE', boxShadow: glow('meter') }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={LOGO} alt="" aria-hidden="true" style={{ width: '52%', height: '52%', display: 'block', objectFit: 'contain' }} />
                {stage === 4 ? <span className="bdg" style={{ background: '#2BE38A', color: '#0C0F0E' }}>+$0.02</span> : null}
                {stage === 7 ? <span className="bdg" style={{ background: '#0C0F0E', color: '#2BE38A' }}>near $5.00</span> : null}
              </div>
              <strong style={strong}>PayPer402 meter</strong>
              <span className="mono tnum" style={{ fontSize: 12, color: '#0C0F0E', fontWeight: 700, marginTop: -6 }}>
                ${(meter / 100).toFixed(2)} <span style={{ color: '#5B635F', fontWeight: 500 }}>/ $5.00</span>
              </span>
              <div style={{ width: '70%', height: 5, background: '#EEF0EB', borderRadius: 99, overflow: 'hidden', marginTop: -2 }}>
                <div style={{ height: '100%', width: `${meter / 5}%`, background: '#0E9F5C', borderRadius: 99, transition: 'width .65s cubic-bezier(.2,.8,.2,1)' }} />
              </div>
            </div>
            <div className="ptrack">
              {stage === 4 ? <span className="chip back" style={{ background: '#FFFFFF', color: '#3A2799', border: '1.5px solid #5B3FD9', zIndex: 4 }}><span className="t">verify</span></span> : null}
            </div>
            <div className="pnode">
              <div className="pbox" style={{ background: '#FFFFFF', border: '1.5px solid #0C0F0E', boxShadow: glow('api') }}>
                <svg width="40%" height="40%" viewBox="0 0 24 24" fill="none" stroke="#0C0F0E" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="4" y="4" width="16" height="6.5" rx="2" />
                  <rect x="4" y="13.5" width="16" height="6.5" rx="2" />
                  <path d="M8 7.2h.01M8 16.7h.01" strokeWidth="2.8" />
                </svg>
                {stage === 1 ? <span className="bdg" style={{ background: '#FFF1D6', color: '#6B4200' }}>402</span> : null}
                {stage === 5 ? <span className="bdg" style={{ background: '#2BE38A', color: '#0C0F0E' }}>200</span> : null}
              </div>
              <strong style={strong}>Paid API</strong>
              <span className="mono" style={sub}>
                $0.02 / call
              </span>
            </div>
          </div>

          <div className="vlink">
            <div style={{ position: 'relative', width: 2, height: '100%', background: 'repeating-linear-gradient(180deg, #CDD1C9 0 6px, transparent 6px 12px)' }}>
              <div style={{ position: 'absolute', inset: 0, background: '#0E9F5C', opacity: stage >= 7 ? 1 : 0, transition: 'opacity .5s' }} />
            </div>
            <div className="lane" style={{ position: 'absolute', left: 0, bottom: 6 }}>
              ONCE · NEAR $5.00 OR DAILY
            </div>
          </div>

          <div className="prow">
            <div className="pnode">
              <div className="pbox" style={{ background: '#F4F5F1', border: '1.5px solid #E2E4DE', boxShadow: stage === 7 ? glowOn : glowOff }}>
                <svg width="40%" height="40%" viewBox="0 0 24 24" fill="none" stroke="#0C0F0E" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="8.5" r="3.5" />
                  <path d="M5 20c1.2-3.6 4-5.5 7-5.5s5.8 1.9 7 5.5" />
                </svg>
                {stage === 7 ? <span className="bdg" style={{ background: '#0C0F0E', color: '#FFFFFF' }}>−$5.00</span> : null}
              </div>
              <strong style={strong}>Operator</strong>
              <span className="mono" style={sub}>
                pays via PayPal
              </span>
            </div>
            <div className="ptrack">
              <div className="pline" />
              <div className="pline-on" style={{ background: '#0E9F5C', opacity: stage >= 7 ? 1 : 0 }} />
              {stage === 7 ? <span className="chip fwd" style={{ background: '#0C0F0E', color: '#FFFFFF' }}><span className="t">$5.00</span></span> : null}
            </div>
            <div className="pnode">
              <div className="pbox" style={{ background: '#FFFFFF', border: '1.5px solid #E2E4DE', boxShadow: glow('paypal') }}>
                {/*
                  The settlement step shows the official PayPal logo, unaltered and as on the board, to name PayPal as
                  the payment rail. This is its only use (design spec §10.1 and §15.4, CLAUDE.md Trademark rule).
                */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={PAYPAL_MARK} alt="PayPal" style={{ height: '50%', width: 'auto', display: 'block' }} />
                {stage === 8 ? <span className="bdg" style={{ background: '#2BE38A', color: '#0C0F0E' }}>1 fee</span> : null}
              </div>
              <strong style={strong}>PayPer402</strong>
              <span className="mono" style={sub}>
                settled with PayPal
              </span>
            </div>
            <div className="ptrack">
              <div className="pline" />
              <div className="pline-on" style={{ background: '#0E9F5C', opacity: stage >= 8 ? 1 : 0 }} />
              {stage === 8 ? <span className="chip fwd" style={{ background: '#2BE38A', color: '#0C0F0E' }}><span className="t">$5.00</span></span> : null}
            </div>
            <div className="pnode">
              <div className="pbox" style={{ background: '#ECE8FF', border: '1.5px solid #D6CCFF', boxShadow: glow('seller') }}>
                <svg width="40%" height="40%" viewBox="0 0 24 24" fill="none" stroke="#3A2799" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M4 9.5 5.5 4h13L20 9.5" />
                  <path d="M4 9.5c0 1.4 1.2 2.5 2.7 2.5s2.6-1.1 2.6-2.5c0 1.4 1.2 2.5 2.7 2.5s2.7-1.1 2.7-2.5c0 1.4 1.2 2.5 2.6 2.5S20 10.9 20 9.5" />
                  <path d="M5.5 12v8h13v-8" />
                </svg>
                {stage === 8 ? <span className="bdg" style={{ background: '#2BE38A', color: '#0C0F0E' }}>+$4.34 net</span> : null}
              </div>
              <strong style={strong}>Seller revenue</strong>
              <span className="mono" style={sub}>
                Acme Data
              </span>
            </div>
          </div>
        </div>
        <div style={{ borderTop: '1px solid #EEF0EB', background: '#FAFBF8', padding: '20px clamp(16px, 4vw, 40px)', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, minHeight: 30 }}>
            <span className="mono" style={{ flex: 'none', fontSize: 12, fontWeight: 700, color: '#FFFFFF', background: '#0C0F0E', borderRadius: 999, padding: '4px 10px' }}>
              0{stage + 1}/09
            </span>
            <PauseButton paused={paused} reduced={reduced} onToggle={onTogglePause} />
            <p key={stage} className="cap" style={{ margin: 0, fontSize: 'clamp(16px, 1.8vw, 19px)', fontWeight: 600, letterSpacing: '-0.01em' }}>
              {CAPTIONS[stage]}
            </p>
          </div>
          <div aria-hidden="true" style={{ display: 'flex', gap: 6 }}>
            {CAPTIONS.map((_, k) => (
              <span key={k} style={{ flex: 1, height: 4, borderRadius: 4, transition: 'background .45s', background: k < stage ? '#0C0F0E' : k === stage ? '#2BE38A' : '#E2E4DE' }} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function StepPanel({ step }: { step: number }) {
  const darkPanel: CSSProperties = { width: '100%', background: '#0C0F0E', color: '#C5CEC9', borderRadius: 20, padding: 24, fontSize: 14, lineHeight: 1.7, boxShadow: '0 30px 60px -30px rgba(12,15,14,.5)', display: 'flex', flexDirection: 'column', gap: 2, overflowX: 'auto' };
  const comment: CSSProperties = { color: '#7E8A84' };
  if (step === 1) {
    return (
      <div key="s1" className="st mono" style={darkPanel}>
        <span style={comment}># research-bot calls a paid API</span>
        <span>
          <span style={{ color: '#2BE38A' }}>GET</span> /v1/quote?symbol=KC
        </span>
        <span style={{ marginTop: 10 }}>
          <span style={{ background: '#3A2A08', color: '#FFB020', borderRadius: 6, padding: '2px 8px', fontWeight: 700 }}>HTTP/1.1 402 Payment Required</span>
        </span>
        <span>
          PAYMENT-REQUIRED: <span style={{ color: '#C79BFF' }}>eyJ4NDAyVmVyc2lvbiI6MiwicmVz…</span>
        </span>
        <span style={{ ...comment, marginTop: 10 }}># decoded</span>
        <span>{'{ "x402Version": 2,'}</span>
        <span>{'  "accepts": [{ "scheme": "batch-settlement", "network": "paypal:sandbox",'}</span>
        <span>
          {' '.repeat(16)}&quot;asset&quot;: &quot;USD&quot;, &quot;amount&quot;: <span style={{ color: '#FFB020', fontWeight: 700 }}>&quot;2&quot;</span>, &quot;payTo&quot;: &quot;sel_Qm2…&quot;{' }] }'}
        </span>
        <span style={comment}># amount is in cents: $0.02</span>
      </div>
    );
  }
  if (step === 2) {
    return (
      <div key="s2" className="st mono" style={darkPanel}>
        <span style={comment}># signs a payment promise and retries</span>
        <span>
          <span style={{ color: '#2BE38A' }}>GET</span> /v1/quote?symbol=KC
        </span>
        <span>
          PAYMENT-SIGNATURE:{' '}
          <span className="type" style={{ color: '#C79BFF' }}>
            eyJ4NDAyVmVyc2lvbiI6MiwicmVz…
          </span>
        </span>
        <span style={{ marginTop: 10 }}>
          <span style={{ background: '#0C2A1B', color: '#2BE38A', borderRadius: 6, padding: '2px 8px', fontWeight: 700 }}>HTTP/1.1 200 OK</span>
        </span>
        <span>
          PAYMENT-RESPONSE: <span style={{ color: '#C79BFF' }}>eyJzdWNjZXNzIjp0cnVlLCJ0cmFu…</span>
        </span>
        <span>{'{ "symbol": "KC", "price": "…" }'}</span>
        <span style={comment}># paid $0.02 · not yet charged</span>
      </div>
    );
  }
  if (step === 3) {
    const row: CSSProperties = { display: 'flex', padding: '8px 6px', borderBottom: '1px solid #EEF0EB' };
    return (
      <div key="s3" className="st" style={{ width: '100%', background: '#FFFFFF', borderRadius: 20, padding: 20, boxShadow: '0 30px 60px -30px rgba(12,15,14,.3)', display: 'flex', flexDirection: 'column', gap: 6, fontSize: 14 }}>
        {[
          ['Market Quote API', '$0.02'],
          ['Page Summary API', '$0.05'],
          ['Translate API', '$0.01'],
        ].map(([n, p]) => (
          <div key={n} style={row}>
            <span>{n}</span>
            <span className="mono tnum" style={{ marginLeft: 'auto' }}>
              {p}
            </span>
          </div>
        ))}
        <div style={{ ...row, color: '#4F5753' }}>
          <span>+ 140 more paid calls</span>
          <span className="mono tnum" style={{ marginLeft: 'auto' }}>
            $4.79
          </span>
        </div>
        <div style={{ marginTop: 8, background: '#0C0F0E', color: '#FFFFFF', borderRadius: 14, padding: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span style={{ fontSize: 13, color: '#B4BEB8' }}>One PayPal charge · 143 calls</span>
            <span className="mono tnum" style={{ fontSize: 28, fontWeight: 700, color: '#2BE38A' }}>
              $4.87
            </span>
          </div>
          <span style={{ marginLeft: 'auto', fontSize: 13, fontWeight: 700, color: '#2BE38A', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <Check color="currentColor" size={14} />= exact sum
          </span>
        </div>
      </div>
    );
  }
  const chip: CSSProperties = { fontSize: 13, border: '1px solid #E2E4DE', borderRadius: 999, padding: '5px 12px' };
  return (
    <div key="s0" className="st" style={{ width: '100%', background: '#FFFFFF', borderRadius: 20, padding: 24, boxShadow: '0 30px 60px -30px rgba(12,15,14,.3)', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <strong style={{ fontSize: 17 }}>Link your PayPal account</strong>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#0C0F0E', color: '#FFFFFF', borderRadius: 12, padding: '13px 16px', fontWeight: 700, fontSize: 15 }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#2BE38A" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
          <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
          <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
        </svg>
        Link PayPal account
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#ECE8FF', color: '#3A2799', borderRadius: 12, padding: '12px 16px', fontSize: 14, fontWeight: 600 }}>
        <svg className="spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
          <path d="M12 3a9 9 0 1 0 9 9" />
        </svg>
        Approving on PayPal&apos;s page…
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#DDF9E9', color: '#05592C', borderRadius: 12, padding: '12px 16px', fontSize: 14, fontWeight: 700 }}>
        <Check color="currentColor" size={16} />
        Linked · <span className="mono" style={{ fontWeight: 600 }}>al***@example.com</span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, paddingTop: 4 }}>
        <span className="mono" style={chip}>
          per call $0.10
        </span>
        <span className="mono" style={chip}>
          daily $10.00
        </span>
        <span className="mono" style={chip}>
          auto-charge $5.00
        </span>
      </div>
    </div>
  );
}

function ExternalLinks({ repoUrl, children }: { repoUrl: string | undefined; children: (urls: { repo: string; spec: string }) => ReactNode }) {
  if (repoUrl === undefined) return null;
  const repo = repoUrl.replace(/\/+$/, '');
  return <>{children({ repo, spec: `${repo}/blob/main/docs/spec/scheme_batch_settlement_paypal.md` })}</>;
}

/** The landing page (design spec §10.1, boards `Main` and `LandingMobile`). */
export function Landing({ repoUrl }: { repoUrl: string | undefined }) {
  const reduced = useReducedMotion();
  const [paused, setPaused] = useState(false);
  const [state, setState] = useState<TickerState>(initialTicker);
  const [tab, setTab] = useState<'op' | 'seller'>('op');

  useEffect(() => {
    if (reduced) {
      setState(frozenTicker);
      return;
    }
    if (paused) return;
    const iv = setInterval(() => setState((s) => tick(s)), TICK_MS);
    return () => clearInterval(iv);
  }, [reduced, paused]);

  const filled = Math.round(state.cents / 20);
  const on: CSSProperties = { background: '#0C0F0E', color: '#FFFFFF' };
  const off: CSSProperties = { background: 'transparent', color: '#0C0F0E' };
  const faqQ: CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 16, fontSize: 19, fontWeight: 700 };

  return (
    <div id="top" className={`landing ${paused || reduced ? 'paused' : ''}`}>
      <div className="sprog" aria-hidden="true" />
      <div style={{ background: '#0C0F0E', color: '#FFD27A', fontSize: 13, textAlign: 'center', padding: '7px 16px' }}>
        <span className="mono" style={{ fontWeight: 600 }}>
          SANDBOX
        </span>{' '}
        · Sandbox: test money only. No real charges.
      </div>
      <svg aria-hidden="true" width="0" height="0" style={{ position: 'absolute' }}>
        <filter id="lg-distort" x="0%" y="0%" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="0.006 0.02" numOctaves={2} seed={11} result="noise" />
          <feGaussianBlur in="noise" stdDeviation="2.5" result="soft" />
          <feDisplacementMap in="SourceGraphic" in2="soft" scale={46} xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </svg>
      <div className="hdr-wrap">
        <header className="hdr">
          <span className="lg lg-fx" aria-hidden="true" />
          <span className="lg lg-tint" aria-hidden="true" />
          <span className="lg lg-shine" aria-hidden="true" />
          <a href="#top" className="logo" style={{ display: 'flex', alignItems: 'center', gap: 10, fontWeight: 800, fontSize: 21, letterSpacing: '-0.02em', flex: 'none' }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={LOGO} alt="" aria-hidden="true" width={32} height={32} style={{ display: 'block', flex: 'none', objectFit: 'contain' }} />
            <span>
              PayPer<span className="ac">402</span>
            </span>
          </a>
          <nav aria-label="Main">
            <a href="#how" className="navlink">
              How it works
            </a>
            <a href="#sides" className="navlink">
              For sellers
            </a>
            <a href="#spec" className="navlink">
              Spec
            </a>
          </nav>
          <Link href="/sign-in" className="btn spec spot" onPointerMove={spot} style={{ minHeight: 44, padding: '0 20px', fontSize: 15, flex: 'none' }}>
            <span className="sheen" aria-hidden="true" />
            Try the live demo
          </Link>
        </header>
      </div>

      <section className="sx-flat" style={{ position: 'relative' }}>
        <div aria-hidden="true" style={{ position: 'absolute', inset: '0 0 30% 0', backgroundImage: 'radial-gradient(#D6D9D2 1.2px, transparent 1.2px)', backgroundSize: '26px 26px', WebkitMaskImage: 'radial-gradient(70% 70% at 50% 20%, #000 0%, transparent 75%)', maskImage: 'radial-gradient(70% 70% at 50% 20%, #000 0%, transparent 75%)' }} />
        <div className="wrap" style={{ position: 'relative', paddingTop: 72, paddingBottom: 40, display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 24 }}>
          <a href="#spec" className="rise" style={{ animationDelay: '.05s', display: 'inline-flex', gap: 10, alignItems: 'center', background: '#FFFFFF', border: '1px solid #E2E4DE', color: '#0C0F0E', fontWeight: 600, fontSize: 14, borderRadius: 999, padding: '6px 8px 6px 6px', boxShadow: '0 2px 8px rgba(12,15,14,.05)' }}>
            <span className="mono" style={{ background: '#0C0F0E', color: '#2BE38A', borderRadius: 999, padding: '3px 10px', fontSize: 12, fontWeight: 700 }}>
              x402
            </span>
            The first PayPal rail for HTTP payments
            <span aria-hidden="true" style={{ color: '#5B635F' }}>
              →
            </span>
          </a>
          <h1 style={{ margin: 0, fontSize: 'clamp(48px, 7.6vw, 96px)', lineHeight: 1.2, letterSpacing: '-0.05em', fontWeight: 800, maxWidth: 1000, color: '#0c0f0e' }}>
            {['Agents', 'pay', 'via', 'x402'].map((word, k) => (
              <span key={word}>
                <span className="w" style={{ animationDelay: `${0.1 + k * 0.08}s`, color: word === 'pay' ? '#087A3D' : undefined }}>
                  {word}
                </span>{' '}
              </span>
            ))}
            <br />
            {['settled', 'with', 'PayPal'].map((word, k) => (
              <span key={word}>
                <span className="w" style={{ animationDelay: `${0.42 + k * 0.08}s` }}>
                  {word}
                </span>
                {k < 2 ? ' ' : null}
              </span>
            ))}
          </h1>
          <p className="rise" style={{ animationDelay: '.7s', margin: 0, fontSize: 'clamp(19px, 2vw, 22px)', color: '#3A423E', fontWeight: 500 }}>
            Cents per call. No crypto, one charge.
          </p>
          <div className="rise" style={{ animationDelay: '.82s', display: 'flex', flexWrap: 'wrap', gap: 12, justifyContent: 'center' }}>
            <Link href="/sign-in" className="btn spec spot" onPointerMove={spot} style={{ minHeight: 56, padding: '0 30px', fontSize: 17 }}>
              <span className="sheen" aria-hidden="true" />
              Try the live demo
              <Arrow />
            </Link>
            <a href="#sides" className="btn btn-line spot" onPointerMove={spot} style={{ minHeight: 56 }}>
              For API sellers
            </a>
          </div>
        </div>
        <Hero state={state} paused={paused} reduced={reduced} onTogglePause={() => setPaused((p) => !p)} />
      </section>

      <section className="sx" style={{ background: '#F4F5F1' }}>
        <div className="wrap" style={{ paddingTop: 104, paddingBottom: 104, display: 'flex', flexDirection: 'column', gap: 44 }}>
          <div className="rv" style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 760 }}>
            <span className="eyebrow">THE PROBLEM</span>
            <h2 className="h2">
              APIs were built
              <br />
              for humans first.
            </h2>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 300px), 1fr))', gap: 20 }}>
            <article className="card rv" style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <div style={{ background: '#ECE8FF', padding: 28, height: 210, boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div className="shake" style={{ width: '100%', maxWidth: 250, background: '#FFFFFF', borderRadius: 14, padding: 16, boxShadow: '0 12px 30px -12px rgba(58,39,153,.35)', display: 'flex', flexDirection: 'column', gap: 9, fontSize: 12 }}>
                  <strong style={{ fontSize: 14 }}>Create your account</strong>
                  <div style={{ height: 28, border: '1px solid #E2E4DE', borderRadius: 8, display: 'flex', alignItems: 'center', padding: '0 10px', color: '#5B635F' }}>agent@research-bot</div>
                  <div className="mono" style={{ height: 28, border: '1px solid #E2E4DE', borderRadius: 8, display: 'flex', alignItems: 'center', padding: '0 10px' }}>
                    ••••••••
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, border: '1.5px solid #B42318', borderRadius: 8, padding: '6px 10px', color: '#8A1C12', fontWeight: 700 }}>
                    <span style={{ width: 14, height: 14, border: '1.5px solid #B42318', borderRadius: 3 }} />
                    Verify you&apos;re human
                  </div>
                </div>
              </div>
              <div style={{ padding: '24px 26px 28px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <h3 style={{ margin: 0, fontSize: 21, letterSpacing: '-0.02em' }}>Agents can&apos;t sign up</h3>
                <p style={{ margin: 0, color: '#4F5753', fontSize: 16 }}>Accounts, cards, captchas and API keys all expect a human at a keyboard.</p>
              </div>
            </article>
            <article className="card rv2" style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <div style={{ background: '#FFF1D6', padding: '0 28px', height: 210, boxSizing: 'border-box', overflow: 'hidden', position: 'relative', WebkitMaskImage: 'linear-gradient(transparent, #000 22%, #000 78%, transparent)', maskImage: 'linear-gradient(transparent, #000 22%, #000 78%, transparent)' }}>
                <div className="marquee" style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 10 }}>
                  {[...SUBS, ...SUBS].map(([n, p], k) => (
                    <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#FFFFFF', borderRadius: 12, padding: '10px 14px', fontSize: 13.5, boxShadow: '0 6px 16px -10px rgba(107,66,0,.4)' }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#F59E0B' }} />
                      {n}
                      <span className="mono tnum" style={{ marginLeft: 'auto', fontWeight: 700 }}>
                        {p}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              <div style={{ padding: '24px 26px 28px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <h3 style={{ margin: 0, fontSize: 21, letterSpacing: '-0.02em' }}>30 APIs, 30 subscriptions</h3>
                <p style={{ margin: 0, color: '#4F5753', fontSize: 16 }}>Nobody wants a monthly plan for an API their agent calls twice a week.</p>
              </div>
            </article>
            <article className="card rv3" style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <div style={{ background: '#FDE7E4', padding: 28, height: 210, boxSizing: 'border-box', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 18 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, fontWeight: 700 }}>
                    <span>The API call</span>
                    <span className="mono">$0.02</span>
                  </div>
                  <div style={{ height: 14, background: 'rgba(255,255,255,.7)', borderRadius: 99 }}>
                    <div className="grow" style={{ height: '100%', width: '6.6%', background: '#0E9F5C', borderRadius: 99 }} />
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, fontWeight: 700, color: '#8A1C12' }}>
                    <span>A typical card fee</span>
                    <span className="mono">$0.30</span>
                  </div>
                  <div style={{ height: 14, background: 'rgba(255,255,255,.7)', borderRadius: 99 }}>
                    <div className="grow" style={{ animationDelay: '.6s', height: '100%', width: '100%', background: '#B42318', borderRadius: 99 }} />
                  </div>
                </div>
              </div>
              <div style={{ padding: '24px 26px 28px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <h3 style={{ margin: 0, fontSize: 21, letterSpacing: '-0.02em' }}>Fees eat the price</h3>
                <p style={{ margin: 0, color: '#4F5753', fontSize: 16 }}>Charging a card for every 2¢ call costs more than the call itself.</p>
              </div>
            </article>
          </div>
        </div>
      </section>

      <section id="how" className="wrap sx-flat" style={{ paddingTop: 112, paddingBottom: 112, display: 'flex', flexDirection: 'column', gap: 44 }}>
        <div className="rv" style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 720 }}>
          <span className="eyebrow">HOW IT WORKS</span>
          <h2 className="h2">Like a toll pass, for&nbsp;APIs.</h2>
          <p style={{ margin: 0, fontSize: 19, color: '#3A423E' }}>Four steps. You only do the first one.</p>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 420px), 1fr))', gap: 32, alignItems: 'center' }}>
          <div role="tablist" aria-label="How it works" className="rv" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {STEPS.map(([n, title, text], k) => {
              const active = k === state.step;
              return (
                <button key={n} type="button" role="tab" aria-selected={active} className="stepbtn" onClick={() => setState((s) => pickStep(s, k))} style={active ? { background: '#F4F5F1' } : undefined}>
                  <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
                    <span className="mono" style={{ flex: 'none', width: 36, height: 36, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, transition: 'background .3s', ...(active ? { background: '#0C0F0E', color: '#2BE38A' } : { background: '#EEF0EB', color: '#3A423E' }) }}>
                      {n}
                    </span>
                    <strong style={{ fontSize: 20, letterSpacing: '-0.02em' }}>{title}</strong>
                  </div>
                  <span style={{ fontSize: 16, color: '#3A423E', paddingLeft: 50 }}>{text}</span>
                  {active ? (
                    <span style={{ margin: '4px 0 0 50px', height: 3, background: '#E2E4DE', borderRadius: 3, overflow: 'hidden', display: 'block' }}>
                      <span key={`${state.step}-${state.i - state.st}`} className="prog" style={{ display: 'block', height: '100%', background: '#0C0F0E' }} />
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
          <div className="rv2" style={{ background: '#F4F5F1', borderRadius: 28, padding: 'clamp(18px, 3vw, 36px)', minHeight: 400, boxSizing: 'border-box', display: 'flex', alignItems: 'center' }}>
            <StepPanel step={state.step} />
          </div>
        </div>
      </section>

      <section className="sx" style={{ background: '#0C0F0E', color: '#FFFFFF' }}>
        <div className="wrap" style={{ paddingTop: 112, paddingBottom: 112, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 440px), 1fr))', gap: 56, alignItems: 'center' }}>
          <div className="rv" style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
            <span className="eyebrow" style={{ color: '#2BE38A' }}>
              ONE CHARGE
            </span>
            <h2 className="h2">
              Hundreds of tiny calls. <span style={{ color: '#2BE38A' }}>One&nbsp;fee.</span>
            </h2>
            <p style={{ margin: 0, fontSize: 19, color: '#C5CEC9' }}>
              Paid calls add up on a meter. When it nears your auto-charge amount, or once a day after midnight UTC, we charge your PayPal account once.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingTop: 8 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, color: '#B4BEB8' }}>
                  <span>Charge a card on every call</span>
                  <span className="mono">143 fees</span>
                </div>
                <div style={{ height: 10, background: '#1F2724', borderRadius: 99 }}>
                  <div className="grow" style={{ height: '100%', width: '100%', background: '#FF9C8F', borderRadius: 99 }} />
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}>
                  <span style={{ fontWeight: 700 }}>PayPer402</span>
                  <span className="mono" style={{ color: '#2BE38A', fontWeight: 700 }}>
                    1 fee
                  </span>
                </div>
                <div style={{ height: 10, background: '#1F2724', borderRadius: 99 }}>
                  <div className="grow" style={{ animationDelay: '.7s', height: '100%', width: '1.5%', minWidth: 10, background: '#2BE38A', borderRadius: 99 }} />
                </div>
              </div>
            </div>
          </div>
          <div className="rv2" style={{ background: '#141A18', border: '1px solid #26302C', borderRadius: 28, padding: 30, display: 'flex', flexDirection: 'column', gap: 20, position: 'relative' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, color: '#B4BEB8' }}>
              <span className="live" style={{ width: 8, height: 8, borderRadius: '50%', background: '#2BE38A' }} />
              Not yet charged
              <span className="mono tnum" style={{ marginLeft: 'auto' }}>
                charges so far · {state.charges}
              </span>
            </div>
            <div className="mono tnum" style={{ fontSize: 'clamp(60px, 7vw, 88px)', fontWeight: 700, letterSpacing: '-0.05em', lineHeight: 1 }}>
              ${(state.cents / 100).toFixed(2)}
            </div>
            <div role="img" aria-label="Meter filling toward $5.00" style={{ display: 'grid', gridTemplateColumns: 'repeat(25, minmax(0, 1fr))', gap: 4 }}>
              {Array.from({ length: 25 }, (_, k) => (
                <span key={k} className="seg" style={{ height: 30, borderRadius: 4, background: k < filled ? '#2BE38A' : '#1F2724' }} />
              ))}
            </div>
            <div className="mono" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#7E8A84' }}>
              <span>$0.00</span>
              <span>auto-charge near $5.00</span>
            </div>
            <div style={{ minHeight: 64 }}>
              {state.flash ? (
                <div className="toast" style={{ background: '#2BE38A', color: '#0C0F0E', borderRadius: 16, padding: '14px 16px', display: 'flex', gap: 12, alignItems: 'center', fontWeight: 700 }}>
                  <Check color="currentColor" size={20} />
                  PayPal charge · $5.00 · completed
                  <span className="mono" style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 600 }}>
                    1 fee
                  </span>
                </div>
              ) : (
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', background: '#1F2724', borderRadius: 14, padding: '14px 16px', fontSize: 14 }}>
                  <span style={{ color: '#C5CEC9' }}>Last paid call</span>
                  <span style={{ color: '#EEF2EF', fontWeight: 600 }}>{state.last[0]} ×2</span>
                  <span className="mono tnum" style={{ marginLeft: 'auto', color: '#2BE38A', fontWeight: 700 }}>
                    +${((state.last[1] * 2) / 100).toFixed(2)}
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      <section id="sides" className="wrap sx-flat" style={{ paddingTop: 112, paddingBottom: 112, display: 'flex', flexDirection: 'column', gap: 36, alignItems: 'center' }}>
        <div className="rv" style={{ display: 'flex', flexDirection: 'column', gap: 14, alignItems: 'center', textAlign: 'center' }}>
          <span className="eyebrow">FOR BOTH SIDES</span>
          <h2 className="h2">One rail. Two sides of the&nbsp;call.</h2>
        </div>
        <div role="tablist" aria-label="Audience" className="rv" style={{ display: 'inline-flex', background: '#F4F5F1', borderRadius: 999, padding: 5, gap: 4 }}>
          <button type="button" role="tab" aria-selected={tab === 'op'} className="tab" onClick={() => setTab('op')} style={tab === 'op' ? on : off}>
            I run AI agents
          </button>
          <button type="button" role="tab" aria-selected={tab === 'seller'} className="tab" onClick={() => setTab('seller')} style={tab === 'seller' ? on : off}>
            I sell an API
          </button>
        </div>
        {tab === 'op' ? (
          <div key="op" className="st" style={{ width: '100%', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 420px), 1fr))', gap: 40, alignItems: 'center' }}>
            <div style={{ background: '#DDF9E9', borderRadius: 32, padding: 32, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ background: '#FFFFFF', borderRadius: 18, padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 12, boxShadow: '0 16px 36px -20px rgba(5,89,44,.45)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, fontWeight: 700 }}>
                  <span>Spent today</span>
                  <span className="mono tnum">$2.46 / $10.00</span>
                </div>
                <div style={{ height: 10, background: '#EEF0EB', borderRadius: 99, overflow: 'hidden' }}>
                  <div className="grow" style={{ height: '100%', width: '24.6%', background: '#0E9F5C' }} />
                </div>
              </div>
              <div style={{ background: '#FFFFFF', borderRadius: 18, padding: '4px 20px', boxShadow: '0 16px 36px -20px rgba(5,89,44,.45)' }}>
                {[
                  ['research-bot', '$1.84', '#0E9F5C'],
                  ['price-watcher', '$0.62', '#7C5CFF'],
                ].map(([n, p, c]) => (
                  <div key={n} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 0', borderBottom: '1px solid #EEF0EB', fontSize: 15 }}>
                    <span style={{ width: 9, height: 9, borderRadius: '50%', background: c }} />
                    <span className="mono">{n}</span>
                    <span className="mono tnum" style={{ marginLeft: 'auto', fontWeight: 700 }}>
                      {p}
                    </span>
                  </div>
                ))}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 0', fontSize: 15, color: '#4F5753' }}>
                  <span style={{ width: 9, height: 9, borderRadius: 2, background: '#B9BEB6' }} />
                  <span className="mono">translator-01</span>
                  <span style={{ marginLeft: 'auto', fontSize: 13, fontWeight: 700 }}>Paused</span>
                </div>
              </div>
              <div style={{ background: '#0C0F0E', color: '#FFFFFF', borderRadius: 16, padding: '14px 16px', fontSize: 14 }}>
                &quot;I skipped the premium news API ($0.25). The standard one covered it.&quot;
                <div style={{ color: '#2BE38A', fontWeight: 700, marginTop: 4, fontSize: 13 }}>Spend report · research-bot</div>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              <h3 style={{ margin: 0, fontSize: 'clamp(28px, 3vw, 38px)', letterSpacing: '-0.03em', lineHeight: 1.1 }}>Give agents a budget, not your card.</h3>
              <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 14, fontSize: 18 }}>
                {['Limits per call, per day and in total', 'One PayPal charge, not hundreds', 'Stop anytime from your PayPal account', 'A spend report written by the agent'].map((t) => (
                  <li key={t} style={{ display: 'flex', gap: 12 }}>
                    <Check color="#087A3D" />
                    {t}
                  </li>
                ))}
              </ul>
              <Link href="/sign-in" className="btn spec spot" onPointerMove={spot} style={{ alignSelf: 'flex-start' }}>
                <span className="sheen" aria-hidden="true" />
                Try the operator demo
                <Arrow />
              </Link>
            </div>
          </div>
        ) : (
          <div key="seller" className="st" style={{ width: '100%', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 420px), 1fr))', gap: 40, alignItems: 'center' }}>
            <div style={{ background: '#ECE8FF', borderRadius: 32, padding: 32, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ background: '#FFFFFF', borderRadius: 18, padding: '4px 20px', boxShadow: '0 16px 36px -20px rgba(58,39,153,.45)' }}>
                {[
                  ['GET', '/v1/quote', '$0.02'],
                  ['POST', '/v1/summarize', '$0.05'],
                  ['POST', '/v1/translate', '$0.01'],
                ].map(([m, p, price], k) => (
                  <div key={p} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '13px 0', borderBottom: k < 2 ? '1px solid #EEF0EB' : undefined, fontSize: 15 }}>
                    <span className="mono" style={{ fontWeight: 700, color: m === 'GET' ? '#087A3D' : '#5B3FD9' }}>
                      {m}
                    </span>
                    <span className="mono">{p}</span>
                    <span className="mono tnum" style={{ marginLeft: 'auto', background: '#FFF1D6', color: '#6B4200', borderRadius: 8, padding: '3px 9px', fontWeight: 700 }}>
                      {price}
                    </span>
                  </div>
                ))}
              </div>
              <div style={{ alignSelf: 'flex-end', background: '#FFFFFF', borderRadius: 16, padding: '12px 16px', boxShadow: '0 16px 36px -20px rgba(58,39,153,.45)', display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontSize: 13, color: '#4F5753', fontWeight: 600 }}>Settled revenue</span>
                <span className="mono tnum" style={{ fontSize: 22, fontWeight: 700 }}>
                  $4.34 net
                </span>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              <h3 style={{ margin: 0, fontSize: 'clamp(28px, 3vw, 38px)', letterSpacing: '-0.03em', lineHeight: 1.1 }}>Put a price on any endpoint.</h3>
              <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 14, fontSize: 18 }}>
                {['Price each call, from one cent', 'A few lines of standard x402 middleware', 'Settled with PayPal. No crypto, no customer accounts'].map((t) => (
                  <li key={t} style={{ display: 'flex', gap: 12 }}>
                    <Check color="#5B3FD9" />
                    {t}
                  </li>
                ))}
              </ul>
              <Link href="/sign-in" className="btn btn-ink spot" onPointerMove={spot} style={{ alignSelf: 'flex-start' }}>
                Try the seller demo
                <Arrow />
              </Link>
            </div>
          </div>
        )}
      </section>

      <section id="spec" className="sx" style={{ background: '#F4F5F1' }}>
        <div className="wrap" style={{ paddingTop: 112, paddingBottom: 112, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 440px), 1fr))', gap: 56, alignItems: 'center' }}>
          <div className="rv" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <span className="eyebrow">OPEN STANDARD</span>
            <h2 className="h2">
              <span className="mono" style={{ letterSpacing: '-0.06em' }}>
                402
              </span>{' '}
              finally means something.
            </h2>
            <p style={{ margin: 0, fontSize: 19, color: '#3A423E' }}>
              HTTP reserved <span className="mono">402 Payment Required</span> in 1997. The open x402 standard lets a server name a price and a client pay and retry, all
              inside HTTP. PayPer402 is the first PayPal rail for it.
            </p>
            <ExternalLinks repoUrl={repoUrl}>
              {({ repo, spec }) => (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                  <a href={spec} className="btn btn-ink spot" onPointerMove={spot}>
                    Read the binding spec
                  </a>
                  <a href={repo} className="btn btn-line spot" onPointerMove={spot}>
                    View on GitHub
                  </a>
                </div>
              )}
            </ExternalLinks>
          </div>
          <SpecCode />
        </div>
      </section>

      <section className="wrap sx-flat" style={{ paddingTop: 112, paddingBottom: 64, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 300px), 1fr))', gap: 20 }}>
        {[
          ['rv', '#DDF9E9', '#087A3D', <path key="a" d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z" />, <path key="b" d="m9 12 2 2 4-4" />, 'Never more than you approved', 'Every charge equals the exact sum of its paid calls.'],
          ['rv2', '#ECE8FF', '#3A2799', <path key="a" d="M4 20h16" />, <path key="b" d="M7 16V9M12 16V5M17 16v-4" />, 'Limits on every level', 'Per call, per day and in total. Agents are refused before they go over.'],
          ['rv3', '#FFF1D6', '#6B4200', <path key="a" d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3" />, null, 'Sandbox demo', "Runs on PayPal's sandbox with test money. Nothing real moves."],
        ].map(([cls, bg, stroke, p1, p2, title, text]) => (
          <div key={String(title)} className={`card ${String(cls)}`} style={{ padding: 30, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <span style={{ width: 48, height: 48, borderRadius: 14, background: String(bg), display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={String(stroke)} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                {p1 as ReactNode}
                {p2 as ReactNode}
              </svg>
            </span>
            <strong style={{ fontSize: 20, letterSpacing: '-0.02em' }}>{String(title)}</strong>
            <span style={{ color: '#4F5753', fontSize: 16 }}>{String(text)}</span>
          </div>
        ))}
      </section>

      <section className="wrap rv" style={{ maxWidth: 880, paddingTop: 48, paddingBottom: 96, display: 'flex', flexDirection: 'column', gap: 22 }}>
        <h2 className="h2">Questions</h2>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {FAQ.map(([q, a], k) => (
            <details key={q} open={k === 0} style={{ borderBottom: '1px solid #E2E4DE', padding: '22px 0' }}>
              <summary style={faqQ}>
                {q}
                <span className="chev" aria-hidden="true" style={{ fontSize: 26, lineHeight: 1, fontWeight: 400 }}>
                  +
                </span>
              </summary>
              <p style={{ margin: '10px 0 0', color: '#3A423E' }}>{a}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="wrap" style={{ paddingBottom: 96 }}>
        <div className="rv" style={{ background: '#0C0F0E', color: '#FFFFFF', borderRadius: 36, padding: 'clamp(40px, 6vw, 80px)', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 26, position: 'relative', overflow: 'hidden' }}>
          <div aria-hidden="true" style={{ position: 'absolute', inset: 0, backgroundImage: 'radial-gradient(#26302C 1.2px, transparent 1.2px)', backgroundSize: '24px 24px', WebkitMaskImage: 'radial-gradient(60% 80% at 50% 100%, #000, transparent 70%)', maskImage: 'radial-gradient(60% 80% at 50% 100%, #000, transparent 70%)' }} />
          <h2 className="h2" style={{ position: 'relative', maxWidth: 760 }}>
            Let your agent pay. <span style={{ color: '#2BE38A' }}>You stay in&nbsp;control.</span>
          </h2>
          <Link href="/sign-in" className="btn spec green spot" onPointerMove={spot} style={{ minHeight: 58, padding: '0 32px', fontSize: 17 }}>
            <span className="sheen" aria-hidden="true" />
            Try the live demo
            <Arrow />
          </Link>
        </div>
      </section>

      <footer style={{ borderTop: '1px solid #E2E4DE' }}>
        <div className="wrap" style={{ paddingTop: 32, paddingBottom: 40, display: 'flex', flexWrap: 'wrap', gap: '16px 28px', alignItems: 'center', fontSize: 15, color: '#4F5753' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: '#0C0F0E', fontWeight: 800 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={LOGO} alt="" aria-hidden="true" width={24} height={24} style={{ display: 'block', flex: 'none', objectFit: 'contain' }} />
            <span>
              PayPer<span style={{ color: '#087A3D' }}>402</span>
            </span>
          </span>
          <span>Settled with PayPal</span>
          <ExternalLinks repoUrl={repoUrl}>
            {({ repo }) => (
              <a href={repo} style={{ color: '#0C0F0E', fontWeight: 600 }}>
                GitHub
              </a>
            )}
          </ExternalLinks>
          <a href="#spec" style={{ color: '#0C0F0E', fontWeight: 600 }}>
            Spec
          </a>
          <span style={{ marginLeft: 'auto' }}>A PayPal AI Hackathon project</span>
          <a href="#top" className="btn btn-line spot topbtn" onPointerMove={spot} style={{ minHeight: 46, padding: '0 20px', fontSize: 15 }}>
            Back to top
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 19V5M6 11l6-6 6 6" />
            </svg>
          </a>
        </div>
      </footer>
      <a href="#top" className="totop" aria-label="Back to top">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 19V5M6 11l6-6 6 6" />
        </svg>
      </a>
    </div>
  );
}

const SPEC_SNIPPET = `import { paymentMiddleware } from "@x402/express";

// $0.02 per call, settled with PayPal
app.use(paymentMiddleware({
  "GET /v1/quote": { accepts: { scheme: "batch-settlement", network: "paypal:sandbox",
                                payTo: SELLER_ID, price: "$0.02" } },
}, resourceServer));
app.get("/v1/quote", quoteHandler);
`;

function SpecCode() {
  const [copied, setCopied] = useState(false);
  const k = { color: '#C79BFF' };
  const s = { color: '#2BE38A' };
  const c = { color: '#FFB020' };
  return (
    <div className="rv2" style={{ background: '#0C0F0E', borderRadius: 24, overflow: 'hidden', boxShadow: '0 40px 80px -40px rgba(12,15,14,.6)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid #1F2724' }}>
        {[0, 1, 2].map((d) => (
          <span key={d} style={{ width: 10, height: 10, borderRadius: '50%', background: '#34403B' }} />
        ))}
        <span className="mono" style={{ marginLeft: 8, fontSize: 12, color: '#7E8A84' }}>
          server.js
        </span>
        <button
          type="button"
          onClick={() => void navigator.clipboard.writeText(SPEC_SNIPPET).then(() => setCopied(true))}
          style={{ marginLeft: 'auto', background: 'transparent', border: '1px solid #34403B', color: '#C5CEC9', borderRadius: 8, padding: '5px 12px', fontSize: 13, cursor: 'pointer' }}
        >
          {copied ? 'Copied ✓' : 'Copy'}
        </button>
      </div>
      <pre className="mono" style={{ margin: 0, padding: 24, fontSize: 13.5, lineHeight: 1.8, color: '#C5CEC9', overflowX: 'auto' }}>
        <span style={k}>import</span> {'{ paymentMiddleware }'} <span style={k}>from</span> <span style={s}>&quot;@x402/express&quot;</span>;{'\n\n'}
        <span style={{ color: '#7E8A84' }}>{'// $0.02 per call, settled with PayPal'}</span>
        {'\napp.'}
        <span style={c}>use</span>(<span style={c}>paymentMiddleware</span>
        {'({\n  '}
        <span style={s}>&quot;GET /v1/quote&quot;</span>
        {': { accepts: { scheme: '}
        <span style={s}>&quot;batch-settlement&quot;</span>, network: <span style={s}>&quot;paypal:sandbox&quot;</span>
        {',\n                                payTo: SELLER_ID, price: '}
        <span style={s}>&quot;$0.02&quot;</span>
        {' } },\n}, resourceServer));\napp.'}
        <span style={c}>get</span>(<span style={s}>&quot;/v1/quote&quot;</span>, quoteHandler);
      </pre>
    </div>
  );
}
