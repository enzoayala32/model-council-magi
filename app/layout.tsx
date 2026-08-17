import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Consenso IA",
  description: "Un panel abierto de múltiples modelos de IA, primariamente gratuitos, potenciado por OpenRouter y NVIDIA NIM.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
