import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './components/Layout';
import { ProtectedRoute } from './components/ProtectedRoute';
import { ToastNotifications } from './components/ToastNotifications';
import { Landing } from './pages/Landing';
import { Login } from './pages/Login';
import { Register } from './pages/Register';
import { ForgotPassword } from './pages/ForgotPassword';
import { ResetPassword } from './pages/ResetPassword';
import { Dashboard } from './pages/Dashboard';
import { Messages } from './pages/Messages';
import { MessageSettings } from './pages/MessageSettings';
import { AutomationSettings } from './pages/AutomationSettings';
import { NotificationSettings } from './pages/NotificationSettings';
import { PhoneSettings } from './pages/PhoneSettings';
import { Services } from './pages/Services';
import { ApiTest } from './pages/ApiTest';
import { Analytics } from './pages/Analytics';
import { SmsHistory } from './pages/SmsHistory';
import Pricing from './pages/Pricing';
import SettingsPage from './pages/SettingsPage';
import AdminDashboard from './pages/admin/AdminDashboard';
import AdminUserDetails from './pages/admin/AdminUserDetails';
import AdminTenantNumbers from './pages/admin/AdminTenantNumbers';
import {
  DemoLayout, DemoOverviewView, DemoAutomationView, DemoTemplatesView,
  DemoLeadsView, DemoPhoneView, DemoInsightsView, DemoPricingView, DemoSettingsView,
} from './pages/Demo';
import { useAuthStore } from './store/authStore';

function App() {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);

  return (
    <BrowserRouter>
      {/* Global toast notifications */}
      <ToastNotifications />
      <Routes>
        {/* Public routes */}
        <Route path="/" element={<Landing />} />
        <Route
          path="/login"
          element={isAuthenticated ? <Navigate to="/dashboard" /> : <Login />}
        />
        <Route
          path="/register"
          element={isAuthenticated ? <Navigate to="/dashboard" /> : <Register />}
        />
        <Route
          path="/forgot-password"
          element={isAuthenticated ? <Navigate to="/dashboard" /> : <ForgotPassword />}
        />
        <Route
          path="/reset-password"
          element={isAuthenticated ? <Navigate to="/dashboard" /> : <ResetPassword />}
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
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/messages" element={<Messages />} />
            <Route path="/analytics" element={<Analytics />} />
            <Route path="/message-settings" element={<MessageSettings />} />
            <Route path="/automation" element={<AutomationSettings />} />
            <Route path="/notifications" element={<NotificationSettings />} />
            <Route path="/phone-settings" element={<PhoneSettings />} />
            <Route path="/sms-history" element={<SmsHistory />} />
            <Route path="/services" element={<Services />} />
            <Route path="/api-test" element={<ApiTest />} />
            <Route path="/pricing" element={<Pricing />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/billing" element={<Navigate to="/settings" />} />
            <Route path="/admin" element={<AdminDashboard />} />
            <Route path="/admin/users/:userId" element={<AdminUserDetails />} />
            <Route path="/admin/phone-pool" element={<Navigate to="/admin/tenant-numbers" />} />
            <Route path="/admin/tenant-numbers" element={<AdminTenantNumbers />} />
          </Route>
        </Route>

        {/* Default redirect */}
        <Route path="*" element={<Navigate to={isAuthenticated ? '/dashboard' : '/'} />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
