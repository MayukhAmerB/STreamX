export type ApiEnvelope<T> = {
  success: boolean;
  message: string;
  data: T;
  errors?: Record<string, unknown> | null;
};

export type AcademyUser = {
  id: number;
  email: string;
  full_name?: string;
  role?: string;
  phone_number?: string;
  two_factor_enabled?: boolean;
};

export type SessionTokens = {
  access: string;
  refresh: string;
};

export type MobileSession = {
  user: AcademyUser;
  tokens: SessionTokens;
};

export type Course = {
  id: number;
  title: string;
  description?: string;
  category?: string;
  level?: string;
  price?: number | string;
  thumbnail_url?: string;
  progress_percent?: number;
  enrollment_status?: string;
  is_enrolled?: boolean;
};

export type LiveClass = {
  id: number;
  title: string;
  description?: string;
  level?: string;
  schedule_days?: string;
  class_duration_minutes?: number;
  price?: number | string;
  enrollment_status?: string;
  is_enrolled?: boolean;
  is_live?: boolean;
};
