import { notFound } from 'next/navigation';
import PreviewClient from './PreviewClient';

export const metadata = { title: 'Vista previa del reporte', robots: { index: false } };

/**
 * Development-only: open http://localhost:3000/report-preview to edit and review the report
 * (src/components/ReportView.tsx) with sample answers, without taking the quiz or writing to
 * Google Sheets. Returns 404 in production builds.
 */
export default function ReportPreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <PreviewClient />;
}
