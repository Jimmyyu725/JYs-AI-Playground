const keySummary = document.querySelector("#key-summary");

function markAvailable(id) {
  const status = document.querySelector(id);
  if (!status) return;
  status.className = "room-status live";
  status.innerHTML = "<i></i> Live table";
}

try {
  const response = await fetch("/api/health");
  if (!response.ok) throw new Error("Health check failed");
  const health = await response.json();
  const rooms = health.apiKeys ?? { holdem: health.apiKeyConfigured };
  const ready = Object.values(rooms).filter((entry) =>
    entry && typeof entry === "object" ? Object.values(entry).some(Boolean) : Boolean(entry),
  ).length;
  const total = Object.keys(rooms).length;

  if (health.games?.go) markAvailable("#go-status");
  if (health.games?.wuziqi) markAvailable("#wuziqi-status");
  if (health.games?.doudizhu) markAvailable("#doudizhu-status");
  keySummary.textContent = `${ready} of ${total} rooms have private game keys configured`;
} catch {
  keySummary.textContent = "House status unavailable";
}
