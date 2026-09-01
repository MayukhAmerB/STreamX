import { apiRequest } from './client';
import type { AcademyUser, Course, LiveClass, MobileSession } from '../types';

function rows<T>(value: T[] | { results?: T[] } | null | undefined): T[] {
  if (Array.isArray(value)) return value;
  return Array.isArray(value?.results) ? value.results : [];
}

export async function login(email: string, password: string, otp?: string): Promise<MobileSession> {
  const response = await apiRequest<MobileSession>('/auth/mobile/login/', {
    method: 'POST',
    body: JSON.stringify({ email, password, ...(otp ? { otp } : {}) }),
  });
  return response.data;
}

export async function logout(refresh: string): Promise<void> {
  await apiRequest<null>('/auth/mobile/logout/', {
    method: 'POST',
    body: JSON.stringify({ refresh }),
  });
}

export async function currentUser(): Promise<AcademyUser> {
  return (await apiRequest<AcademyUser>('/auth/user/', { authenticated: true })).data;
}

export async function listCourses(authenticated = false): Promise<Course[]> {
  return rows((await apiRequest<Course[] | { results?: Course[] }>('/courses/', { authenticated })).data);
}

export async function listMyCourses(): Promise<Course[]> {
  return rows((await apiRequest<Course[] | { results?: Course[] }>('/my-courses/', { authenticated: true })).data);
}

export async function listLiveClasses(authenticated = false): Promise<LiveClass[]> {
  return rows((await apiRequest<LiveClass[] | { results?: LiveClass[] }>('/live-classes/', { authenticated })).data);
}

export async function requestCourse(courseId: number): Promise<string> {
  return (await apiRequest<{ course_id: number }>('/courses/enroll/', {
    authenticated: true,
    method: 'POST',
    body: JSON.stringify({ course_id: courseId }),
  })).message;
}

export async function requestLiveClass(liveClassId: number): Promise<string> {
  return (await apiRequest<{ live_class_id: number }>('/live-classes/enroll/', {
    authenticated: true,
    method: 'POST',
    body: JSON.stringify({ live_class_id: liveClassId }),
  })).message;
}
