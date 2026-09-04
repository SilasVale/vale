// pm2 app definition for vale-studio — consumed by `./scripts/build.sh studio`.
//
// NOTE: studio/package.json sets "type": "module", so this file is ESM. It
// must expose `apps` as a NAMED export: pm2 loads configs with a plain
// require(), which under ESM returns the module namespace — `module.exports`
// is silently ignored and `export default` stays wrapped behind `.default`
// (pm2 never unwraps it). `import.meta.dirname` is the ESM `__dirname`.
//
// The personal `dsh` pm2 app intentionally lives in the gitignored root
// ./ecosystem.config.js (machine-local dsh infrastructure, not Vale code).
export const apps = [{
  name: 'vale-studio',
  script: 'server.mjs',
  cwd: import.meta.dirname,
  interpreter: process.execPath,  // whatever node runs pm2 — no hardcoded paths
  autorestart: true,
  watch: false,
  max_memory_restart: '600M',
  env: {
    NODE_ENV: 'production'
  }
}]
