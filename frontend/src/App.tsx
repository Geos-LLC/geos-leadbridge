import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './components/Layout';
import { ProtectedRoute } from './components/ProtectedRoute';
import { ToastNotifications } from './components/ToastNotifications';
import { Login } from './pages/Login';
import { Register } from './pages/Register';
import { Dashboard } from './pages/Dashboard';
import { Messages } from './pages/Messages';
import { MessageSettings } from './pages/MessageSettings';
import { AutomationSettings } from './pages/AutomationSettings';
import { NotificationSettings } from './pages/NotificationSettings';
import { PhoneSettings } from './pages/PhoneSettings';
import { Analytics } from './pages/Analytics';
import { useAuthStore } from './store/authStore';
import './App.css';

function App() {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);

  return (
    <BrowserRouter>
      {/* Global toast notifications */}
      <ToastNotifications />
      <Routes>
        {/* Public routes */}
        <Route
          path="/login"
          element={isAuthenticated ? <Navigate to="/dashboard" /> : <Login />}
        />
        <Route
          path="/register"
          element={isAuthenticated ? <Navigate to="/dashboard" /> : <Register />}
        />

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
          </Route>
        </Route>

        {/* Default redirect */}
        <Route path="*" element={<Navigate to={isAuthenticated ? '/dashboard' : '/login'} />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
