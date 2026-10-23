// Talks only to the local node that served this page. The owner token arrives in the URL
// fragment (never sent to any server), is kept in sessionStorage, and is removed from the
// address bar so it is not copied or bookmarked by accident.

const TOKEN_KEY = 'pearcoder.owner-token';

function readToken(): string | null {
  const match = /(?:^|&)token=([A-Za-z0-9_-]+)/.exec(window.location.hash.slice(1));
  if (match?.[1]) {
    sessionStorage.setItem(TOKEN_KEY, match[1]);
    history.replaceState(null, '', window.location.pathname + window.location.search);
    return match[1];
  }
  return sessionStorage.getItem(TOKEN_KEY);
}

export const ownerToken = readToken();

export interface WireEvent {
  id: string;
  sequence: number;
  type: string;
  actor_user_id: string;
  actor_agent_id?: string;
  reply_to?: string;
  received_at: string;
  thread_id: string;
  payload: Record<string, unknown>;
}

export interface SessionView {
  session_id: string;
  session_name: string;
  role: 'host' | 'member' | 'observer';
  status: 'connecting' | 'online' | 'offline' | 'stopped' | 'unreachable';
  error?: string;
}

export interface Me {
  user_id: string;
  display_name: string | null;
}

export type Update =
  | { type: 'event'; session_id: string; event: WireEvent }
  | { type: 'status'; session_id: string; status: SessionView['status']; error?: string };

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: {
      authorization: `Bearer ${ownerToken ?? ''}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = (await response.json().catch(() => ({}))) as {
    error?: { code: string; message: string };
  };
  if (!response.ok) {
    throw new ApiError(data.error?.code ?? `HTTP_${response.status}`, data.error?.message ?? '');
  }
  return data as T;
}

export interface FindingPayload {
  title: string;
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  body: string;
  request?: string;
  context_package?: string;
  location?: { path: string; start_line?: number; end_line?: number; commit?: string };
}

export interface ReplyPayload {
  text: string;
  reply_to: string;
}

interface DraftBase {
  id: string;
  session_id: string;
  status: 'draft' | 'published' | 'discarded';
  created_at: string;
  source: { via: string; harness?: string };
}

export type Draft =
  | (DraftBase & { kind: 'finding'; payload: FindingPayload })
  | (DraftBase & { kind: 'reply'; payload: ReplyPayload });

export type DraftPayload = FindingPayload | ReplyPayload;

export interface SecretFinding {
  kind: string;
  field: string;
  preview: string;
}

export const api = {
  me: () => call<Me>('GET', '/api/me'),
  drafts: () => call<{ drafts: Draft[] }>('GET', '/api/drafts'),
  draft: (id: string) =>
    call<{ draft: Draft; findings: SecretFinding[]; redacted: DraftPayload | null }>(
      'GET',
      `/api/drafts/${id}`,
    ),
  updateDraft: (id: string, payload: DraftPayload) =>
    call<{ draft: Draft }>('PUT', `/api/drafts/${id}`, payload),
  publishDraft: (id: string, mode: 'as_is' | 'redact' | 'allow') =>
    call<{ sequence: number }>('POST', `/api/drafts/${id}/publish`, { mode }),
  discardDraft: (id: string) => call<{ draft: Draft }>('POST', `/api/drafts/${id}/discard`, {}),
  request: (
    sessionId: string,
    body: {
      to: string[];
      kind: string;
      title: string;
      body?: string;
      context_package?: string;
      for_agent?: string;
    },
  ) => call<{ id: string }>('POST', `/api/sessions/${sessionId}/requests`, body),
  event: (sessionId: string, type: string, payload: Record<string, unknown>, replyTo?: string) =>
    call<{ id: string }>('POST', `/api/sessions/${sessionId}/events`, {
      type,
      payload,
      ...(replyTo && { reply_to: replyTo }),
    }),
  /** Downloads the review document for a session (the owner token goes in the header). */
  exportMarkdown: async (sessionId: string, name: string) => {
    const response = await fetch(`/api/sessions/${sessionId}/export.md`, {
      headers: { authorization: `Bearer ${ownerToken ?? ''}` },
    });
    if (!response.ok) throw new ApiError(`HTTP_${response.status}`, 'export failed');
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = `pearcoder-${name.replace(/[^A-Za-z0-9._-]+/g, '-')}.md`;
    link.click();
    URL.revokeObjectURL(url);
  },
  resolve: (sessionId: string, requestId: string, resolution: 'accepted' | 'declined' | 'done') =>
    call<{ id: string }>('POST', `/api/sessions/${sessionId}/requests/${requestId}/resolve`, {
      resolution,
    }),
  sessions: () => call<{ sessions: SessionView[] }>('GET', '/api/sessions'),
  events: (id: string) => call<{ events: WireEvent[] }>('GET', `/api/sessions/${id}/events`),
  forgetSession: (id: string) =>
    call<{ forgotten: string }>('POST', `/api/sessions/${id}/forget`, {}),
  agentPolicy: (id: string) => call<{ auto: boolean }>('GET', `/api/sessions/${id}/agent-policy`),
  setAgentPolicy: (id: string, auto: boolean) =>
    call<{ auto: boolean }>('POST', `/api/sessions/${id}/agent-policy`, { auto }),
  allowAgent: (id: string, event: string) =>
    call<{ allowed: string }>('POST', `/api/sessions/${id}/agent-allow`, { event }),
  say: (id: string, text: string) =>
    call<{ sequence: number }>('POST', `/api/sessions/${id}/messages`, { text }),
};

/** Live updates from the local node, reconnecting with backoff. Returns a stop function. */
export function subscribe(onUpdate: (u: Update) => void, onOpen: () => void): () => void {
  let socket: WebSocket | undefined;
  let stopped = false;
  let attempt = 0;
  const open = () => {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/stream`;
    socket = new WebSocket(url, ['pearcoder.local.v1', `pearcoder.auth.${ownerToken ?? ''}`]);
    socket.onopen = () => {
      attempt = 0;
      onOpen();
    };
    socket.onmessage = (message) => {
      try {
        onUpdate(JSON.parse(String(message.data)) as Update);
      } catch {
        // Ignore malformed frames.
      }
    };
    socket.onclose = () => {
      if (stopped) return;
      const wait = Math.min(10_000, 300 * 2 ** attempt++);
      setTimeout(open, wait);
    };
  };
  open();
  return () => {
    stopped = true;
    socket?.close();
  };
}
