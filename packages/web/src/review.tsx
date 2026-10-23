import { type FormEvent, useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  api,
  type Draft,
  type DraftPayload,
  type FindingPayload,
  type SecretFinding,
  type SessionView,
  type WireEvent,
} from './api';
import { agentLabel, type Person } from './model';

const SEVERITY_STYLE: Record<string, string> = {
  critical: 'bg-red-600 text-white',
  high: 'bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-200',
  medium: 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200',
  low: 'bg-sky-100 text-sky-800 dark:bg-sky-500/20 dark:text-sky-200',
  info: 'bg-slate-100 text-slate-700 dark:bg-white/10 dark:text-slate-200',
};

export function Severity({ value }: { value: string }) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${SEVERITY_STYLE[value] ?? SEVERITY_STYLE.info}`}
    >
      {value}
    </span>
  );
}

export function reviewPrompt(requestId: string, agent?: string): string {
  return agent === 'codex'
    ? `Use the pearcoder-review skill for request ${requestId.slice(0, 8)}`
    : `/pearcoder:review ${requestId.slice(0, 8)}`;
}

export interface OpenRequest {
  event: WireEvent;
  sessionId: string;
}

/** Requests addressed to `me` that `me` has not resolved. */
export function openRequestsFor(events: WireEvent[], me: string | undefined): WireEvent[] {
  if (!me) return [];
  const resolved = new Set(
    events
      .filter((e) => e.type === 'request.resolved' && e.actor_user_id === me)
      .map((e) => String(e.payload.request)),
  );
  return events.filter(
    (e) =>
      e.type === 'request.created' &&
      ((e.payload.to as string[] | undefined) ?? []).includes(me) &&
      !resolved.has(e.id),
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="rounded-md bg-pear px-2.5 py-1 text-xs font-semibold text-white hover:bg-pear/90"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      title={`Copies ${text}`}
    >
      {copied ? 'Copied' : label}
    </button>
  );
}

/** A request card: information for people, with the copy-prompt and resolve actions for addressees. */
export function RequestCard(props: {
  event: WireEvent;
  name: (id: string) => string;
  me?: string;
  session: SessionView;
  resolved: Record<string, string>;
}) {
  const p = props.event.payload;
  const to = (p.to as string[]) ?? [];
  const agent = typeof p.for_agent === 'string' ? p.for_agent : undefined;
  const forMe = props.me !== undefined && to.includes(props.me);
  // Asking your own agent needs no accept step: you are both sides.
  const fromMe = props.event.actor_user_id === props.me;
  const mine = props.resolved[props.me ?? ''] ?? (fromMe && forMe ? 'accepted' : undefined);
  const [error, setError] = useState<string | null>(null);
  const resolve = (resolution: 'accepted' | 'declined' | 'done') =>
    api
      .resolve(props.session.session_id, props.event.id, resolution)
      .catch((e: unknown) => setError(e instanceof ApiError ? e.code : 'failed'));
  return (
    <li className="my-2 rounded-xl border border-pear/30 bg-pear-soft/40 p-3 dark:bg-pear/10">
      <div className="text-xs text-slate-500">
        {props.name(props.event.actor_user_id)} asked{' '}
        {to
          .map((u) => (agent ? `${props.name(u)}'s ${agentLabel(agent)}` : props.name(u)))
          .join(', ')}{' '}
        · {String(p.kind)} · #{props.event.id.slice(0, 8)}
      </div>
      <div className="mt-1 font-semibold">{String(p.title)}</div>
      {typeof p.body === 'string' && p.body && (
        <p className="mt-1 whitespace-pre-wrap text-sm">{p.body}</p>
      )}
      {forMe && mine !== 'done' && mine !== 'declined' && String(p.kind) === 'review' && (
        <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">
          To review with your agent, run{' '}
          <code className="rounded bg-white/70 px-1 dark:bg-white/10">
            {reviewPrompt(props.event.id, agent)}
          </code>{' '}
          in {agent ? agentLabel(agent) : 'Claude Code'}, in the repository. It only saves private
          drafts.
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        {Object.entries(props.resolved).map(([user, r]) => (
          <span key={user} className="rounded bg-white/70 px-1.5 py-0.5 dark:bg-white/10">
            {props.name(user)}: {r}
          </span>
        ))}
        {forMe && !mine && (
          <>
            <CopyButton text={reviewPrompt(props.event.id, agent)} label="Copy review prompt" />
            <button
              type="button"
              className="rounded-md border px-2 py-1"
              onClick={() => void resolve('accepted')}
            >
              Accept
            </button>
            <button
              type="button"
              className="rounded-md border px-2 py-1"
              onClick={() => void resolve('declined')}
            >
              Decline
            </button>
          </>
        )}
        {forMe && mine === 'accepted' && (
          <>
            <CopyButton text={reviewPrompt(props.event.id, agent)} label="Copy review prompt" />
            <button
              type="button"
              className="rounded-md border px-2 py-1"
              onClick={() => void resolve('done')}
            >
              Mark done
            </button>
          </>
        )}
        {error && <span className="text-red-600">{error}</span>}
      </div>
      {forMe && !mine && (
        <p className="mt-2 text-[11px] text-slate-500">
          Nothing runs automatically. Paste the prompt into your own Claude Code to review with the
          restricted reviewer.
        </p>
      )}
    </li>
  );
}

export function FindingCard({ event, name }: { event: WireEvent; name: (id: string) => string }) {
  const p = event.payload;
  const location = p.location as { path?: string; start_line?: number } | undefined;
  return (
    <li className="my-2 rounded-xl border border-black/10 p-3 dark:border-white/10">
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <Severity value={String(p.severity)} />
        <span>
          {name(event.actor_user_id)}
          {event.actor_agent_id ? "'s agent (published by them)" : ''}
        </span>
        {location?.path && (
          <code className="ml-auto font-mono">
            {location.path}
            {location.start_line ? `:${location.start_line}` : ''}
          </code>
        )}
      </div>
      <div className="mt-1 font-semibold">{String(p.title)}</div>
      <p className="mt-1 whitespace-pre-wrap text-sm">{String(p.body)}</p>
    </li>
  );
}

export function PackageCard({ event, name }: { event: WireEvent; name: (id: string) => string }) {
  const p = event.payload;
  const [open, setOpen] = useState(false);
  const paths = (p.paths as string[] | undefined) ?? [];
  return (
    <li className="my-2 rounded-xl border border-dashed border-ink/20 p-3 dark:border-white/20">
      <div className="text-xs text-slate-500">
        {name(event.actor_user_id)} shared a context package · v{String(p.version ?? 1)}
      </div>
      <div className="mt-1 font-semibold">{String(p.title)}</div>
      <p className="mt-1 text-sm">{String(p.objective)}</p>
      {paths.length > 0 && (
        <p className="mt-1 font-mono text-xs text-slate-500">{paths.join(', ')}</p>
      )}
      {typeof p.body === 'string' && p.body && (
        <button
          type="button"
          className="mt-2 text-xs text-pear underline"
          onClick={() => setOpen(!open)}
        >
          {open ? 'Hide spec' : 'Show spec'}
        </button>
      )}
      {open && (
        <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded bg-mist p-2 text-xs dark:bg-black/30">
          {String(p.body)}
        </pre>
      )}
    </li>
  );
}

export function RequestForm(props: {
  session: SessionView;
  people: Person[];
  me?: string;
  packages: WireEvent[];
  onDone: () => void;
}) {
  const others = props.people.filter(
    (p) => p.active && p.userId !== props.me && p.role !== 'observer',
  );
  // People's attached agents, yours included: you can ask your own agent to review too.
  const agents = props.people
    .filter((p) => p.active && p.role !== 'observer')
    .flatMap((p) => p.agents.map((agent) => ({ person: p, agent, key: `${p.userId}:${agent}` })));
  const [to, setTo] = useState<string[]>([]);
  const [agentTargets, setAgentTargets] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [pkg, setPkg] = useState(props.packages.at(-1)?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const picked = agents.filter((a) => agentTargets.includes(a.key));
    const recipients = [...new Set([...to, ...picked.map((a) => a.person.userId)])];
    if (!recipients.length || !title.trim()) return setError('Pick who should review and a title');
    try {
      await api.request(props.session.session_id, {
        to: recipients,
        kind: 'review',
        title: title.trim(),
        ...(pkg && { context_package: pkg }),
        ...(picked[0] && { for_agent: picked[0].agent }),
      });
      props.onDone();
    } catch (e) {
      setError(e instanceof ApiError ? `${e.message} (${e.code})` : 'failed');
    }
  };
  return (
    <form
      onSubmit={submit}
      className="mb-3 space-y-2 rounded-xl border border-black/10 p-3 text-sm dark:border-white/10"
    >
      <div className="font-semibold">Ask for a review</div>
      <div className="flex flex-wrap gap-3">
        {others.length === 0 && agents.length === 0 && (
          <span className="text-slate-500">
            Nobody else can review yet. Run `pearcoder attach` to ask your own agent.
          </span>
        )}
        {others.map((p) => (
          <label key={p.userId} className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={to.includes(p.userId)}
              onChange={(e) =>
                setTo(e.target.checked ? [...to, p.userId] : to.filter((u) => u !== p.userId))
              }
            />
            {p.name}
          </label>
        ))}
        {agents.map((a) => (
          <label key={a.key} className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={agentTargets.includes(a.key)}
              onChange={(e) =>
                setAgentTargets(
                  e.target.checked
                    ? [...agentTargets, a.key]
                    : agentTargets.filter((k) => k !== a.key),
                )
              }
            />
            {a.person.userId === props.me ? 'Your' : `${a.person.name}'s`} {agentLabel(a.agent)}
          </label>
        ))}
      </div>
      <input
        aria-label="Request title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="What should they look at?"
        className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 dark:border-white/15 dark:bg-[#0c1522]"
      />
      {props.packages.length > 0 && (
        <select
          aria-label="Context package"
          value={pkg}
          onChange={(e) => setPkg(e.target.value)}
          className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 dark:border-white/15 dark:bg-[#0c1522]"
        >
          <option value="">No context package</option>
          {props.packages.map((p) => (
            <option key={p.id} value={p.id}>
              {String(p.payload.title)} (v{String(p.payload.version ?? 1)})
            </option>
          ))}
        </select>
      )}
      {error && <p className="text-red-600">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" className="rounded-lg bg-pear px-3 py-1.5 font-semibold text-white">
          Send request
        </button>
        <button type="button" className="rounded-lg border px-3 py-1.5" onClick={props.onDone}>
          Cancel
        </button>
      </div>
      <p className="text-[11px] text-slate-500">
        They get a notification. Nobody&apos;s agent starts on its own: asking someone&apos;s agent
        puts the request in their inbox, and they decide whether to run it.
      </p>
    </form>
  );
}

/** The owner's private drafts: review, edit, scan, then publish or discard. */
export function DraftsPanel(props: {
  sessions: SessionView[];
  onClose: () => void;
  onChange: () => void;
}) {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const load = useCallback(async () => {
    const { drafts: list } = await api.drafts();
    setDrafts(list.filter((d) => d.status === 'draft'));
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);
  const name = (id: string) => props.sessions.find((s) => s.session_id === id)?.session_name ?? id;
  return (
    <div
      role="dialog"
      aria-label="Drafts"
      className="fixed inset-y-0 right-0 z-10 flex w-full max-w-xl flex-col bg-white shadow-2xl dark:bg-[#111d2e]"
    >
      <div className="flex items-center border-b border-black/5 px-5 py-3 dark:border-white/10">
        <h2 className="font-semibold">Your private drafts</h2>
        <span className="ml-2 rounded bg-black/5 px-1.5 text-[10px] uppercase text-slate-500 dark:bg-white/10">
          only on this machine
        </span>
        <button type="button" className="ml-auto text-sm text-slate-500" onClick={props.onClose}>
          Close
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-5">
        {drafts.length === 0 && (
          <p className="text-slate-500">
            No drafts. When your agent reviews a request with <code>/pearcoder:review</code>, its
            findings land here first.
          </p>
        )}
        <ul className="space-y-2">
          {drafts.map((d) => (
            <li key={d.id}>
              <button
                type="button"
                onClick={() => setSelected(selected === d.id ? null : d.id)}
                className="flex w-full items-center gap-2 rounded-lg border border-black/10 p-3 text-left dark:border-white/10"
              >
                {d.kind === 'finding' ? (
                  <Severity value={d.payload.severity} />
                ) : (
                  <span className="rounded bg-black/5 px-1.5 py-0.5 text-[10px] font-semibold uppercase dark:bg-white/10">
                    {d.kind === 'code_ref' ? 'push' : 'reply'}
                  </span>
                )}
                <span className="truncate font-medium">
                  {d.kind === 'finding'
                    ? d.payload.title
                    : d.kind === 'code_ref'
                      ? `${d.payload.branch} @ ${d.payload.commit.slice(0, 7)}: ${d.payload.summary}`
                      : d.payload.text}
                </span>
                <span className="ml-auto text-xs text-slate-500">{name(d.session_id)}</span>
              </button>
              {selected === d.id && (
                <DraftEditor
                  id={d.id}
                  onDone={() => {
                    setSelected(null);
                    void load();
                    props.onChange();
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function DraftEditor({ id, onDone }: { id: string; onDone: () => void }) {
  const [payload, setPayload] = useState<DraftPayload | null>(null);
  const [findings, setFindings] = useState<SecretFinding[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const result = await api.draft(id);
    setPayload(result.draft.payload);
    setFindings(result.findings);
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);
  if (!payload) return null;

  const save = async () => {
    await api.updateDraft(id, payload);
    await load();
  };
  const publish = async (mode: 'as_is' | 'redact' | 'allow') => {
    setBusy(true);
    setError(null);
    try {
      await api.updateDraft(id, payload);
      await api.publishDraft(id, mode);
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? `${e.message} (${e.code})` : 'failed');
      await load();
    } finally {
      setBusy(false);
    }
  };
  const isReply = 'text' in payload;
  return (
    <div className="mt-2 space-y-2 rounded-lg bg-mist p-3 text-sm dark:bg-black/20">
      {isReply ? (
        <textarea
          aria-label="Reply text"
          rows={5}
          value={payload.text}
          onChange={(e) => setPayload({ ...payload, text: e.target.value })}
          className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-sm dark:border-white/15 dark:bg-[#0c1522]"
        />
      ) : 'commit' in payload ? (
        // A pushed commit's coordinates: the summary is the only part worth editing.
        <>
          <p className="font-mono text-xs">
            {payload.repo.name} {payload.branch} @ {payload.commit.slice(0, 12)}
          </p>
          <textarea
            aria-label="Push summary"
            rows={3}
            value={payload.summary}
            onChange={(e) => setPayload({ ...payload, summary: e.target.value })}
            className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-sm dark:border-white/15 dark:bg-[#0c1522]"
          />
        </>
      ) : (
        <FindingFields payload={payload} onChange={setPayload} />
      )}
      {findings.length > 0 && (
        <div
          role="alert"
          className="rounded border border-amber-400 bg-amber-50 p-2 text-amber-900 dark:bg-amber-500/10 dark:text-amber-100"
        >
          <div className="font-semibold">This draft may contain secrets or private details:</div>
          <ul className="mt-1 list-disc pl-5 text-xs">
            {findings.map((f) => (
              <li key={`${f.field}-${f.preview}`}>
                {f.kind.replaceAll('_', ' ')} in {f.field} ({f.preview})
              </li>
            ))}
          </ul>
        </div>
      )}
      {error && <p className="text-red-600">{error}</p>}
      <div className="flex flex-wrap gap-2">
        {findings.length === 0 ? (
          <button
            type="button"
            disabled={busy}
            className="rounded-lg bg-pear px-3 py-1.5 font-semibold text-white"
            onClick={() => void publish('as_is')}
          >
            Publish to session
          </button>
        ) : (
          <>
            <button
              type="button"
              disabled={busy}
              className="rounded-lg bg-pear px-3 py-1.5 font-semibold text-white"
              onClick={() => void publish('redact')}
            >
              Publish redacted
            </button>
            <button
              type="button"
              disabled={busy}
              className="rounded-lg border px-3 py-1.5"
              onClick={() => void save()}
            >
              Re-check after editing
            </button>
          </>
        )}
        <button
          type="button"
          disabled={busy}
          className="ml-auto rounded-lg border px-3 py-1.5 text-red-700"
          onClick={() => void api.discardDraft(id).then(onDone)}
        >
          Discard
        </button>
      </div>
    </div>
  );
}

const RESOLUTION_LABEL: Record<string, string> = {
  fixed: 'Fixed',
  accepted_risk: 'Accepted risk',
  wont_fix: "Won't fix",
  invalid: 'Not an issue',
};

/** A published finding with its discussion and resolution. */
export function FindingThread(props: {
  event: WireEvent;
  name: (id: string) => string;
  session: SessionView;
  replies: WireEvent[];
  resolution?: WireEvent;
  canResolve: boolean;
}) {
  const [reply, setReply] = useState('');
  const [error, setError] = useState<string | null>(null);
  const act = (type: string, payload: Record<string, unknown>, replyTo?: string) =>
    api
      .event(props.session.session_id, type, payload, replyTo)
      .then(() => setError(null))
      .catch((e: unknown) =>
        setError(e instanceof ApiError ? `${e.message} (${e.code})` : 'failed'),
      );
  const resolved = props.resolution?.payload;
  return (
    <div>
      <FindingCard event={props.event} name={props.name} />
      <div className="-mt-1 mb-3 ml-4 space-y-1 border-l-2 border-black/5 pl-3 text-sm dark:border-white/10">
        {resolved && (
          <div className="text-xs font-semibold text-pear">
            {RESOLUTION_LABEL[String(resolved.resolution)] ?? String(resolved.resolution)} ·{' '}
            {props.name(props.resolution?.actor_user_id ?? '')}
            {typeof resolved.note === 'string' && resolved.note ? `: ${resolved.note}` : ''}
          </div>
        )}
        {props.replies.map((r) => (
          <div key={r.id}>
            <span className="font-semibold">{props.name(r.actor_user_id)}:</span>{' '}
            {String(r.payload.text)}
          </div>
        ))}
        {props.session.role !== 'observer' && (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!reply.trim()) return;
              void act('message.created', { text: reply.trim() }, props.event.id).then(() =>
                setReply(''),
              );
            }}
          >
            <input
              aria-label={`Reply to ${String(props.event.payload.title)}`}
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              placeholder="Reply or object…"
              className="flex-1 rounded border border-slate-300 bg-white px-2 py-1 text-sm dark:border-white/15 dark:bg-[#0c1522]"
            />
            {props.canResolve && !resolved && (
              <select
                aria-label="Resolve finding"
                value=""
                onChange={(e) =>
                  e.target.value &&
                  void act('finding.resolved', {
                    finding: props.event.id,
                    resolution: e.target.value,
                  })
                }
                className="rounded border border-slate-300 bg-white px-2 py-1 text-sm dark:border-white/15 dark:bg-[#0c1522]"
              >
                <option value="">Resolve…</option>
                {Object.entries(RESOLUTION_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            )}
          </form>
        )}
        {error && <p className="text-xs text-red-600">{error}</p>}
      </div>
    </div>
  );
}

/** A proposed decision with everyone's stance and its outcome. */
export function DecisionCard(props: {
  event: WireEvent;
  name: (id: string) => string;
  session: SessionView;
  me?: string;
  votes: Record<string, string>;
  outcome?: WireEvent;
  canDecide: boolean;
}) {
  const p = props.event.payload;
  const [error, setError] = useState<string | null>(null);
  const act = (type: string, payload: Record<string, unknown>) =>
    api
      .event(props.session.session_id, type, payload)
      .then(() => setError(null))
      .catch((e: unknown) =>
        setError(e instanceof ApiError ? `${e.message} (${e.code})` : 'failed'),
      );
  const mine = props.me ? props.votes[props.me] : undefined;
  const outcome = props.outcome ? String(props.outcome.payload.outcome) : undefined;
  return (
    <li className="my-2 rounded-xl border-2 border-ink/15 p-3 dark:border-white/15">
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <span className="font-semibold uppercase tracking-wide">Decision</span>
        <span>proposed by {props.name(props.event.actor_user_id)}</span>
        {outcome && (
          <span
            className={`ml-auto rounded px-1.5 py-0.5 font-semibold uppercase ${outcome === 'accepted' ? 'bg-pear text-white' : 'bg-slate-200 text-slate-700'}`}
          >
            {outcome}
          </span>
        )}
      </div>
      <div className="mt-1 font-semibold">{String(p.title)}</div>
      <p className="mt-1 whitespace-pre-wrap text-sm">{String(p.decision)}</p>
      {typeof p.rationale === 'string' && p.rationale && (
        <p className="mt-1 text-sm text-slate-500">Why: {p.rationale}</p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        {Object.entries(props.votes).map(([user, stance]) => (
          <span key={user} className="rounded bg-black/5 px-1.5 py-0.5 dark:bg-white/10">
            {props.name(user)}: {stance}
          </span>
        ))}
        {!outcome &&
          props.session.role !== 'observer' &&
          (['agree', 'disagree', 'abstain'] as const).map((stance) => (
            <button
              key={stance}
              type="button"
              aria-pressed={mine === stance}
              className={`rounded-md border px-2 py-1 capitalize ${mine === stance ? 'border-pear bg-pear-soft' : ''}`}
              onClick={() => void act('decision.vote', { decision: props.event.id, stance })}
            >
              {stance}
            </button>
          ))}
        {!outcome && props.canDecide && (
          <>
            <button
              type="button"
              className="ml-auto rounded-md bg-pear px-2 py-1 font-semibold text-white"
              onClick={() =>
                void act('decision.resolved', { decision: props.event.id, outcome: 'accepted' })
              }
            >
              Accept decision
            </button>
            <button
              type="button"
              className="rounded-md border px-2 py-1"
              onClick={() =>
                void act('decision.resolved', { decision: props.event.id, outcome: 'rejected' })
              }
            >
              Reject
            </button>
          </>
        )}
        {error && <span className="text-red-600">{error}</span>}
      </div>
    </li>
  );
}

export function DecisionForm(props: { session: SessionView; onDone: () => void }) {
  const [title, setTitle] = useState('');
  const [decision, setDecision] = useState('');
  const [rationale, setRationale] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim() || !decision.trim()) return setError('A title and the decision are required');
    try {
      await api.event(props.session.session_id, 'decision.proposed', {
        title: title.trim(),
        decision: decision.trim(),
        ...(rationale.trim() && { rationale: rationale.trim() }),
      });
      props.onDone();
    } catch (e) {
      setError(e instanceof ApiError ? `${e.message} (${e.code})` : 'failed');
    }
  };
  const field =
    'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 dark:border-white/15 dark:bg-[#0c1522]';
  return (
    <form
      onSubmit={submit}
      className="mb-3 space-y-2 rounded-xl border border-black/10 p-3 text-sm dark:border-white/10"
    >
      <div className="font-semibold">Propose a decision</div>
      <input
        aria-label="Decision title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="e.g. Use compare-and-swap for token rotation"
        className={field}
      />
      <textarea
        aria-label="Decision"
        rows={2}
        value={decision}
        onChange={(e) => setDecision(e.target.value)}
        placeholder="What the team agrees to do"
        className={field}
      />
      <input
        aria-label="Rationale"
        value={rationale}
        onChange={(e) => setRationale(e.target.value)}
        placeholder="Why (optional)"
        className={field}
      />
      {error && <p className="text-red-600">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" className="rounded-lg bg-pear px-3 py-1.5 font-semibold text-white">
          Propose
        </button>
        <button type="button" className="rounded-lg border px-3 py-1.5" onClick={props.onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function FindingFields({
  payload,
  onChange,
}: {
  payload: FindingPayload;
  onChange: (p: FindingPayload) => void;
}) {
  return (
    <>
      <input
        aria-label="Finding title"
        value={payload.title}
        onChange={(e) => onChange({ ...payload, title: e.target.value })}
        className="w-full rounded border border-slate-300 bg-white px-2 py-1 font-semibold dark:border-white/15 dark:bg-[#0c1522]"
      />
      <select
        aria-label="Severity"
        value={payload.severity}
        onChange={(e) =>
          onChange({ ...payload, severity: e.target.value as FindingPayload['severity'] })
        }
        className="rounded border border-slate-300 bg-white px-2 py-1 dark:border-white/15 dark:bg-[#0c1522]"
      >
        {['info', 'low', 'medium', 'high', 'critical'].map((s) => (
          <option key={s}>{s}</option>
        ))}
      </select>
      <textarea
        aria-label="Finding body"
        rows={8}
        value={payload.body}
        onChange={(e) => onChange({ ...payload, body: e.target.value })}
        className="w-full rounded border border-slate-300 bg-white px-2 py-1 font-mono text-xs dark:border-white/15 dark:bg-[#0c1522]"
      />
    </>
  );
}
