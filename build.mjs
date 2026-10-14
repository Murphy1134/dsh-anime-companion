// @ts-check
/**
 * dsh-anime-companion 双半构建脚本（tsdown Node API）。
 *
 * 产出两个产物到 lib/：
 *   1. lib/index.mjs —— Host 半，ESM，运行在 Node 端（settings 路由 / 静态资源 / TTS）。
 *   2. lib/client.js —— Client 半，**CJS 单文件**，运行在浏览器，并套上 DSH
 *      ClientModuleRegistry 的 ModuleLoader 外壳。
 *
 * 用法：
 *   node build.mjs           一次构建两半
 *   node build.mjs --watch   监听重建
 */
import { build } from 'tsdown'

const PKG_ID = 'dsh-anime-companion'
const isWatch = process.argv.includes('--watch')

/** 宿主在浏览器侧预置的平台模块：保持 external，由宿主注入的 require 解析。 */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-locale',
]

// 浏览器里没有 Node 的 url 模块；pixi 会引用 URL 等，给一个最小垫片。
const URL_SHIM_ID = '\0dsh-anime:url-shim'
const URL_SHIM_SOURCE = `
const g = globalThis;
export const URL = g.URL ?? class URL { constructor(h){ this.href = String(h); } toString(){ return this.href; } };
export const URLSearchParams = g.URLSearchParams;
export const fileURLToPath = (p) => (typeof p === 'string' ? p.replace(/^file:\/\//, '') : String(p));
export const pathToFileURL = (p) => new URL('file:///' + String(p).replace(/\\\\/g, '/'));
export const parse = (s) => { try { const u = new URL(String(s), 'file:///'); return { protocol: u.protocol, host: u.host, hostname: u.hostname, port: u.port, pathname: u.pathname, search: u.search, query: u.search.slice(1), hash: u.hash, href: u.href }; } catch { return { pathname: String(s), href: String(s) }; } };
export const format = (o) => String(o?.href ?? o?.pathname ?? '');
export const resolve = (from, to) => {
  if (!to) return String(from ?? '');
  try { return new URL(String(to)).href; } catch {}
  try { return new URL(String(to), String(from)).href; } catch {}
  const base = String(from ?? '').split('/').slice(0, -1).join('/');
  const parts = [];
  for (const seg of String(to).split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.' && seg !== '') parts.push(seg);
  }
  const joined = parts.join('/');
  return base ? base + '/' + joined : joined;
};
export default { URL, URLSearchParams, fileURLToPath, pathToFileURL, parse, format, resolve };
`

function browserNodeShim() {
  return {
    name: 'dsh-anime-browser-node-shim',
    resolveId(source) {
      if (source === 'url' || source === 'node:url') return URL_SHIM_ID
      return null
    },
    load(id) {
      if (id !== URL_SHIM_ID) return null
      return URL_SHIM_SOURCE
    },
  }
}

/** Host 半：Node ESM，@deepseek-ai/* 与 cordis 全部 external。 */
const hostConfig = {
  name: `${PKG_ID}/host`,
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2022',
  dts: false,
  clean: true,
  sourcemap: false,
  external: [/^@deepseek-ai\//, /^node:/],
  outputOptions: { entryFileNames: 'index.mjs' },
}

/** Client 半：浏览器 CJS 单文件 + ModuleLoader 外壳。 */
const clientConfig = {
  name: `${PKG_ID}/client`,
  entry: { client: 'src/client.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  dts: false,
  clean: false,
  sourcemap: false,
  treeshake: false,
  external: PLATFORM_MODULES,
  noExternal: (id) => (PLATFORM_MODULES.includes(id) ? undefined : true),
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  plugins: [
    browserNodeShim(),
    {
      name: 'dsh-anime-client-purity',
      resolveId(source) {
        if (!source.startsWith('@deepseek-ai/')) return null
        if (PLATFORM_MODULES.includes(source)) return null
        throw new Error(
          `client bundle purity: "${source}" 不是受支持的平台模块；` +
            '跨插件协作请通过 cordis 服务，不要直接 import 其它插件的运行时代码。',
        )
      },
    },
  ],
  outputOptions: {
    entryFileNames: 'client.js',
    codeSplitting: false,
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PKG_ID)}, factory: (require) => {`,
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
}

async function run() {
  await build({ ...hostConfig, watch: isWatch })
  if (isWatch) {
    await Promise.all([
      build({ ...hostConfig, watch: true }),
      build({ ...clientConfig, watch: true }),
    ])
  } else {
    await build(clientConfig)
  }
  console.log(`[build] ${PKG_ID} done → lib/index.mjs (host ESM) + lib/client.js (client CJS)`)
}

run().catch((err) => {
  console.error('[build] failed:', err)
  process.exit(1)
})
