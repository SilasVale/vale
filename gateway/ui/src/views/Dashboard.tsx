export default function Dashboard() {
  return (
    <div className="view">
      <h2>Dashboard</h2>
      <div className="cards">
        <div className="card">
          <div className="card-title">Devices</div>
          <div className="card-value">—</div>
        </div>
        <div className="card">
          <div className="card-title">Plugins</div>
          <div className="card-value">—</div>
        </div>
        <div className="card">
          <div className="card-title">Status</div>
          <div className="card-value card-ok">Online</div>
        </div>
      </div>
    </div>
  );
}
