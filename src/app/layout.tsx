import type { Metadata, Viewport } from "next";
import { Geist_Mono, Inter, Open_Sans, Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
const jakarta = Plus_Jakarta_Sans({ variable: "--font-jakarta", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
// The logo's wordmark face (src/assets/logo-full.png); used only by BrandLockup.
const openSans = Open_Sans({ variable: "--font-open-sans", subsets: ["latin"], weight: "400" });

export const metadata: Metadata = {
  title: "NimbusStack Product Assistant",
  description: "Answers about NimbusStack products, grounded only in NimbusStack's own documents.",
};

export const viewport: Viewport = {
  themeColor: "#0f1729",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jakarta.variable} ${geistMono.variable} ${openSans.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col font-sans">{children}</body>
    </html>
  );
}
