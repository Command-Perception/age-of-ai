import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig(async () => {
  // The Vowel package remains read-only. Its speech assets are copied into the
  // host's public tree so microphone capture can fetch them from this origin.
  const vadSource = fileURLToPath(new URL('../packages/vowel-popover/assets/vad/', import.meta.url));
  const vadPublic = fileURLToPath(new URL('./public/vad/', import.meta.url));
  await mkdir(vadPublic, { recursive: true });
  await Promise.all([
    'silero_vad_v5.onnx',
    'vad.worklet.bundle.min.js',
  ].map((file) => copyFile(`${vadSource}${file}`, `${vadPublic}${file}`)));

  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 5199,
      // Escuta em todos os endereços (IPv4 0.0.0.0 + IPv6) para que a checagem de
      // prontidão (127.0.0.1), o cloudflared e a rede local alcancem o Vite de forma
      // determinística — evita o "sobe em localhost/::1 mas 127.0.0.1 não responde".
      host: true,
      // Não pular para outra porta se a 5199 estiver ocupada (falha claro em vez de
      // subir numa porta que o túnel/checagem não conhecem).
      strictPort: true,
      // Permite acesso via túnel (Cloudflare envia o Host da URL *.trycloudflare.com).
      allowedHosts: true,
      // Encaminha o WebSocket do jogo para o servidor autoritativo na porta 8080,
      // para que tudo passe por uma única origem (necessário quando servido por um túnel).
      proxy: {
        '/ws': {
          target: `ws://localhost:${process.env.AGE_OF_AI_SERVER_PORT ?? '18081'}`,
          ws: true,
          changeOrigin: true,
        },
      },
    },
    optimizeDeps: {
      // pacotes linkados do workspace são servidos como código-fonte TS/TSX
      exclude: ['@age/shared', '@vowel/vowel-popover'],
      include: ['pdfjs-dist'],
    },
  };
});
