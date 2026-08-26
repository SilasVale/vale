// DSH Restart Plugin - Host Side
// Restart method: pm2 restart dsh
return {
  apply: function(ctx) {
    var shell = ctx.get('shell')

    function doRestart(reason) {
      console.log('[restart] Initiating restart. Reason:', reason)

      if (shell === undefined) {
        console.error('[restart] Shell service not available')
        return
      }

      try {
        var spec = shell.resolve({
          command: 'pm2 restart dsh',
          timeout: 10000
        })
        shell.run(spec).then(function(result) {
          console.log('[restart] pm2 restart output:', result.stdout || '')
        }).catch(function(e) {
          console.error('[restart] pm2 restart failed:', e)
        })
        console.log('[restart] Restart command dispatched')
      } catch (e) {
        console.error('[restart] Shell resolve failed:', e)
      }
    }

    // Register the dynamic model tool
    var tool = harness.defineTool({
      name: 'restart_dsh',
      description: 'Restart the DSH process via pm2.',
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: 'Reason for restart (optional)'
          }
        },
        additionalProperties: false
      },
      execute: async function(args) {
        var reason = (args && args.reason) ? args.reason : 'User request'
        doRestart(reason)
        return {
          success: true,
          message: 'pm2 restart dsh dispatched. DSH will restart in ~2 seconds.'
        }
      }
    })
    harness.registerTool(ctx, tool)

    // Client RPC
    harness.handle('restart-dsh', async function(args) {
      var reason = (args && args.reason) ? args.reason : 'UI'
      doRestart(reason)
      return { success: true, message: 'Restart dispatched' }
    })

    console.log('[restart] Plugin loaded. "restart_dsh" tool registered.')
  }
}
