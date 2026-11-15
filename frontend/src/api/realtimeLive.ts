// Typed helpers for the live-class endpoints used by the Host Studio:
// the recording module picker, class-recording status, and the stream
// heartbeat. Shapes come from the generated OpenAPI schema.
import apiClient from "./client";
import type { ApiPath } from "./contracts";
import type { components } from "./generated/schema";

type Schemas = components["schemas"];

export type ModuleOption = Schemas["ModuleOption"];
export type ModuleOptions = Schemas["ModuleOptions"];
export type ClassRecording = Schemas["ClassRecording"];
export type BroadcastEgressStatus = Schemas["BroadcastEgressStatus"];
export type StreamHeartbeatData = Schemas["StreamHeartbeatData"];
export type StreamHeartbeatRequest = Schemas["StreamHeartbeatRequest"];

interface Envelope<T> {
  success: boolean;
  message: string;
  data: T | null;
  errors: unknown;
}

function fillPath<Path extends ApiPath>(template: Path, params: Record<string, number | string>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    if (!(key in params)) {
      throw new Error(`Missing path parameter "${key}" for ${template}`);
    }
    return encodeURIComponent(String(params[key]));
  });
}

async function unwrap<T>(request: Promise<{ data: Envelope<T> }>): Promise<T | null> {
  const response = await request;
  return response?.data?.data ?? null;
}

export type ModuleOptionsQuery = { live_class_id: number } | { course_id: number };

export function getRealtimeModuleOptions(query: ModuleOptionsQuery): Promise<ModuleOptions | null> {
  const path: ApiPath = "/realtime/module-options/";
  return unwrap<ModuleOptions>(apiClient.get(path, { params: query }));
}

export function listSessionClassRecordings(sessionId: number): Promise<ClassRecording[]> {
  const path = fillPath("/realtime/sessions/{id}/class-recordings/", { id: sessionId });
  return unwrap<ClassRecording[]>(apiClient.get(path)).then((rows) => (Array.isArray(rows) ? rows : []));
}

export function retryClassRecording(recordingId: number): Promise<ClassRecording | null> {
  const path = fillPath("/realtime/class-recordings/{recording_id}/retry/", { recording_id: recordingId });
  return unwrap<ClassRecording>(apiClient.post(path));
}

export function sendRealtimeStreamHeartbeat(
  sessionId: number,
  payload: StreamHeartbeatRequest,
): Promise<StreamHeartbeatData | null> {
  const path = fillPath("/realtime/sessions/{id}/stream/heartbeat/", { id: sessionId });
  return unwrap<StreamHeartbeatData>(apiClient.post(path, payload, { timeout: 15000 }));
}
