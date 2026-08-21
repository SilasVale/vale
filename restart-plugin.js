// DSH Restart Plugin - Combined (Host + Client)
// 重启策略：先杀旧进程，再启动新实例（因为没有进程管理器）

// ===== Host Side =====
function hostPlugin() {
  return {
    apply: function(ctx) {
      var shell = ctx.get('shell')
      var subprocess = ctx.get('subprocess')

      var DSH_BIN = '/home/zhengsaisi/.nvm/versions/node/v22.22.3/bin/dsh'
      var DSH_ARGS = 'web --port 7738 --trusted-host dsh.saisi.online'

      function doRestart(reason) {
        console.log('[restart] Initiating restart. Reason:', reason)

        // 后台脚本：等响应返回 → 杀旧进程 → 启动新实例
        var restartScript = [
          'sleep 1',
          'OLD_PID=$(lsof -ti :7738 2>/dev/null)',
          'if [ -n "$OLD_PID" ]; then kill $OLD_PID 2>/dev/null; sleep 2; fi',
          'nohup ' + DSH_BIN + ' ' + DSH_ARGS + ' > /dev/null 2>&1 &',
          'echo "[restart] New DSH instance started"'
        ].join(' && ')

        if (shell !== undefined) {
          try {
            var spec = shell.resolve({
              command: 'sh -c "' + restartScript.replace(/"/g, '\\"') + '"',
              timeout: 15000
            })
            shell.run(spec).catch(function(e) {
              console.error('[restart] Shell error:', e)
            })
            console.log('[restart] Restart script dispatched')
          } catch (e) {
            console.error('[restart] Shell failed:', e)
          }
        } else if (subprocess !== undefined) {
          try {
            var handle = subprocess.spawn({
              command: 'sh',
              args: ['-c', restartScript],
              detached: true
            })
            handle.unref()
            console.log('[restart] Restart via subprocess')
          } catch (e) {
            console.error('[restart] Subprocess failed:', e)
          }
        } else {
          console.error('[restart] No shell or subprocess available')
        }
      }

      var tool = harness.defineTool({
        name: 'restart_dsh',
        description: 'Restart DSH. Kills current instance and starts a new one.',
        parameters: {
          type: 'object',
          properties: {
            reason: { type: 'string', description: 'Reason (optional)' }
          },
          additionalProperties: false
        },
        execute: async function(args) {
          var reason = (args && args.reason) ? args.reason : 'User request'
          doRestart(reason)
          return { success: true, message: 'Restart initiated (~3s).' }
        }
      })
      harness.registerTool(ctx, tool)

      harness.handle('restart-dsh', async function(args) {
        var reason = (args && args.reason) ? args.reason : 'UI'
        doRestart(reason)
        return { success: true, message: 'Restart initiated' }
      })

      console.log('[restart] Plugin loaded. "restart_dsh" tool registered.')
    }
  }
}

// ===== Client Side =====
function clientPlugin() {
  return {
    apply: function(ctx) {
      var slots = ctx.get('slots')
      if (slots === undefined) return

      slots.inject('tool.view.cordis', function() {
        return slots.register(
          { name: 'tool.view.cordis', key: 'restart-btn' },
          function(props) {
            var useState = React.useState
            var s = useState('idle')
            var status = s[0]
            var setStatus = s[1]
            var m = useState('')
            var message = m[0]
            var setMessage = m[1]

            var handleClick = async function() {
              setStatus('restarting')
              setMessage('Starting new DSH instance...')
              try {
                var result = await host.call('restart-dsh', { reason: 'UI button' })
                if (result && result.success) {
                  setStatus('success')
                  setMessage(result.message || 'Done!')
                } else {
                  setStatus('error')
                  setMessage('Failed')
                }
              } catch (e) {
                setStatus('error')
                setMessage('Error: ' + (e.message || String(e)))
              }
            }

            return React.createElement('div', {
              style: { padding: '12px', borderTop: '1px solid var(--border, #e0e0e0)' }
            },
              React.createElement('button', {
                onClick: handleClick,
                disabled: status === 'restarting',
                style: {
                  padding: '8px 16px',
                  borderRadius: '6px',
                  border: '1px solid #dc3545',
                  background: status === 'restarting' ? '#6c757d' : '#dc3545',
                  color: '#fff',
                  cursor: status === 'restarting' ? 'not-allowed' : 'pointer',
                  fontSize: '13px',
                  fontWeight: '500'
                }
              }, status === 'restarting' ? 'Restarting...' : 'Restart DSH'),
              message ? React.createElement('p', {
                style: {
                  margin: '8px 0 0',
                  fontSize: '12px',
                  color: status === 'error' ? '#dc3545' :
                         status === 'success' ? '#28a745' : '#6c757d'
                }
              }, message) : null
            )
          }
        )
      })
    }
  }
}

module.exports = { hostPlugin, clientPlugin }
