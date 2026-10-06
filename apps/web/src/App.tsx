import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { HomePage } from './pages/HomePage';
import { InboxPage } from './pages/InboxPage';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        {/* One component for both: :rid only decides which request is selected. */}
        <Route path="/inbox/:uuid" element={<InboxPage />} />
        <Route path="/inbox/:uuid/:rid" element={<InboxPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
