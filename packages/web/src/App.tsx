import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ApiError,
  api,
  type Draft,
  type Me,
  ownerToken,
  type SessionView,
  subscribe,
  type WireEvent,
} from './api';
import {
  agentLabel,
  candidatesFor,
  isOnline,
  mentionedAgent,
  mergeEvents,
  openMentionsFor,
  type Person,
  participants,
  presenceLabel,
} from './model';
import {
  DecisionCard,
  DecisionForm,
  DraftsPanel,
  FindingThread,
  openRequestsFor,
  PackageCard,
  RequestCard,
  RequestForm,
} from './review';

const STATUS_LABEL: Record<SessionView['status'], string> = {
  connecting: 'Connecting…',
  online: 'Connected',
  offline: 'Reconnecting…',
  stopped: 'Disconnected',
  unreachable: 'Host unreachable',
};

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [sessions, setSessions] = useState<SessionView[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [events, setEvents] = useState<Record<string, WireEvent[]>>({});
  const [fatal, setFatal] = useState<string | null>(ownerToken ? null : 'missing-token');
  const [showDrafts, setShowDrafts] = useState(false);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const draftCount = drafts.filter((d) => d.status === 'draft').length;
  const countDrafts = useCallback(async () => {
    setDrafts((await api.drafts()).drafts);
  }, []);
  useEffect(() => {
    if (!ownerToken) return;
    void countDrafts().catch(() => undefined);
    // Drafts are written by the agent's MCP process, so the UI polls for them.
    const timer = setInterval(() => void countDrafts().catch(() => undefined), 5000);
    return () => clearInterval(timer);
  }, [countDrafts]);

  const loadSession = useCallback(async (id: string) => {
    const { events: snapshot } = await api.events(id);
    setEvents((all) => ({ ...all, [id]: mergeEvents(all[id] ?? [], snapshot) }));
  }, []);

  const refresh = useCallback(async () => {
    const { sessions: list } = await api.sessions();
    setSessions(list);
    setActiveId((current) => current ?? list[0]?.session_id ?? null);
    await Promise.all(list.map((s) => loadSession(s.session_id)));
  }, [loadSession]);

  useEffect(() => {
    if (!ownerToken) return;
    api
      .me()
      .then(setMe)
      .catch((error: unknown) => setFatal(error instanceof ApiError ? error.code : 'offline'));
    void refresh().catch(() => undefined);
    const stop = subscribe(
      (update) => {
        if (update.type === 'event') {
          setEvents((all) => ({
            ...all,
            [update.session_id]: mergeEvents(all[update.session_id] ?? [], [update.event]),
          }));
        } else {
          setSessions((list) =>
            list.map((s) =>
              s.session_id === update.session_id
                ? { ...s, status: update.status, ...(update.error ? { error: update.error } : {}) }
                : s,
            ),
          );
        }
      },
      () => void refresh().catch(() => undefined),
    );
    const poll = setInterval(() => void refresh().catch(() => undefined), 15_000);
    return () => {
      stop();
      clearInterval(poll);
    };
  }, [refresh]);

  if (fatal) return <Locked reason={fatal} />;

  const active = sessions.find((s) => s.session_id === activeId) ?? null;
  const activeEvents = activeId ? (events[activeId] ?? []) : [];
  const self =
    me && active ? { userId: me.user_id, online: active.status === 'online' } : undefined;
  const activePeople = participants(activeEvents, self);
  const inbox = sessions.flatMap((s) =>
    [
      ...openMentionsFor(events[s.session_id] ?? [], me?.user_id),
      ...openRequestsFor(events[s.session_id] ?? [], me?.user_id),
    ].map((event) => ({ event, session: s })),
  );

  return (
    <div className="flex h-dvh flex-col">
      <Header
        session={active}
        people={activePeople}
        draftCount={draftCount}
        onDrafts={() => setShowDrafts(true)}
      />
      {showDrafts && (
        <DraftsPanel
          sessions={sessions}
          onClose={() => setShowDrafts(false)}
          onChange={() => void countDrafts()}
        />
      )}
      <div className="flex min-h-0 flex-1">
        <Sidebar
          sessions={sessions}
          activeId={activeId}
          onSelect={setActiveId}
          onForget={async (id) => {
            await api.forgetSession(id).catch(() => undefined);
            if (activeId === id) setActiveId(null);
            await refresh().catch(() => undefined);
          }}
          people={activePeople}
          me={me}
          inbox={inbox}
        />
        <main className="flex min-w-0 flex-1 flex-col bg-white dark:bg-[#111d2e]">
          {active ? (
            <Conversation
              key={active.session_id}
              session={active}
              events={activeEvents}
              me={me}
              drafts={drafts.filter((d) => d.session_id === active.session_id)}
              onDrafts={() => void countDrafts().catch(() => undefined)}
              onEditDrafts={() => setShowDrafts(true)}
            />
          ) : (
            <EmptyState />
          )}
        </main>
      </div>
    </div>
  );
}

function Header({
  session,
  people,
  draftCount,
  onDrafts,
}: {
  session: SessionView | null;
  people: Person[];
  draftCount: number;
  onDrafts: () => void;
}) {
  const online = people.filter(isOnline).length;
  return (
    <header className="flex items-center gap-3 bg-ink px-5 py-3 text-white">
      <span className="font-semibold tracking-wide">PEARCODER</span>
      {session && (
        <>
          <span className="text-white/40">/</span>
          <span className="truncate font-semibold">{session.session_name}</span>
          <span
            className={`ml-2 rounded-full px-2 py-0.5 text-xs ${
              session.status === 'online'
                ? 'bg-pear/30 text-pear-soft'
                : 'bg-amber-400/20 text-amber-200'
            }`}
            title={session.error}
          >
            {STATUS_LABEL[session.status]}
          </span>
          <span className="ml-auto text-sm text-pear-soft">{online} online</span>
        </>
      )}
      {session && (
        <button
          type="button"
          onClick={() => void api.exportMarkdown(session.session_id, session.session_name)}
          className="rounded-lg bg-white/10 px-3 py-1 text-sm hover:bg-white/20"
          title="Download the review: findings, decisions and action items"
        >
          Export
        </button>
      )}
      <button
        type="button"
        onClick={onDrafts}
        className={`${session ? '' : 'ml-auto '}rounded-lg bg-white/10 px-3 py-1 text-sm hover:bg-white/20`}
      >
        Drafts{draftCount > 0 ? ` (${draftCount})` : ''}
      </button>
    </header>
  );
}

function Sidebar(props: {
  sessions: SessionView[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onForget: (id: string) => Promise<void>;
  people: Person[];
  me: Me | null;
  inbox: { event: WireEvent; session: SessionView }[];
}) {
  return (
    <aside className="hidden w-64 shrink-0 flex-col gap-6 overflow-y-auto border-r border-black/5 bg-mist p-4 md:flex dark:border-white/10 dark:bg-[#0c1522]">
      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
          Sessions
        </h2>
        <ul className="space-y-1">
          {props.sessions.map((s) => {
            const ended = s.status === 'unreachable' || s.status === 'stopped';
            // Same-named sessions (a host restarted without --persist) get their short id.
            const twin = props.sessions.some(
              (o) => o.session_id !== s.session_id && o.session_name === s.session_name,
            );
            return (
              <li key={s.session_id} className="group flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => props.onSelect(s.session_id)}
                  className={`min-w-0 flex-1 truncate rounded-lg px-3 py-2 text-left text-sm ${
                    s.session_id === props.activeId
                      ? 'bg-pear-soft font-semibold text-ink dark:bg-pear/30 dark:text-white'
                      : 'hover:bg-black/5 dark:hover:bg-white/5'
                  } ${ended ? 'text-slate-400' : ''}`}
                >
                  # {s.session_name}
                  {twin && (
                    <span className="text-xs text-slate-400"> {s.session_id.slice(2, 8)}</span>
                  )}
                  {ended && <span className="ml-1 text-xs">· ended</span>}
                </button>
                {ended && (
                  <button
                    type="button"
                    title="Forget this session on this device"
                    aria-label={`Forget ${s.session_name}`}
                    onClick={() => void props.onForget(s.session_id)}
                    className="rounded px-1.5 py-1 text-xs text-slate-400 hover:bg-black/5 hover:text-red-600 dark:hover:bg-white/5"
                  >
                    Forget
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </section>
      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
          Inbox{props.inbox.length > 0 ? ` (${props.inbox.length})` : ''}
        </h2>
        {props.inbox.length === 0 ? (
          <p className="text-xs text-slate-500">Nothing waiting for you.</p>
        ) : (
          <ul className="space-y-1">
            {props.inbox.map(({ event, session }) => (
              <li key={event.id}>
                <button
                  type="button"
                  onClick={() => props.onSelect(session.session_id)}
                  className="w-full rounded-lg bg-white/70 px-3 py-2 text-left text-sm hover:bg-white dark:bg-white/5"
                >
                  <span className="block truncate font-medium">
                    {event.type === 'message.created'
                      ? String(event.payload.text)
                      : String(event.payload.title)}
                  </span>
                  <span className="block truncate text-xs text-slate-500">
                    {event.type === 'message.created'
                      ? mentionedAgent(event, props.me?.user_id)
                        ? `mentions your ${agentLabel(mentionedAgent(event, props.me?.user_id) ?? '')}`
                        : 'mentions you'
                      : String(event.payload.kind)}{' '}
                    · #{session.session_name}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
          Participants
        </h2>
        <ul className="space-y-2">
          {props.people.map((p) => (
            <li key={p.userId} className={`text-sm ${p.active ? '' : 'opacity-50'}`}>
              <div className="flex items-center gap-2">
                <span
                  aria-hidden
                  title={presenceLabel(p)}
                  className={`h-2 w-2 shrink-0 rounded-full ${isOnline(p) ? 'bg-pear' : p.presence === 'joined' ? 'border border-slate-400' : 'bg-slate-400'}`}
                />
                <span className="truncate">
                  {p.name}
                  {p.userId === props.me?.user_id && <span className="text-slate-500"> (you)</span>}
                </span>
                {p.role !== 'member' && (
                  <span className="ml-auto rounded bg-black/5 px-1.5 text-[10px] uppercase text-slate-500 dark:bg-white/10">
                    {p.role}
                  </span>
                )}
                <span className="sr-only">{presenceLabel(p)}</span>
              </div>
              {p.active &&
                p.agents.map((agent) => (
                  <div
                    key={agent}
                    className="ml-4 truncate text-xs text-slate-500"
                    title="Attached with pearcoder attach. It only runs when its owner starts it."
                  >
                    ↳ {p.userId === props.me?.user_id ? 'your' : `${p.name}'s`} {agentLabel(agent)}
                  </div>
                ))}
            </li>
          ))}
        </ul>
      </section>
    </aside>
  );
}

function Conversation({
  session,
  events,
  me,
  drafts,
  onDrafts,
  onEditDrafts,
}: {
  session: SessionView;
  events: WireEvent[];
  me: Me | null;
  drafts: Draft[];
  onDrafts: () => void;
  onEditDrafts: () => void;
}) {
  // The owner's per-session agent setting (ADR-0006); on unless they turned it off.
  const [auto, setAuto] = useState<boolean | null>(null);
  useEffect(() => {
    api
      .agentPolicy(session.session_id)
      .then((p) => setAuto(p.auto))
      .catch(() => setAuto(null));
  }, [session.session_id]);
  const myAgents = me
    ? (participants(events).find((p) => p.userId === me.user_id)?.agents ?? [])
    : [];
  const toggleAuto = async (value: boolean) => {
    setAuto((await api.setAgentPolicy(session.session_id, value)).auto);
  };
  // The agent's pending reply drafts, shown under the message they answer.
  const replyDrafts = new Map(
    drafts
      .filter((d) => d.kind === 'reply' && d.status === 'draft')
      .map((d) => [d.kind === 'reply' ? d.payload.reply_to : '', d]),
  );
  const names = useMemo(
    () => new Map(participants(events).map((p) => [p.userId, p.name])),
    [events],
  );
  const findingIds = useMemo(
    () => new Set(events.filter((e) => e.type === 'review.finding').map((e) => e.id)),
    [events],
  );
  // Cards render their own follow-ups (resolutions, stances, replies), so the stream skips them.
  const visible = events.filter(
    (e) =>
      ![
        'presence.changed',
        'request.resolved',
        'finding.resolved',
        'decision.vote',
        'decision.resolved',
      ].includes(e.type) &&
      !(e.type === 'message.created' && e.reply_to && findingIds.has(e.reply_to)),
  );
  const name = (id: string) => names.get(id) ?? 'Someone';
  const thread = useMemo(() => {
    const resolutions = new Map<string, Record<string, string>>();
    const replies = new Map<string, WireEvent[]>();
    const findingResolution = new Map<string, WireEvent>();
    const votes = new Map<string, Record<string, string>>();
    const outcomes = new Map<string, WireEvent>();
    for (const e of events) {
      const ref = (key: string) => String(e.payload[key]);
      if (e.type === 'request.resolved') {
        resolutions.set(ref('request'), {
          ...resolutions.get(ref('request')),
          [e.actor_user_id]: ref('resolution'),
        });
      } else if (e.type === 'finding.resolved') findingResolution.set(ref('finding'), e);
      else if (e.type === 'decision.vote') {
        votes.set(ref('decision'), {
          ...votes.get(ref('decision')),
          [e.actor_user_id]: ref('stance'),
        });
      } else if (e.type === 'decision.resolved') outcomes.set(ref('decision'), e);
      else if (e.type === 'message.created' && e.reply_to) {
        replies.set(e.reply_to, [...(replies.get(e.reply_to) ?? []), e]);
      }
    }
    return { resolutions, replies, findingResolution, votes, outcomes };
  }, [events]);
  const requestAuthor = (requestId: unknown) =>
    events.find((e) => e.id === requestId && e.type === 'request.created')?.actor_user_id;
  const isHost = session.role === 'host';
  const packages = events.filter((e) => e.type === 'context_package.published');
  const people = useMemo(() => participants(events), [events]);
  const labels = useMemo(() => candidatesFor(people).map((c) => c.label), [people]);
  const bottom = useRef<HTMLDivElement>(null);
  const count = visible.length;
  useEffect(() => {
    // Scroll to the newest event whenever the number of visible events changes.
    if (count > 0) bottom.current?.scrollIntoView({ block: 'end' });
  }, [count]);

  return (
    <>
      {myAgents.length > 0 && auto !== null && (
        <div
          role="status"
          className={`flex items-center gap-3 border-b px-8 py-2 text-sm ${
            auto
              ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100'
              : 'border-black/5 text-slate-500 dark:border-white/10'
          }`}
        >
          <span className="flex-1">
            {auto
              ? `Auto is on: while /pearcoder:listen runs, your ${agentLabel(myAgents[0] ?? '')} answers @mentions and review requests here, and Pearcoder sends its replies without asking you (after a secret scan).`
              : `Auto is off: your ${agentLabel(myAgents[0] ?? '')} waits for you to let it handle each item, and its replies wait for Send.`}
          </span>
          <button
            type="button"
            onClick={() => void toggleAuto(!auto)}
            className="rounded-md border border-current px-2 py-0.5 text-xs font-semibold"
          >
            {auto ? 'Turn off' : 'Turn on'}
          </button>
        </div>
      )}
      <ol className="flex-1 space-y-1 overflow-y-auto px-8 py-6" aria-live="polite">
        {visible.map((event) =>
          event.type === 'request.created' ? (
            <RequestCard
              key={event.sequence}
              event={event}
              name={name}
              session={session}
              resolved={thread.resolutions.get(event.id) ?? {}}
              {...(me ? { me: me.user_id } : {})}
            />
          ) : event.type === 'review.finding' ? (
            <li key={event.sequence}>
              <FindingThread
                event={event}
                name={name}
                session={session}
                replies={thread.replies.get(event.id) ?? []}
                canResolve={
                  isHost ||
                  event.actor_user_id === me?.user_id ||
                  requestAuthor(event.payload.request) === me?.user_id
                }
                {...(thread.findingResolution.get(event.id) && {
                  resolution: thread.findingResolution.get(event.id),
                })}
              />
            </li>
          ) : event.type === 'decision.proposed' ? (
            <DecisionCard
              key={event.sequence}
              event={event}
              name={name}
              session={session}
              votes={thread.votes.get(event.id) ?? {}}
              canDecide={isHost || event.actor_user_id === me?.user_id}
              {...(me ? { me: me.user_id } : {})}
              {...(thread.outcomes.get(event.id) && { outcome: thread.outcomes.get(event.id) })}
            />
          ) : event.type === 'context_package.published' ? (
            <PackageCard key={event.sequence} event={event} name={name} />
          ) : (
            <EventRow
              key={event.sequence}
              event={event}
              name={name(event.actor_user_id)}
              labels={labels}
              {...(me ? { me: me.user_id } : {})}
              mine={event.actor_user_id === me?.user_id}
              draft={replyDrafts.get(event.id)}
              onDrafts={onDrafts}
              onEditDrafts={onEditDrafts}
              auto={auto}
              sessionId={session.session_id}
            />
          ),
        )}
        <div ref={bottom} />
      </ol>
      <Composer
        session={session}
        people={people}
        packages={packages}
        {...(me ? { me: me.user_id } : {})}
      />
    </>
  );
}

/**
 * A reply the owner's agent drafted, under the message it answers. Sending is the owner's click,
 * and the local node still scans it for secrets first.
 */
function InlineDraft({
  draft,
  onChange,
  onEdit,
}: {
  draft: Draft;
  onChange?: (() => void) | undefined;
  onEdit?: (() => void) | undefined;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (draft.kind !== 'reply') return null;
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChange?.();
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === 'SECRETS_FOUND'
          ? 'It may contain a secret: open it in Drafts to redact it first.'
          : e instanceof ApiError
            ? `${e.message} (${e.code})`
            : 'failed',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-2 rounded-lg border border-dashed border-pear/50 bg-pear-soft/30 p-2 text-sm dark:bg-pear/10">
      <div className="text-xs text-slate-500">
        Your {agentLabel(draft.source.harness === 'codex' ? 'codex' : 'claude-code')} drafted a
        reply · private until you send it
      </div>
      <p className="mt-1 whitespace-pre-wrap">{draft.payload.text}</p>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      <div className="mt-2 flex gap-2 text-xs">
        <button
          type="button"
          disabled={busy}
          className="rounded-md bg-pear px-2 py-1 font-semibold text-white"
          onClick={() => void act(() => api.publishDraft(draft.id, 'as_is'))}
        >
          Send
        </button>
        <button type="button" className="rounded-md border px-2 py-1" onClick={onEdit}>
          Edit in Drafts
        </button>
        <button
          type="button"
          disabled={busy}
          className="rounded-md border px-2 py-1"
          onClick={() => void act(() => api.discardDraft(draft.id))}
        >
          Discard
        </button>
      </div>
    </div>
  );
}

/** Message text with `@` mentions highlighted. Text only: nothing in it is ever rendered as HTML. */
function MessageText({ text, labels }: { text: string; labels: string[] }) {
  const sorted = [...labels].sort((a, b) => b.length - a.length);
  const parts: { at: number; text: string; mention: boolean }[] = [];
  let start = 0;
  for (let i = text.indexOf('@'); i !== -1; i = text.indexOf('@', i + 1)) {
    if (i > 0 && /[\p{L}\p{N}_]/u.test(text.charAt(i - 1))) continue;
    const after = text.slice(i + 1).toLowerCase();
    const label = sorted.find(
      (l) => after.startsWith(l.toLowerCase()) && !/[\p{L}\p{N}_]/u.test(after.charAt(l.length)),
    );
    if (!label) continue;
    if (i > start) parts.push({ at: start, text: text.slice(start, i), mention: false });
    parts.push({ at: i, text: text.slice(i, i + 1 + label.length), mention: true });
    start = i + 1 + label.length;
    i = start - 1;
  }
  if (start < text.length) parts.push({ at: start, text: text.slice(start), mention: false });
  return (
    <p className="mt-1 whitespace-pre-wrap break-words">
      {parts.map((p) =>
        p.mention ? (
          <span
            key={p.at}
            className="rounded bg-pear-soft px-0.5 font-medium text-pear dark:bg-pear/20"
          >
            {p.text}
          </span>
        ) : (
          <span key={p.at}>{p.text}</span>
        ),
      )}
    </p>
  );
}

function EventRow({
  event,
  name,
  mine,
  labels = [],
  me,
  draft,
  onDrafts,
  onEditDrafts,
  auto = null,
  sessionId,
}: {
  event: WireEvent;
  name: string;
  mine: boolean;
  labels?: string[];
  me?: string;
  draft?: Draft | undefined;
  onDrafts?: () => void;
  onEditDrafts?: () => void;
  auto?: boolean | null;
  sessionId?: string;
}) {
  const [allowed, setAllowed] = useState(false);
  const time = new Date(event.received_at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  if (event.type === 'message.created') {
    return (
      <li className="border-b border-black/5 py-3 dark:border-white/5">
        <div className="text-sm font-semibold text-pear">
          {mine ? 'You' : name} <span className="font-normal text-slate-400">· {time}</span>
        </div>
        <MessageText text={String(event.payload.text ?? '')} labels={labels} />
        {draft && <InlineDraft draft={draft} onChange={onDrafts} onEdit={onEditDrafts} />}
        {!draft && mentionedAgent(event, me) && (
          <p className="mt-1 text-xs text-slate-500">
            This mentions your {agentLabel(mentionedAgent(event, me) ?? '')}.{' '}
            {auto === false && !allowed && sessionId ? (
              <button
                type="button"
                className="rounded-md border px-2 py-0.5 font-semibold text-pear"
                onClick={() =>
                  void api
                    .allowAgent(sessionId, event.id)
                    .then(() => setAllowed(true))
                    .catch(() => undefined)
                }
              >
                Let my {agentLabel(mentionedAgent(event, me) ?? '')} handle this
              </button>
            ) : auto === false ? (
              'Allowed: it picks this up while /pearcoder:listen runs, and its reply waits for your Send.'
            ) : (
              <>
                It answers while /pearcoder:listen runs; or run{' '}
                <code className="rounded bg-black/5 px-1 dark:bg-white/10">
                  /pearcoder:discuss {event.id.slice(0, 8)}
                </code>{' '}
                in it.
              </>
            )}
          </p>
        )}
      </li>
    );
  }
  const what =
    event.type === 'participant.joined'
      ? `joined as ${String(event.payload.role)}`
      : event.type === 'participant.left'
        ? 'left'
        : event.type;
  return (
    <li className="py-1 text-center text-xs text-slate-400">
      {mine ? 'You' : name} {what} · {time}
    </li>
  );
}

function Composer({
  session,
  people,
  packages,
  me,
}: {
  session: SessionView;
  people: Person[];
  packages: WireEvent[];
  me?: string;
}) {
  const [asking, setAsking] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const readOnly = session.role === 'observer';
  // `@` autocomplete: the word being typed after the last `@` filters people and their agents.
  const query = /(?:^|\s)@([^@\n]{0,40})$/.exec(text)?.[1];
  const suggestions =
    query === undefined
      ? []
      : candidatesFor(people)
          .filter((c) => c.user !== me || c.agent)
          .filter((c) => c.label.toLowerCase().startsWith(query.toLowerCase()))
          .slice(0, 6);
  const pickSuggestion = (label: string) => {
    setText(`${text.slice(0, text.length - (query?.length ?? 0))}${label} `);
    setHighlight(0);
  };

  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    setError(null);
    try {
      await api.say(session.session_id, value);
      setText('');
    } catch (err) {
      setError(
        err instanceof ApiError
          ? `${err.message || 'Could not send'} (${err.code})`
          : 'Could not send',
      );
    } finally {
      setSending(false);
    }
  };

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions.length) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : suggestions.length - 1;
        setHighlight((highlight + step) % suggestions.length);
        return;
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
        event.preventDefault();
        const pick = suggestions[Math.min(highlight, suggestions.length - 1)];
        if (pick) pickSuggestion(pick.label);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <div className="border-t border-black/5 p-4 dark:border-white/10">
      {/* A sibling, not a child: nested forms are invalid and would submit the composer. */}
      {asking && (
        <RequestForm
          session={session}
          people={people}
          packages={packages}
          onDone={() => setAsking(false)}
          {...(me ? { me } : {})}
        />
      )}
      {deciding && <DecisionForm session={session} onDone={() => setDeciding(false)} />}
      <form onSubmit={send}>
        {error && (
          <p role="alert" className="mb-2 text-sm text-red-600">
            {error}
          </p>
        )}
        {suggestions.length > 0 && (
          <ul
            aria-label="Mention someone"
            className="mb-2 max-w-sm overflow-hidden rounded-xl border border-black/10 bg-white text-sm shadow dark:border-white/10 dark:bg-[#0c1522]"
          >
            {suggestions.map((c, i) => (
              <li key={`${c.user}:${c.agent ?? ''}`}>
                <button
                  type="button"
                  aria-pressed={i === highlight}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickSuggestion(c.label);
                  }}
                  className={`block w-full px-3 py-1.5 text-left ${i === highlight ? 'bg-pear-soft dark:bg-pear/20' : ''}`}
                >
                  @{c.user === me && c.agent ? `your ${agentLabel(c.agent)}` : c.label}
                  {c.agent && (
                    <span className="ml-2 text-xs text-slate-500">
                      agent · gets it in their inbox
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          aria-label="Message"
          rows={1}
          value={text}
          disabled={readOnly}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          placeholder={
            readOnly
              ? 'You are an observer in this session'
              : 'Message the session… (@ to mention, Enter to send)'
          }
          className="w-full resize-none rounded-xl border border-slate-300 bg-white px-4 py-3 outline-none focus:border-pear disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/15 dark:bg-[#0c1522]"
        />
        {!readOnly && !asking && !deciding && (
          <div className="mt-2 flex gap-4 text-xs">
            <button type="button" onClick={() => setAsking(true)} className="text-pear underline">
              Ask someone for a review
            </button>
            <button type="button" onClick={() => setDeciding(true)} className="text-pear underline">
              Propose a decision
            </button>
          </div>
        )}
      </form>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="m-auto max-w-md p-8 text-center">
      <h1 className="text-xl font-semibold">No sessions yet</h1>
      <p className="mt-2 text-slate-500">Start one in your terminal, or join with an invitation:</p>
      <pre className="mt-4 rounded-lg bg-mist p-3 text-left font-mono text-sm dark:bg-black/30">
        pearcoder host --name auth-review{'\n'}pearcoder join pc1_…
      </pre>
    </div>
  );
}

function Locked({ reason }: { reason: string }) {
  return (
    <div className="m-auto max-w-md p-8 text-center">
      <h1 className="text-xl font-semibold">Open Pearcoder from your terminal</h1>
      <p className="mt-2 text-slate-500">
        {reason === 'missing-token' || reason === 'UNAUTHORIZED'
          ? 'This page needs the private link printed by `pearcoder ui`. Run it again to get a fresh one.'
          : 'The local Pearcoder node is not running. Start it with `pearcoder ui`.'}
      </p>
    </div>
  );
}
