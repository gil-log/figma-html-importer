import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Figma 플러그인은 단일 HTML 파일이어야 함 - 모든 JS/CSS를 인라인으로 번들링
function viteSingleFile() {
  return {
    name: 'vite-plugin-single-file',
    enforce: 'post' as const,
    generateBundle(_opts: any, bundle: any) {
      const htmlFile = Object.keys(bundle).find((k) => k.endsWith('.html'));
      if (!htmlFile) return;

      const html = bundle[htmlFile];
      let source = html.source as string;

      let allJsCode = '';
      const jsNames: string[] = [];
      for (const [name, chunk] of Object.entries(bundle)) {
        if (name.endsWith('.js') && (chunk as any).type === 'chunk') {
          allJsCode += (chunk as any).code + '\n';
          jsNames.push(name);
        }
      }

      for (const name of jsNames) {
        const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        source = source.replace(new RegExp(`<script[^>]*src="/?${esc}"[^>]*><\\/script>`, 'g'), '');
        source = source.replace(new RegExp(`<link[^>]*href="/?${esc}"[^>]*>`, 'g'), '');
        delete bundle[name];
      }

      let allCss = '';
      for (const [name, asset] of Object.entries(bundle)) {
        if (name.endsWith('.css') && (asset as any).type === 'asset') {
          const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          source = source.replace(new RegExp(`<link[^>]*href="/?${esc}"[^>]*>`, 'g'), '');
          allCss += (asset as any).source + '\n';
          delete bundle[name];
        }
      }

      if (allCss) {
        source = source.replace('</head>', `<style>${allCss}</style>\n</head>`);
      }

      if (allJsCode) {
        const b64 = Buffer.from(allJsCode, 'utf-8').toString('base64');
        const decoder = `(function(){var b=atob("${b64}");var u=new Uint8Array(b.length);for(var i=0;i<b.length;i++)u[i]=b.charCodeAt(i);eval(new TextDecoder().decode(u))})()`;
        source = source.replace('</body>', `<script>${decoder}</script>\n</body>`);
      }

      html.source = source;

      if (htmlFile !== 'ui.html') {
        bundle['ui.html'] = { ...html, fileName: 'ui.html' };
        delete bundle[htmlFile];
      }
    },
  };
}

export default defineConfig({
  plugins: [viteSingleFile()],
  root: resolve(__dirname, 'src/ui'),
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'react',
  },
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: false,
    cssCodeSplit: false,
    rollupOptions: {
      input: resolve(__dirname, 'src/ui/index.html'),
      output: {
        format: 'iife',
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name][extname]',
        inlineDynamicImports: true,
      },
    },
    minify: true,
    cssMinify: true,
  },
});
