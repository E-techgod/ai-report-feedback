import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'Diagnóstico de Blindaje Patrimonial | Quirón',
  description: 'Diagnóstico de protección patrimonial.',
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
