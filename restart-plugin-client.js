// DSH Restart Plugin - Client Side
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
            setMessage('Restarting via pm2...')
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
