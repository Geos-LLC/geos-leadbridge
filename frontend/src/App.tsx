import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './components/Layout';
import { ProtectedRoute } from './components/ProtectedRoute';
import { ToastNotifications } from './components/ToastNotifications';
import { PageSkeleton } from './components/PageSkeleton';
import { useAuthStore } from './store/authStore';

// Public / unauthenticated routes — kept eager so landing + login render on
// the first paint without a chunk fetch.
import { Landing } from './pages/Landing';
import { Security } from './pages/Security';
import { Login } from './pages/Login';
import { Register } from './pages/Register';
import { ForgotPassword } from './pages/ForgotPassword';
import { ResetPassword } from './pages/ResetPassword';

// Protected routes — lazy-loaded. Each import() becomes its own Vite chunk so
// a visitor who never opens Services/Messages/Analytics doesn't pay for them.
const Dashboard = lazy(() => import('./pages/Dashboard').then(m => ({ default: m.Dashboard })));
const Messages = lazy(() => import('./pages/Messages').then(m => ({ default: m.Messages })));
const Analytics = lazy(() => import('./pages/Analytics').then(m => ({ default: m.Analytics })));
const MessageSettings = lazy(() => import('./pages/MessageSettings').then(m => ({ default: m.MessageSettings })));
const AutomationSettings = lazy(() => import('./pages/AutomationSettings').then(m => ({ default: m.AutomationSettings })));
const NotificationSettings = lazy(() => import('./pages/NotificationSettings').then(m => ({ default: m.NotificationSettings })));
const SmsHistory = lazy(() => import('./pages/SmsHistory').then(m => ({ default: m.SmsHistory })));
const Services = lazy(() => import('./pages/Services').then(m => ({ default: m.Services })));
const ApiTest = lazy(() => import('./pages/ApiTest').then(m => ({ default: m.ApiTest })));
const Pricing = lazy(() => import('./pages/Pricing'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const SettingsCommunication = lazy(() => import('./pages/SettingsCommunication').then(m => ({ default: m.SettingsCommunication })));
const AcceptInvite = lazy(() => import('./pages/AcceptInvite'));
const AdminDashboard = lazy(() => import('./pages/admin/AdminDashboard'));
const AdminUserDetails = lazy(() => import('./pages/admin/AdminUserDetails'));
const AdminTenantNumbers = lazy(() => import('./pages/admin/AdminTenantNumbers'));

// Demo sub-views share one module so a single dynamic import lands the whole
// demo experience. Splitting per view would add 9 round-trips for a flow where
// users almost always navigate laterally between sections.
const DemoLayout = lazy(() => import('./pages/Demo').then(m => ({ default: m.DemoLayout })));
const DemoOverviewView = lazy(() => import('./pages/Demo').then(m => ({ default: m.DemoOverviewView })));
const DemoAutomationView = lazy(() => import('./pages/Demo').then(m => ({ default: m.DemoAutomationView })));
const DemoTemplatesView = lazy(() => import('./pages/Demo').then(m => ({ default: m.DemoTemplatesView })));
const DemoLeadsView = lazy(() => import('./pages/Demo').then(m => ({ default: m.DemoLeadsView })));
const DemoPhoneView = lazy(() => import('./pages/Demo').then(m => ({ default: m.DemoPhoneView })));
const DemoInsightsView = lazy(() => import('./pages/Demo').then(m => ({ default: m.DemoInsightsView })));
const DemoPricingView = lazy(() => import('./pages/Demo').then(m => ({ default: m.DemoPricingView })));
const DemoSettingsView = lazy(() => import('./pages/Demo').then(m => ({ default: m.DemoSettingsView })));

function App() {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);

  return (
    <BrowserRouter>
      {/* Global toast notifications */}
      <ToastNotifications />
      <Suspense fallback={<PageSkeleton />}>
        <Routes>
          {/* Public routes */}
          <Route path="/" element={<Landing />} />
          <Route path="/security" element={<Security />} />
          <Route
            path="/login"
            element={isAuthenticated ? <Navigate to="/overview" /> : <Login />}
          />
          <Route
            path="/register"
            element={isAuthenticated ? <Navigate to="/overview" /> : <Register />}
          />
          <Route
            path="/forgot-password"
            element={isAuthenticated ? <Navigate to="/overview" /> : <ForgotPassword />}
          />
          <Route
            path="/reset-password"
            element={isAuthenticated ? <Navigate to="/overview" /> : <ResetPassword />}
          />
          <Route path="/demo" element={<DemoLayout />}>
            <Route index element={<Navigate to="/demo/overview" replace />} />
            <Route path="overview" element={<DemoOverviewView />} />
            <Route path="automation" element={<DemoAutomationView />} />
            <Route path="templates" element={<DemoTemplatesView />} />
            <Route path="leads" element={<DemoLeadsView />} />
            <Route path="phone" element={<DemoPhoneView />} />
            <Route path="insights" element={<DemoInsightsView />} />
            <Route path="pricing" element={<DemoPricingView />} />
            <Route path="settings" element={<DemoSettingsView />} />
          </Route>

          {/* Protected routes */}
          <Route element={<ProtectedRoute />}>
            <Route element={<Layout />}>
              {/* Canonical paths — match the nav labels (Overview / Lead Activity /
                  Automation / Templates / Insights). */}
              <Route path="/overview" element={<Dashboard />} />
              <Route path="/lead-activity" element={<Messages />} />
              <Route path="/automation" element={<Services />} />
              <Route path="/templates" element={<MessageSettings />} />
              <Route path="/insights" element={<Analytics />} />

              {/* Legacy URL redirects — keep old bookmarks/links working. */}
              <Route path="/dashboard" element={<Navigate to="/overview" replace />} />
              <Route path="/messages" element={<Navigate to="/lead-activity" replace />} />
              <Route path="/services" element={<Navigate to="/automation" replace />} />
              <Route path="/message-settings" element={<Navigate to="/templates" replace />} />
              <Route path="/analytics" element={<Navigate to="/insights" replace />} />

              {/* AutomationSettings page — formerly mounted at /automation but
                  superseded by the Services page; kept reachable for legacy use. */}
              <Route path="/automation-legacy" element={<AutomationSettings />} />

              <Route path="/notifications" element={<NotificationSettings />} />
              <Route path="/phone-settings" element={<Navigate to="/notifications" />} />
              <Route path="/sms-history" element={<SmsHistory />} />
              <Route path="/api-test" element={<ApiTest />} />
              <Route path="/pricing" element={<Pricing />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/settings/communication" element={<SettingsCommunication />} />
              <Route path="/invite/accept" element={<AcceptInvite />} />
              <Route path="/billing" element={<Navigate to="/settings" />} />
              <Route path="/admin" element={<AdminDashboard />} />
              <Route path="/admin/users/:userId" element={<AdminUserDetails />} />
              <Route path="/admin/phone-pool" element={<Navigate to="/admin/tenant-numbers" />} />
              <Route path="/admin/tenant-numbers" element={<AdminTenantNumbers />} />
            </Route>
          </Route>

          {/* Default redirect */}
          <Route path="*" element={<Navigate to={isAuthenticated ? '/overview' : '/'} />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}

export default App;
