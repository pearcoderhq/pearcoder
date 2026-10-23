import { type FormEvent, useState } from 'react';
import {
  type AgentItemView,
  type AgentPolicy,
  ApiError,
  api,
  type SessionView,
  type WireEvent,
} from './api';
import { type AgentState, agentLabel, type ItemActivity, type Person } from './model';

// Building together (ADR-0007): the owner's two auto modes, approving other people's items for
// their agent (as is or rewritten), what everyone's agent is doing, tasks, and pushed commits.
// Code never travels through Pearcoder: a pushed commit shows as coordinates, and nothing here
// checks out, fetches or runs anything.

const errorText = (e: unknown) =>
  e instanceof ApiError ? `${e.message || 'failed'} (${e.code})` : 'failed';

/** The owner's agent settings for this session, with what each one means. */
export function AgentBar({
  session,
  agent,
  policy,
  onPolicy,
}: {
  session: SessionView;
  agent: string;
  policy: AgentPolicy;
  onPolicy: (policy: AgentPolicy) => void;
}) {
  const [open, setOpen] = useState(false);
  const label = agentLabel(agent);
  const set = async (fn: () => Promise<AgentPolicy>) => onPolicy(await fn());
  const toggle = (on: boolean, onClick: () => void, name: string) => (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={name}
      onClick={onClick}
      className={`rounded-md border px-2 py-0.5 text-xs font-semibold ${on ? 'border-pear bg-pear text-white' : 'border-current'}`}
    >
      {on ? 'On' : 'Off'}
    </button>
  );
  return (
    <div
      role="status"
      className={`border-b px-8 py-2 text-sm ${
        policy.others
          ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100'
          : 'border-black/5 text-slate-600 dark:border-white/10 dark:text-slate-300'
      }`}
    >
      <div className="flex items-center gap-3">
        <span className="flex-1">
          Your {label}:{' '}
          {policy.mine ? 'your messages go straight to it' : 'your messages wait for you'} ·{' '}
          {policy.others
            ? "others' messages go to it without asking you"
            : "others' messages wait for your approval"}
        </span>
        <button type="button" className="text-xs underline" onClick={() => setOpen(!open)}>
          {open ? 'Close' : 'Settings'}
        </button>
      </div>
      {open && (
        <ul className="mt-2 space-y-2 text-xs">
          <li className="flex items-start gap-3">
            {toggle(
              policy.mine,
              () => void set(() => api.setAgentMode(session.session_id, 'mine', !policy.mine)),
              'Your messages to your agent',
            )}
            <span>
              <strong>Your messages.</strong> When you @mention your {label} or give it a task, it
              starts while /pearcoder:listen or /pearcoder:dev runs, and Pearcoder sends what it
              answers or pushes. Only messages signed by this device count.
            </span>
          </li>
          <li className="flex items-start gap-3">
            {toggle(
              policy.others,
              () => void set(() => api.setAgentMode(session.session_id, 'others', !policy.others)),
              "Others' messages to your agent",
            )}
            <span>
              <strong>Others' messages.</strong> Off: each one waits until you approve it, or
              rewrite it and approve. On: anyone in this session can make your {label} answer, and
              its replies are sent without you reading them (after a secret scan). A crafted message
              could mislead it. Others' messages never lead to code changes unless you rewrite them.
            </span>
          </li>
          <li className="flex items-start gap-3">
            {toggle(
              policy.share_status,
              () => void set(() => api.setShareStatus(session.session_id, !policy.share_status)),
              'Share what your agent is doing',
            )}
            <span>
              <strong>Status.</strong> Others see whether your {label} is waiting for you, working
              or done. Never what it reads or writes.
            </span>
          </li>
        </ul>
      )}
    </div>
  );
}

const STATE_TEXT: Record<AgentState, string> = {
  idle: 'idle',
  listening: 'listening',
  waiting_owner: 'waiting for its owner',
  approved: 'approved',
  working: 'working on it…',
  done: 'done',
  declined: 'declined by its owner',
};

/** What each addressed agent is doing about this item, as its owner's node reports it. */
export function ActivityLine({
  activity,
  name,
  me,
}: {
  activity: ItemActivity[];
  name: (id: string) => string;
  me?: string | undefined;
}) {
  const others = activity.filter((a) => a.user !== me);
  if (!others.length) return null;
  return (
    <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-slate-500" aria-live="polite">
      {others.map((a) => (
        <span key={`${a.user}:${a.agent}`}>
          <span
            aria-hidden
            className={`mr-1 inline-block h-1.5 w-1.5 rounded-full ${a.state === 'working' ? 'animate-pulse bg-pear' : a.state === 'declined' ? 'bg-red-400' : 'bg-slate-400'}`}
          />
          {name(a.user)}'s {agentLabel(a.agent)}:{' '}
          {a.state === 'waiting_owner'
            ? `waiting for ${name(a.user)}`
            : a.state === 'approved' && a.edited
              ? `approved with edits by ${name(a.user)}`
              : a.state === 'working' && a.edited
                ? `working on ${name(a.user)}'s edited version…`
                : STATE_TEXT[a.state]}
        </span>
      ))}
    </p>
  );
}

/**
 * The owner's controls for an item aimed at their agent: approve, rewrite and approve, decline,
 * or stop the run working on it. The rewritten text stays on this machine.
 */
export function OwnerGate({
  sessionId,
  item,
  agent,
  original,
  onChange,
}: {
  sessionId: string;
  item: AgentItemView;
  agent: string;
  original: string;
  onChange: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(original);
  const [error, setError] = useState<string | null>(null);
  const label = agentLabel(agent);
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      setEditing(false);
      onChange();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const status =
    item.state === 'working'
      ? `Your ${label} is working on this${item.flow === 'dev' ? ' and may push code' : ''}.`
      : item.state === 'handled'
        ? `Your ${label} handled this.`
        : item.gate === 'declined'
          ? `You declined this for your ${label}.`
          : item.gate === 'edited'
            ? `Approved with your edits: your ${label} reads your version.`
            : item.gate === 'approved'
              ? `Approved: your ${label} picks it up while /pearcoder:listen runs.`
              : item.gate === 'auto'
                ? `Your ${label} picks this up while ${item.by_owner ? '/pearcoder:dev or /pearcoder:listen' : '/pearcoder:listen'} runs.`
                : `This asks your ${label}. It waits for you.`;
  return (
    <div className="mt-2 rounded-lg border border-black/10 p-2 text-xs dark:border-white/10">
      <p className="text-slate-600 dark:text-slate-300">
        {status}
        {item.gate === 'edited' && item.edited_text && (
          <span className="mt-1 block whitespace-pre-wrap rounded bg-black/5 p-1.5 dark:bg-white/10">
            {item.edited_text}
          </span>
        )}
      </p>
      {editing ? (
        <form
          className="mt-2"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void act(() => api.allowAgent(sessionId, item.id, text.trim()));
          }}
        >
          <label className="block text-slate-500" htmlFor={`edit-${item.id}`}>
            Your version, which your {label} reads instead. It stays on your machine; the session
            only sees "approved with edits". Your version can lead to code changes.
          </label>
          <textarea
            id={`edit-${item.id}`}
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="mt-1 w-full rounded-md border border-slate-300 bg-white p-2 dark:border-white/15 dark:bg-[#0c1522]"
          />
          <div className="mt-1 flex gap-2">
            <button
              type="submit"
              disabled={!text.trim()}
              className="rounded-md bg-pear px-2 py-1 font-semibold text-white"
            >
              Approve my version
            </button>
            <button
              type="button"
              className="rounded-md border px-2 py-1"
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="mt-2 flex flex-wrap gap-2">
          {item.state === 'working' && (
            <button
              type="button"
              className="rounded-md border border-red-400 px-2 py-1 font-semibold text-red-600"
              onClick={() => void act(() => api.stopAgent(sessionId, item.id))}
            >
              Stop
            </button>
          )}
          {item.state === 'open' && (item.gate === 'waiting' || item.gate === 'declined') && (
            <>
              <button
                type="button"
                className="rounded-md bg-pear px-2 py-1 font-semibold text-white"
                onClick={() => void act(() => api.allowAgent(sessionId, item.id))}
              >
                Approve
              </button>
              <button
                type="button"
                className="rounded-md border px-2 py-1"
                onClick={() => setEditing(true)}
              >
                Edit and approve
              </button>
            </>
          )}
          {item.state === 'open' && item.gate === 'waiting' && (
            <button
              type="button"
              className="rounded-md border px-2 py-1"
              onClick={() => void act(() => api.declineAgent(sessionId, item.id))}
            >
              Decline
            </button>
          )}
        </div>
      )}
      {error && <p className="mt-1 text-red-600">{error}</p>}
    </div>
  );
}

const TASK_STATUS: Record<string, string> = {
  open: 'Open',
  in_progress: 'In progress',
  blocked: 'Blocked',
  done: 'Done',
};

/** A task: who has it, its status, notes, and the commits pushed for it. */
export function TaskCard({
  event,
  updates,
  refs,
  name,
  me,
  session,
  isHost,
  children,
}: {
  event: WireEvent;
  updates: WireEvent[];
  refs: WireEvent[];
  name: (id: string) => string;
  me?: string | undefined;
  session: SessionView;
  isHost: boolean;
  children?: React.ReactNode;
}) {
  const [error, setError] = useState<string | null>(null);
  let status = 'open';
  let assignee = event.payload.assignee as { user: string; agent?: string } | undefined;
  for (const u of updates) {
    if (typeof u.payload.status === 'string') status = u.payload.status;
    if (u.payload.assignee) assignee = u.payload.assignee as typeof assignee;
  }
  const canUpdate =
    session.role !== 'observer' && (isHost || event.actor_user_id === me || assignee?.user === me);
  const who = assignee
    ? `${assignee.user === me ? 'You' : name(assignee.user)}${assignee.agent ? `${assignee.user === me ? 'r' : "'s"} ${agentLabel(assignee.agent)}` : ''}`
    : 'Nobody yet';
  const setStatus = (value: string) =>
    void api
      .event(session.session_id, 'task.updated', { task: event.id, status: value })
      .catch((e: unknown) => setError(errorText(e)));
  return (
    <li className="my-2 rounded-xl border border-black/10 p-3 dark:border-white/10">
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <span className="rounded bg-black/5 px-1.5 py-0.5 font-semibold uppercase dark:bg-white/10">
          task
        </span>
        <span>
          from {event.actor_user_id === me ? 'you' : name(event.actor_user_id)} · {who}
        </span>
        <span className="ml-auto">
          {canUpdate ? (
            <select
              aria-label="Task status"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="rounded border border-slate-300 bg-transparent px-1 dark:border-white/15"
            >
              {Object.entries(TASK_STATUS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          ) : (
            TASK_STATUS[status]
          )}
        </span>
      </div>
      <div className={`mt-1 font-semibold ${status === 'done' ? 'line-through opacity-60' : ''}`}>
        {String(event.payload.title)}
      </div>
      {typeof event.payload.body === 'string' && event.payload.body && (
        <p className="mt-1 whitespace-pre-wrap text-sm">{event.payload.body}</p>
      )}
      {updates
        .filter((u) => typeof u.payload.note === 'string')
        .map((u) => (
          <p key={u.id} className="mt-1 text-xs text-slate-500">
            {name(u.actor_user_id)}: {String(u.payload.note)}
          </p>
        ))}
      {refs.length > 0 && (
        <p className="mt-1 text-xs text-slate-500">
          Pushed for this task:{' '}
          {refs
            .map((r) => `${String(r.payload.branch)}@${String(r.payload.commit).slice(0, 7)}`)
            .join(', ')}
        </p>
      )}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      {children}
    </li>
  );
}

export function TaskForm({
  session,
  people,
  me,
  onDone,
}: {
  session: SessionView;
  people: Person[];
  me?: string | undefined;
  onDone: () => void;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [assignee, setAssignee] = useState('');
  const [error, setError] = useState<string | null>(null);
  // "user" for a person, "user:agent" for their agent.
  const options = people
    .filter((p) => p.active)
    .flatMap((p) => [
      { value: p.userId, label: p.userId === me ? 'Me' : p.name },
      ...p.agents.map((agent) => ({
        value: `${p.userId}:${agent}`,
        label: p.userId === me ? `My ${agentLabel(agent)}` : `${p.name}'s ${agentLabel(agent)}`,
      })),
    ]);
  const [user, agent] = assignee.split(':');
  const otherAgent = Boolean(agent && user !== me);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api.event(session.session_id, 'task.created', {
        title: title.trim(),
        ...(body.trim() && { body: body.trim() }),
        ...(user && { assignee: { user, ...(agent && { agent }) } }),
      });
      onDone();
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <form
      onSubmit={submit}
      className="mb-3 space-y-2 rounded-xl border border-black/10 p-3 text-sm dark:border-white/10"
    >
      <input
        aria-label="Task title"
        required
        maxLength={200}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="What needs doing"
        className="w-full rounded-md border border-slate-300 bg-white px-2 py-1 dark:border-white/15 dark:bg-[#0c1522]"
      />
      <textarea
        aria-label="Task details"
        rows={2}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Details (optional)"
        className="w-full rounded-md border border-slate-300 bg-white px-2 py-1 dark:border-white/15 dark:bg-[#0c1522]"
      />
      <select
        aria-label="Assign to"
        value={assignee}
        onChange={(e) => setAssignee(e.target.value)}
        className="w-full rounded-md border border-slate-300 bg-white px-2 py-1 dark:border-white/15 dark:bg-[#0c1522]"
      >
        <option value="">Nobody yet</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {otherAgent && (
        <p className="text-xs text-slate-500">
          Their owner sees this first and decides whether, and in what words, their agent takes it.
        </p>
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" className="rounded-md bg-pear px-3 py-1 font-semibold text-white">
          Create task
        </button>
        <button type="button" className="rounded-md border px-3 py-1" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Web address of a commit on a known HTTPS forge, or nothing. */
function commitUrl(url: string | undefined, commit: string): string | undefined {
  if (!url || !/^https:\/\/(github\.com|gitlab\.com|codeberg\.org)\//.test(url)) return undefined;
  const base = url.replace(/\.git$/, '');
  return url.includes('gitlab.com') ? `${base}/-/commit/${commit}` : `${base}/commit/${commit}`;
}

/** "Bob pushed abc1234": where the code is, never the code. */
export function CodeRefCard({
  event,
  name,
  me,
  supersededBy,
}: {
  event: WireEvent;
  name: (id: string) => string;
  me?: string | undefined;
  supersededBy?: string | undefined;
}) {
  const p = event.payload;
  const repo = p.repo as { name: string; url?: string };
  const commit = String(p.commit);
  const who = event.actor_user_id === me ? 'You' : name(event.actor_user_id);
  const link = commitUrl(repo.url, commit);
  return (
    <li className="my-2 rounded-xl border border-black/10 p-3 text-sm dark:border-white/10">
      <div className="text-xs text-slate-500">
        {event.actor_agent_id
          ? `${who === 'You' ? 'Your' : `${who}'s`} agent pushed`
          : `${who} pushed`}{' '}
        to {repo.name}
      </div>
      <div className="mt-1 font-mono text-xs">
        {String(p.branch)} @{' '}
        {link ? (
          <a href={link} target="_blank" rel="noreferrer noopener" className="text-pear underline">
            {commit.slice(0, 12)}
          </a>
        ) : (
          <span title={commit}>{commit.slice(0, 12)}</span>
        )}
        {typeof p.base === 'string' && (
          <span className="text-slate-500"> (from {p.base.slice(0, 7)})</span>
        )}
      </div>
      <p className="mt-1 whitespace-pre-wrap">{String(p.summary)}</p>
      {supersededBy && (
        <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
          A newer push to {String(p.branch)} came later: review that commit, not this one.
        </p>
      )}
      <p className="mt-1 text-xs text-slate-500">
        Review this exact commit, not the branch: it may move. Pearcoder never fetches or runs it.
      </p>
    </li>
  );
}
