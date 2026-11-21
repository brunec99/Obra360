import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Both addresses refer to this computer. Keep dev assets available when the
  // server starts as localhost and the browser opens the numeric loopback URL.
  allowedDevOrigins: ['localhost', '127.0.0.1'],
  // Cabeçalhos de segurança em todas as respostas. Nenhuma tela do sistema é aberta dentro de outro site
  // (o Portal Inteligência abre em aba própria), então moldura fica proibida: impede que um site alheio
  // esconda uma tela logada num iframe para induzir cliques. CSP completa fica para depois: o visualizador
  // 3D (web-ifc em wasm) e os scripts do Next precisam de uma lista conferida tela a tela.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
        ],
      },
      // `/portal-login` define o próprio (`no-referrer`): o token do Portal chega na barra de endereço.
      {
        source: '/((?!portal-login).*)',
        headers: [{ key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' }],
      },
    ];
  },
};

export default nextConfig;
