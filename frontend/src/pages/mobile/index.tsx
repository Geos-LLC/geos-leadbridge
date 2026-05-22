// Mobile design preview routes. Lives entirely under /m/* — does not
// interfere with the desktop app. Renders inside a .lb-mobile scoped
// wrapper so the design tokens in mobile-tokens.css resolve correctly.
//
// This is the design-fidelity port (Phase 1). All data is mocked from
// pages/mobile/data.ts — no real LB API integration yet. Wiring to real
// stores lands in a follow-up PR per the FargiPro-investigation thread.

import { lazy, Suspense } from 'react';
import { Route, Routes, Navigate } from 'react-router-dom';

const MOverview = lazy(() => import('./screens/MOverview'));
const MLeads = lazy(() => import('./screens/MLeads'));
const MLeadThread = lazy(() => import('./screens/MLeadThread'));
const MAutomationHub = lazy(() => import('./screens/MAutomationHub'));
const MAutomationRespond = lazy(() => import('./screens/MAutomationRespond'));
const MAutomationFollowups = lazy(() => import('./screens/MAutomationFollowups'));
const MAutomationConvert = lazy(() => import('./screens/MAutomationConvert'));
const MInsights = lazy(() => import('./screens/MInsights'));
const MAvailability = lazy(() => import('./screens/MAvailability'));
const MSettings = lazy(() => import('./screens/MSettings'));

function MobileFallback() {
  return (
    <div style={{
      padding: 24, fontSize: 13, color: 'var(--ink-5)', fontFamily: 'var(--font-mono)',
    }}>Loading…</div>
  );
}

export default function MobileApp() {
  return (
    <div className="lb-mobile" style={{ background: 'var(--bg)' }}>
      <Suspense fallback={<MobileFallback />}>
        <Routes>
          <Route index element={<Navigate to="today" replace />} />
          <Route path="today" element={<MOverview />} />
          <Route path="leads" element={<MLeads />} />
          <Route path="leads/:id" element={<MLeadThread />} />
          <Route path="automation" element={<MAutomationHub />} />
          <Route path="automation/respond" element={<MAutomationRespond />} />
          <Route path="automation/engage" element={<MAutomationFollowups />} />
          <Route path="automation/convert" element={<MAutomationConvert />} />
          <Route path="insights" element={<MInsights />} />
          <Route path="availability" element={<MAvailability />} />
          <Route path="more" element={<MSettings />} />
          <Route path="*" element={<Navigate to="today" replace />} />
        </Routes>
      </Suspense>
    </div>
  );
}
