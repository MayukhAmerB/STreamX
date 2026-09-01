import { clearSession, readSession, writeSession } from '../storage/session';
import type { ApiEnvelope, MobileSession } from '../types';

export const API_BASE_URL = (
  process.env.EXPO_PUBLIC_API_BASE_URL || 'https://api.alsyedinitiative.com/api'
).replace(/\/$/, '');

export class ApiError extends Error {
  status: number;
  details?: Record<string, unknown> | null;

  constructor(message: string, status: number, details?: Record<string, unknown> | null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

type RequestOptions = RequestInit & { authenticated?: boolean; retryAuth?: boolean };

async function parseEnvelope<T>(response: Response): Promise<ApiEnvelope<T>> {
  const payload = (await response.json().catch(() => null)) as ApiEnvelope<T> | null;
  if (!response.ok || !payload?.success) {
    throw new ApiError(payload?.message || 'The server could not complete this request.', response.status, payload?.errors);
  }
  return payload;
}

async function refreshMobileSession(session: MobileSession): Promise<MobileSession | null> {
  const response = await fetch(`${API_BASE_URL}/auth/mobile/refresh/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ refresh: session.tokens.refresh }),
  });

  if (!response.ok) {
    await clearSession();
    return null;
  }

  const payload = await parseEnvelope<MobileSession>(response);
  await writeSession(payload.data);
  return payload.data;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<ApiEnvelope<T>> {
  const { authenticated = false, retryAuth = true, headers, ...requestOptions } = options;
  let session = authenticated ? await readSession() : null;

  const perform = (activeSession: MobileSession | null) =>
    fetch(`${API_BASE_URL}${path}`, {
      ...requestOptions,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(activeSession?.tokens.access ? { Authorization: `Bearer ${activeSession.tokens.access}` } : {}),
        ...headers,
      },
    });

  let response = await perform(session);
  if (response.status === 401 && authenticated && retryAuth && session) {
    session = await refreshMobileSession(session);
    if (session) response = await perform(session);
  }

  return parseEnvelope<T>(response);
}

export function readableError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message === 'Network request failed') {
    return 'Unable to reach the academy server. Check your connection and try again.';
  }
  return 'Something went wrong. Please try again.';
}
