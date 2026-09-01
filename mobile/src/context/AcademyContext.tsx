import { createContext, type PropsWithChildren, useContext, useEffect, useState } from 'react';

import {
  currentUser,
  listCourses,
  listLiveClasses,
  listMyCourses,
  login as loginRequest,
  logout as logoutRequest,
  requestCourse,
  requestLiveClass,
} from '../api/academy';
import { readableError } from '../api/client';
import { clearSession, readSession, writeSession } from '../storage/session';
import type { AcademyUser, Course, LiveClass, MobileSession } from '../types';

type AcademyContextValue = {
  booting: boolean;
  loading: boolean;
  user: AcademyUser | null;
  session: MobileSession | null;
  courses: Course[];
  myCourses: Course[];
  liveClasses: LiveClass[];
  error: string;
  login: (email: string, password: string, otp?: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  requestCourseAccess: (courseId: number) => Promise<string>;
  requestLiveAccess: (liveClassId: number) => Promise<string>;
};

const AcademyContext = createContext<AcademyContextValue | null>(null);

export function AcademyProvider({ children }: PropsWithChildren) {
  const [booting, setBooting] = useState(true);
  const [loading, setLoading] = useState(false);
  const [session, setSession] = useState<MobileSession | null>(null);
  const [user, setUser] = useState<AcademyUser | null>(null);
  const [courses, setCourses] = useState<Course[]>([]);
  const [myCourses, setMyCourses] = useState<Course[]>([]);
  const [liveClasses, setLiveClasses] = useState<LiveClass[]>([]);
  const [error, setError] = useState('');

  async function loadAcademyData(activeSession: MobileSession | null) {
    setLoading(true);
    setError('');
    try {
      const [catalog, live, approved] = await Promise.all([
        listCourses(Boolean(activeSession)),
        listLiveClasses(Boolean(activeSession)),
        activeSession ? listMyCourses() : Promise.resolve([]),
      ]);
      setCourses(catalog);
      setLiveClasses(live);
      setMyCourses(approved);
    } catch (loadError) {
      setError(readableError(loadError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    async function bootstrap() {
      const stored = await readSession();
      if (!active) return;
      let verified = stored;
      if (stored) {
        try {
          const freshUser = await currentUser();
          verified = { ...stored, user: freshUser };
          await writeSession(verified);
        } catch {
          verified = null;
          await clearSession();
        }
      }
      if (!active) return;
      setSession(verified);
      setUser(verified?.user || null);
      await loadAcademyData(verified);
      if (active) setBooting(false);
    }
    void bootstrap();
    return () => {
      active = false;
    };
  }, []);

  async function login(email: string, password: string, otp?: string) {
    const nextSession = await loginRequest(email.trim(), password, otp?.trim());
    await writeSession(nextSession);
    setSession(nextSession);
    setUser(nextSession.user);
    await loadAcademyData(nextSession);
  }

  async function logout() {
    try {
      if (session?.tokens.refresh) await logoutRequest(session.tokens.refresh);
    } finally {
      await clearSession();
      setSession(null);
      setUser(null);
      setMyCourses([]);
      await loadAcademyData(null);
    }
  }

  async function refresh() {
    await loadAcademyData(session);
  }

  async function requestCourseAccess(courseId: number) {
    const message = await requestCourse(courseId);
    await loadAcademyData(session);
    return message;
  }

  async function requestLiveAccess(liveClassId: number) {
    const message = await requestLiveClass(liveClassId);
    await loadAcademyData(session);
    return message;
  }

  return (
    <AcademyContext.Provider
      value={{
        booting,
        loading,
        user,
        session,
        courses,
        myCourses,
        liveClasses,
        error,
        login,
        logout,
        refresh,
        requestCourseAccess,
        requestLiveAccess,
      }}
    >
      {children}
    </AcademyContext.Provider>
  );
}

export function useAcademy() {
  const context = useContext(AcademyContext);
  if (!context) throw new Error('useAcademy must be used inside AcademyProvider.');
  return context;
}
