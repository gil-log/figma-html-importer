import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const ctx = await esbuild.context({
  entryPoints: ['src/code.ts'],
  bundle: true,
  outfile: 'dist/code.js',
  format: 'iife',
  target: 'es2017',
  platform: 'browser',
  sourcemap: false,
  minify: !watch,
  logLevel: 'info',
  supported: { arrow: false },
});

if (watch) {
  await ctx.watch();
  console.log('[esbuild] Watching code.ts...');
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
