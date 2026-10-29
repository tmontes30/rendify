import { HashRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import { Layout } from './components/Layout';
import { Login } from './pages/Login';
import { NoAccess } from './pages/NoAccess';
import { MyReports } from './pages/MyReports';
import { ReportPage } from './pages/ReportPage';
import { ReportEditor, type RowState } from './pages/ReportEditor';
import { Approvals } from './pages/Approvals';
import { BulkUpload } from './pages/BulkUpload';
import { Profile } from './pages/Profile';
import { Payments } from './pages/Payments';

/** Nueva rendición; puede venir con gastos precargados desde la carga masiva. */
function NewReport() {
  const state = useLocation().state as { rows?: RowState[]; title?: string } | null;
  return <ReportEditor key={state?.rows ? 'bulk' : 'new'} initialRows={state?.rows} initialTitle={state?.title} />;
}

function Routed() {
  const { state } = useAuth();
  if (state.status === 'loading') return <div className="center-page muted">Cargando…</div>;
  if (state.status === 'signedOut') return <Login />;
  if (state.status === 'noAccess') return <NoAccess />;
  if (state.status === 'suspended') return <NoAccess suspended={state.companyName} />;
  return (
    <Layout>
      <Routes>
        {state.profile.paymentsUser ? (
          // Usuario de pagos: solo su sección de pagos (y aprobar si además es aprobador).
          <>
            <Route path="/pagos" element={<Payments />} />
            <Route path="/r/:id" element={<ReportPage />} />
            <Route path="/perfil" element={<Profile />} />
            {state.profile.isApprover && <Route path="/aprobar" element={<Approvals />} />}
            <Route path="*" element={<Navigate to="/pagos" replace />} />
          </>
        ) : (
          <>
            <Route path="/" element={<MyReports />} />
            <Route path="/nueva" element={<NewReport />} />
            <Route path="/carga-masiva" element={<BulkUpload />} />
            <Route path="/perfil" element={<Profile />} />
            <Route path="/r/:id" element={<ReportPage />} />
            {state.profile.isApprover && <Route path="/aprobar" element={<Approvals />} />}
            <Route path="*" element={<Navigate to="/" replace />} />
          </>
        )}
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
