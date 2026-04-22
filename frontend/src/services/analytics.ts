/**
 * LeadBridge Analytics Wrapper (Firebase / GA4)
 *
 * Central tracking module — always call these helpers, never raw Firebase APIs.
 * No-ops safely when VITE_FIREBASE_* env vars aren't configured (dev/local).
 *
 * Event taxonomy (Phase 1 wired; Phase 2/3 reserved):
 *
 * Signup / Acquisition
 *   landing_page_viewed              { source_page }
 *   signup_page_viewed
 *   signup_started                   (first interaction on signup form)
 *   signup_submitted                 (form submit clicked)
 *   signup_success                   { method: 'email' }
 *   signup_failed                    { error_type }
 *   first_login                      (login session 1 after signup)
 *
 * Qualification
 *   qualification_started            { step_group: 'step1' | 'step2' }
 *   qualification_step_viewed        { step_group, question_key }
 *   qualification_answered           { step_group, question_key, answer_value }
 *   qualification_completed          { step_group, completion_time_sec }
 *   qualification_skipped            { step_group }
 *
 * Funnel / Upgrade
 *   upgrade_clicked                  { plan_type, entry_point }
 *
 * User properties (set on login/onboarding):
 *   primary_lead_source, weekly_lead_volume, service_type,
 *   response_speed, avg_job_value, user_goal,
 *   plan_type, trial_status,
 *   has_connected_account, has_followups_enabled
 *
 * Privacy: never send customer names, phone numbers, message bodies,
 *   auth tokens, or raw lead data. Only behavioral + segmentation props.
 */

import { initializeApp, type FirebaseApp } from 'firebase/app';
import {
  getAnalytics,
  isSupported,
  logEvent,
  setUserId,
  setUserProperties as firebaseSetUserProperties,
  type Analytics,
} from 'firebase/analytics';

type EventParams = Record<string, string | number | boolean | string[] | undefined>;

let analytics: Analytics | null = null;
let app: FirebaseApp | null = null;
let initialized = false;
let enabled = false;

// Dedup cache — prevents duplicate fires within the same session
// for events that commonly re-run on remount/navigation.
const firedOnce = new Set<string>();
const DEDUP_EVENTS = new Set<string>([
  'landing_page_viewed',
  'signup_page_viewed',
  'first_login',
  'qualification_started',
]);

function readConfig() {
  const env = import.meta.env;
  const apiKey = env.VITE_FIREBASE_API_KEY as string | undefined;
  const appId = env.VITE_FIREBASE_APP_ID as string | undefined;
  const measurementId = env.VITE_FIREBASE_MEASUREMENT_ID as string | undefined;
  const projectId = env.VITE_FIREBASE_PROJECT_ID as string | undefined;
  if (!apiKey || !appId || !projectId) return null;
  return {
    apiKey,
    appId,
    measurementId,
    projectId,
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined,
    storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET as string | undefined,
    messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID as string | undefined,
  };
}

export async function initAnalytics(): Promise<void> {
  if (initialized) return;
  initialized = true;
  const config = readConfig();
  if (!config) {
    console.info('[Analytics] Firebase config missing — analytics disabled.');
    return;
  }
  try {
    const supported = await isSupported();
    if (!supported) {
      console.info('[Analytics] Environment unsupported — analytics disabled.');
      return;
    }
    app = initializeApp(config);
    analytics = getAnalytics(app);
    enabled = true;
    console.info('[Analytics] Firebase Analytics initialized.');
  } catch (err) {
    console.warn('[Analytics] Failed to init:', err);
  }
}

function sanitize(params?: EventParams): Record<string, unknown> | undefined {
  if (!params) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) out[k] = v.join(',');
    else out[k] = v;
  }
  return out;
}

export function trackEvent(eventName: string, params?: EventParams): void {
  if (DEDUP_EVENTS.has(eventName)) {
    if (firedOnce.has(eventName)) return;
    firedOnce.add(eventName);
  }
  if (!enabled || !analytics) {
    if (import.meta.env.DEV) {
      console.debug('[Analytics:no-op]', eventName, params);
    }
    return;
  }
  try {
    logEvent(analytics, eventName, sanitize(params));
  } catch (err) {
    console.warn('[Analytics] trackEvent failed:', eventName, err);
  }
}

export function setAnalyticsUserId(userId: string | null): void {
  if (!enabled || !analytics) return;
  try {
    setUserId(analytics, userId ?? null);
  } catch (err) {
    console.warn('[Analytics] setUserId failed:', err);
  }
}

export function setAnalyticsUserProperties(props: Record<string, string | number | boolean | undefined | null>): void {
  if (!enabled || !analytics) return;
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null) continue;
    clean[k] = String(v);
  }
  if (Object.keys(clean).length === 0) return;
  try {
    firebaseSetUserProperties(analytics, clean);
  } catch (err) {
    console.warn('[Analytics] setUserProperties failed:', err);
  }
}

/**
 * Reset dedup cache (used on logout so the next session can re-fire
 * first_login, landing_page_viewed, etc.).
 */
export function resetAnalyticsSession(): void {
  firedOnce.clear();
  setAnalyticsUserId(null);
}

export function isAnalyticsEnabled(): boolean {
  return enabled;
}
