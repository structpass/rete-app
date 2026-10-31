import type { NextConfig } from 'next';

// CSP（connect-src の API/Board/reference オリジン許可を含む）は src/middleware.ts が
// 唯一の生成元（cmn-0298）。オリジン導出の定数も middleware 側にある。

const nextConfig: NextConfig = {
  // Dockerfile の本番 build は standalone 出力（cmn-0402）。DOCKER_BUILD=1 時のみ有効化し、
  // 通常の dev / ローカル build は従来どおりの出力を保つ（写し元 reference と同型）。
  output: process.env.DOCKER_BUILD ? 'standalone' : undefined,
  // dev サーバー稼働中でも本番 build 検証ができるよう出力先を env で切り替え可能にする
  // （未設定時は従来どおり .next。dev と検証 build の .next 衝突は memory 既知の FAIL 要因）。
  distDir: process.env.NEXT_BUILD_DIST_DIR || '.next',
  reactStrictMode: true,
  poweredByHeader: false,
  compress: true,
  devIndicators: false,
  typescript: {
    ignoreBuildErrors: false,
  },
  experimental: {
    optimizePackageImports: [
      '@rete/shared',
      'react-hot-toast',
      'react-hook-form',
      '@hookform/resolvers',
      'lucide-react',
    ],
  },
  async headers() {
    const isDev = process.env.NODE_ENV !== 'production';
    // CSP は src/middleware.ts が唯一の生成元（cmn-0298・nonce 配線のため）。ここには置かない。
    const securityHeaders = [
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    ];

    if (!isDev) {
      securityHeaders.push({
        key: 'Strict-Transport-Security',
        value: 'max-age=63072000; includeSubDomains; preload',
      });
    }

    return [
      {
        source: '/(.*)',
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
