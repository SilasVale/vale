// Details column (round-admin-ui Task 3): placeholder shell. Task 4 fills it
// with the selected command card's parameters (JSON), full output, exit code
// / reason / duration — the dsh single-call inspector.
export function DetailsPanel({ onClose }: { onClose: () => void }) {
  return (
    <>
      <div className="details-header">
        <h2 className="details-title">Details</h2>
        <button className="details-close" title="Close details" onClick={onClose}>✕</button>
      </div>
      <div className="details-body">
        <p className="details-empty">Select a command card to inspect its parameters, output, and exit code.</p>
      </div>
    </>
  );
}
