import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import { Layout } from './components/Layout';
import { Login } from './pages/Login';
import { NoAccess } from './pages/NoAccess';
import { MyReports } from './pages/MyReports';
import { ReportPage } from './pages/ReportPage';
import { ManagerInbox } from './pages/ManagerInbox';

function Routed() {
  const { state } = useAuth();
  if (state.status === 'loading') return <div className="center-page muted">Cargando…</div>;
  if (state.status === 'signedOut') return <Login />;
  if (state.status === 'noAccess') return <NoAccess />;
  const isManager = state.profile.role === 'manager';
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<MyReports />} />
        <Route path="/r/:id" element={<ReportPage />} />
        {isManager && <Route path="/equipo" element={<ManagerInbox />} />}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}

export function App() {
  return (
    <AuthProvider>
      <HashRouter>
        <Routed />
      </HashRouter>
    </AuthProvider>
  );
}
